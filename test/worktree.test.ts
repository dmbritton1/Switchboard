import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignLanes, commitGraph, createWorktree, worktreeStatus } from '../src/worktree.ts';

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

test('createWorktree makes a branch at the app-standard path', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const wt = await createWorktree(repo, 'feat/x');

  assert.equal(wt, join(repo, '.claude', 'worktrees', 'feat-x'));
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd: wt });
  assert.equal(stdout.trim(), 'feat/x');
});

test('createWorktree rejects a branch that already exists', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  await createWorktree(repo, 'dup');
  await assert.rejects(() => createWorktree(repo, 'dup'), /already exists/i);
});

test('createWorktree rejects a path that is not a git repo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => createWorktree(dir, 'x'), /not a git repository/i);
});

test('worktreeStatus reports clean, then dirty with line counts', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/y');

  const clean = await worktreeStatus(wt);
  assert.deepEqual(clean, { branch: 'feat/y', added: 0, removed: 0, dirty: false });

  await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n');
  const dirty = await worktreeStatus(wt);
  assert.equal(dirty.branch, 'feat/y');
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.added, 1);
  assert.equal(dirty.removed, 0);
});

test('worktreeStatus counts untracked files, which git diff cannot see', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/new');

  // Most first prompts tell the agent to *create* files. `git diff HEAD --numstat`
  // ignores untracked ones, so the card used to read `+0 −0 · dirty`.
  await writeFile(join(wt, 'new.txt'), 'a\nb\nc\n');
  await writeFile(join(wt, 'no-newline.txt'), 'x\ny');   // trailing line still counts
  await writeFile(join(wt, 'bin.dat'), Buffer.from([1, 0, 2, 0]));  // binary: skipped
  await writeFile(join(wt, 'empty.txt'), '');

  const s = await worktreeStatus(wt);
  assert.equal(s.dirty, true);
  assert.equal(s.added, 5, '3 lines + 2 lines, binary and empty files contribute none');
  assert.equal(s.removed, 0);
});

test('assignLanes reuses a lane once a branch has merged back', () => {
  //   D   merge of B and C
  //   |\
  //   B C
  //   |/
  //   A
  const laid = assignLanes([
    { h: 'D', p: ['B', 'C'] },
    { h: 'B', p: ['A'] },
    { h: 'C', p: ['A'] },
    { h: 'A', p: [] },
  ]);
  assert.deepEqual(
    Object.fromEntries(laid.map((c) => [c.h, c.lane])),
    { D: 0, B: 0, C: 1, A: 0 },
  );

  // A closed branch must free its column, or every later commit is pushed right.
  const after = assignLanes([{ h: 'B', p: ['A'] }, { h: 'A', p: [] }, { h: 'Z', p: [] }]);
  assert.deepEqual(after.map((c) => c.lane), [0, 0, 0]);
});

test('commitGraph reports refs and parents for a real merge', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await run('git', ['checkout', '-b', 'side'], { cwd: repo });
  await writeFile(join(repo, 'b.txt'), 'b\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-m', 'side work'], { cwd: repo });
  await run('git', ['checkout', 'main'], { cwd: repo });
  await run('git', ['merge', '--no-ff', 'side', '-m', 'merge side'], { cwd: repo });

  const graph = await commitGraph(repo);

  assert.equal(graph[0].subject, 'merge side');
  assert.equal(graph[0].p.length, 2, 'merge commit keeps both parents');
  assert.ok(graph[0].refs.includes('HEAD -> main'));
  assert.ok(graph.some((c) => c.refs.includes('side')));
  assert.deepEqual(graph.map((c) => c.row), [0, 1, 2]);
});
