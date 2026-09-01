import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from '../src/worktree.ts';
import { commitOutstanding, mergeWorktrees, pushRepo } from '../src/merge.ts';

const run = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('mergeWorktrees merges a clean branch into the repo\'s checked-out branch', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/x');
  await writeFile(join(wt, 'b.txt'), 'new file\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'add b'], { cwd: wt });

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/x' }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.merged, ['feat/x']);
  assert.equal(result.ok && result.target, 'main');
  assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'new file\n');
});

test('mergeWorktrees commits outstanding changes in the worktree before merging', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/dirty');
  // Never committed in the worktree — this is the "resolve outstanding git
  // stuff" half of the feature: a dirty worktree should still be mergeable.
  await writeFile(join(wt, 'c.txt'), 'uncommitted\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/dirty' }]);

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(repo, 'c.txt'), 'utf8'), 'uncommitted\n');
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: wt });
  assert.equal(stdout.trim(), '', 'the worktree itself should be clean after the auto-commit');
});

test('mergeWorktrees leaves uploads/ out of the commit and out of the merge target', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/shots');
  await writeFile(join(wt, 'd.txt'), 'real work\n');
  await mkdir(join(wt, 'uploads'), { recursive: true });
  await writeFile(join(wt, 'uploads', 'paste-1-image.png'), 'bytes\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/shots' }]);

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(repo, 'd.txt'), 'utf8'), 'real work\n');
  await assert.rejects(access(join(repo, 'uploads', 'paste-1-image.png')),
    'a pasted screenshot must not land in the merge target');
  // Still readable by the agent in its own worktree — excluded from the commit,
  // not deleted.
  await access(join(wt, 'uploads', 'paste-1-image.png'));
});

test('mergeWorktrees merges a worktree whose only change is an upload', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/only-shots');
  await run('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: wt });
  await mkdir(join(wt, 'uploads'), { recursive: true });
  await writeFile(join(wt, 'uploads', 'paste-2-image.png'), 'bytes\n');

  // Without uploads/ excluded from isDirty too, this asks git to commit and
  // gets "nothing to commit" back, failing the whole merge.
  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/only-shots' }]);

  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('mergeWorktrees merges multiple branches in order', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt1 = await createWorktree(repo, 'feat/one');
  await writeFile(join(wt1, 'one.txt'), '1\n');
  await run('git', ['add', '.'], { cwd: wt1 });
  await run('git', ['commit', '-m', 'one'], { cwd: wt1 });
  const wt2 = await createWorktree(repo, 'feat/two');
  await writeFile(join(wt2, 'two.txt'), '2\n');
  await run('git', ['add', '.'], { cwd: wt2 });
  await run('git', ['commit', '-m', 'two'], { cwd: wt2 });

  const result = await mergeWorktrees(repo, [
    { cwd: wt1, branch: 'feat/one' },
    { cwd: wt2, branch: 'feat/two' },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.merged, ['feat/one', 'feat/two']);
  assert.equal(await readFile(join(repo, 'one.txt'), 'utf8'), '1\n');
  assert.equal(await readFile(join(repo, 'two.txt'), 'utf8'), '2\n');
});

test('mergeWorktrees refuses to merge into a repo that has its own uncommitted changes', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/x');
  await writeFile(join(repo, 'a.txt'), 'changed on main, never committed\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/x' }]);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /uncommitted changes/i);
});

test('mergeWorktrees aborts cleanly on conflict and reports it', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/conflict');
  await writeFile(join(wt, 'a.txt'), 'conflicting change\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'conflict'], { cwd: wt });
  // Diverge main's own copy of a.txt so the merge actually conflicts.
  await writeFile(join(repo, 'a.txt'), 'different change on main\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-m', 'diverge'], { cwd: repo });

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/conflict' }]);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /conflicted/i);
  assert.deepEqual(result.merged, []);
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: repo });
  assert.equal(stdout.trim(), '', 'a failed merge must leave the repo clean, not mid-conflict');
});

test('mergeWorktrees stops at the first conflicting branch and reports what already merged', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt1 = await createWorktree(repo, 'feat/ok');
  await writeFile(join(wt1, 'ok.txt'), 'fine\n');
  await run('git', ['add', '.'], { cwd: wt1 });
  await run('git', ['commit', '-m', 'ok'], { cwd: wt1 });

  const wt2 = await createWorktree(repo, 'feat/bad');
  await writeFile(join(wt2, 'a.txt'), 'conflicting\n');
  await run('git', ['add', '.'], { cwd: wt2 });
  await run('git', ['commit', '-m', 'bad'], { cwd: wt2 });
  await writeFile(join(repo, 'a.txt'), 'diverged\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-m', 'diverge'], { cwd: repo });

  const result = await mergeWorktrees(repo, [
    { cwd: wt1, branch: 'feat/ok' },
    { cwd: wt2, branch: 'feat/bad' },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.merged, ['feat/ok'], 'the branch that merged cleanly should stay merged');
  assert.equal(await readFile(join(repo, 'ok.txt'), 'utf8'), 'fine\n');
});

test('mergeWorktrees leaves .switchboard/ out of the commit and out of the merge target', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/handed');
  await writeFile(join(wt, 'e.txt'), 'real work\n');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/handed' }]);

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(repo, 'e.txt'), 'utf8'), 'real work\n');
  await assert.rejects(access(join(repo, '.switchboard', 'handoff.md')));
});

test('commitOutstanding commits nothing when only a handoff file is present', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/only-handoff');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');
  const before = await run('git', ['rev-parse', 'HEAD'], { cwd: wt });

  await commitOutstanding(wt, 'feat/only-handoff');

  const after = await run('git', ['rev-parse', 'HEAD'], { cwd: wt });
  assert.equal(after.stdout.trim(), before.stdout.trim(), 'no commit should have been made');
});

test('pushRepo pushes the checked-out branch to origin', async (t) => {
  const remote = await mkdtemp(join(tmpdir(), 'sb-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run('git', ['init', '--bare', '-b', 'main'], { cwd: remote });

  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await run('git', ['remote', 'add', 'origin', remote], { cwd: repo });

  const result = await pushRepo(repo);

  assert.equal(result.ok, true);
  // `cwd: remote` would fail here: git refuses to run inside a bare repo via
  // plain cwd discovery (safe.bareRepository) unless told explicitly.
  const { stdout } = await run('git', ['--git-dir=' + remote, 'log', '-1', '--format=%s']);
  assert.equal(stdout.trim(), 'init');
});

test('pushRepo reports a clear error when no remote is configured', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const result = await pushRepo(repo);

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /origin/i);
});

test('mergeWorktrees leaves a pasted upload out of the commit and out of the merge target', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/pasted');
  await writeFile(join(wt, 'f.txt'), 'real work\n');
  // The name writeContainedUpload actually produces (src/upload.ts) — a direct
  // child of the worktree root, not the `uploads/` directory the old pathspec
  // named and that /upload stopped using.
  const upload = '.switchboard-upload-0123456789abcdef0123456789abcdef-shot.png';
  await writeFile(join(wt, upload), 'pretend png\n');

  const result = await mergeWorktrees(repo, [{ cwd: wt, branch: 'feat/pasted' }]);

  assert.equal(result.ok, true);
  assert.equal(await readFile(join(repo, 'f.txt'), 'utf8'), 'real work\n');
  await assert.rejects(access(join(repo, upload)), 'a pasted upload must not reach the merge target');
  await access(join(wt, upload));
});
