import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignLanes, changedPaths, commitGraph, createWorktree, worktreeDiff, worktreeStatus } from '../src/worktree.ts';

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

// Starts from now so every commit here is dated after makeRepo's `init`.
let testClock = Math.floor(Date.now() / 1000);
async function commitAt(cwd: string, msg: string): Promise<void> {
  testClock += 60;
  const d = `${testClock} +0000`;
  await writeFile(join(cwd, `f${testClock}.txt`), msg);
  await run('git', ['add', '.'], { cwd });
  await run('git', ['commit', '-m', msg], {
    cwd, env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d },
  });
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

test('createWorktree branches from a given start point instead of repo HEAD', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const first = await createWorktree(repo, 'feat/first');
  await writeFile(join(first, 'only-on-first.txt'), 'source work\n');
  await run('git', ['add', '.'], { cwd: first });
  await run('git', ['commit', '-m', 'work on first'], { cwd: first });

  const second = await createWorktree(repo, 'feat/second', 'feat/first');

  assert.equal(
    await readFile(join(second, 'only-on-first.txt'), 'utf8'), 'source work\n',
    'the new worktree should carry the start-point branch\'s commits',
  );
  // Exits non-zero when it is not an ancestor, which rejects and fails the test.
  await run('git', ['merge-base', '--is-ancestor', 'feat/first', 'feat/second'], { cwd: repo });
});

test('createWorktree still branches from repo HEAD when no start point is given', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const first = await createWorktree(repo, 'feat/a');
  await writeFile(join(first, 'only-on-a.txt'), 'x\n');
  await run('git', ['add', '.'], { cwd: first });
  await run('git', ['commit', '-m', 'work on a'], { cwd: first });

  const second = await createWorktree(repo, 'feat/b');

  await assert.rejects(
    access(join(second, 'only-on-a.txt')),
    'omitting the start point must keep branching from HEAD, not from the last worktree',
  );
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

test('worktreeStatus ignores uploads/, which is conversation input, not work', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/up');

  await mkdir(join(wt, 'uploads'), { recursive: true });
  await writeFile(join(wt, 'uploads', 'paste-1-image.png'), 'a\nb\nc\n');

  assert.deepEqual(await worktreeStatus(wt), { branch: 'feat/up', added: 0, removed: 0, dirty: false });
});

test('worktreeStatus ignores a pasted upload, which is conversation input, not work', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/pasted');

  // The name writeContainedUpload actually produces (src/upload.ts): a direct
  // child of the worktree root, not the `uploads/` directory /upload stopped
  // using. Counting a screenshot as +N added lines made the card's only
  // progress indicator report work nobody did.
  await writeFile(
    join(wt, '.switchboard-upload-0123456789abcdef0123456789abcdef-shot.png'), 'a\nb\nc\n',
  );

  assert.deepEqual(await worktreeStatus(wt), { branch: 'feat/pasted', added: 0, removed: 0, dirty: false });
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

test('commitGraph keeps a stale branch that trunk history would starve out', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  // A branch forked early and then left alone, then trunk marches past the limit.
  const wt = await createWorktree(repo, 'stale');
  await commitAt(wt, 'stale work');
  for (let i = 0; i < 10; i++) await commitAt(repo, `main ${i}`);

  const graph = await commitGraph(wt, repo, 5);

  // The whole bug: with one global budget this branch vanished, ref and all.
  assert.ok(graph.some((c) => c.refs.includes('HEAD -> stale')), 'stale branch survives the limit');
  assert.equal(graph.find((c) => c.subject === 'stale work')?.tier, 'own');
  assert.ok(graph.some((c) => c.tier === 'trunk'), 'trunk history is still included');
});

test('commitGraph returns commits in topological order across the two calls', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'side');
  await commitAt(wt, 'side work');
  for (let i = 0; i < 4; i++) await commitAt(repo, `main ${i}`);

  const graph = await commitGraph(wt, repo, 50);

  // assignLanes depends on this, so the concatenation must preserve it:
  // every parent present in the window appears after its child.
  const idx = new Map(graph.map((c, i) => [c.h, i]));
  for (const [i, c] of graph.entries()) {
    for (const ph of c.p) {
      if (idx.has(ph)) assert.ok(idx.get(ph)! > i, `parent ${ph} must follow child ${c.h}`);
    }
  }
});

test('commitGraph tiers another session branch as other', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const mine = await createWorktree(repo, 'mine');
  const theirs = await createWorktree(repo, 'theirs');
  await commitAt(mine, 'my work');
  await commitAt(theirs, 'their work');

  const graph = await commitGraph(mine, repo, 50);

  assert.equal(graph.find((c) => c.subject === 'my work')?.tier, 'own');
  assert.equal(graph.find((c) => c.subject === 'their work')?.tier, 'other');
  assert.equal(graph.find((c) => c.subject === 'init')?.tier, 'trunk');
});

test('commitGraph survives a branch name that is also a path', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  // A bare branch name is ambiguous when a same-named path exists at repo
  // root: `git log docs` is `fatal: ambiguous argument 'docs'` rather than a
  // revision. This repo layout has top-level docs/, src/, web/, test/, scripts/.
  await run('git', ['checkout', '-b', 'docs'], { cwd: repo });
  await mkdir(join(repo, 'docs'));
  await writeFile(join(repo, 'docs', 'note.txt'), 'hi\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-m', 'add docs dir'], { cwd: repo });

  const graph = await commitGraph(repo, repo, 50);

  assert.ok(graph.length >= 2, 'commits come back instead of the ambiguous-argument rejection being swallowed');
});

test('commitGraph falls back when trunk is an unborn branch', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await commitAt(repo, 'second');
  // An orphan branch has no commit yet, so `refs/heads/fresh` does not resolve
  // — the same shape as detached HEAD: no trunk to split the budget on.
  await run('git', ['checkout', '--orphan', 'fresh'], { cwd: repo });

  const graph = await commitGraph(repo, repo, 50);

  assert.ok(graph.length >= 2, 'still returns the existing commits rather than throwing');
});

test('commitGraph falls back to a single walk when the base repo is detached', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  await commitAt(repo, 'second');
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  await run('git', ['checkout', '--detach', stdout.trim()], { cwd: repo });

  const graph = await commitGraph(repo, repo, 50);

  assert.ok(graph.length >= 2, 'still returns commits rather than throwing');
  assert.ok(graph.every((c) => c.tier === 'other'), 'no trunk to split on, so nothing is tiered');
});

test('worktreeDiff reports modified, untracked and binary files, and skips uploads/', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');       // tracked, +1
  await writeFile(join(repo, 'new.txt'), 'alpha\nbeta\n');          // untracked, +2
  await writeFile(join(repo, 'blob.bin'), Buffer.from([1, 0, 2]));  // untracked, binary
  await mkdir(join(repo, 'uploads'), { recursive: true });
  await writeFile(join(repo, 'uploads', 'shot.png'), 'pretend png\n');

  const files = await worktreeDiff(repo);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'blob.bin', 'new.txt']);

  assert.equal(by['a.txt'].added, 1);
  assert.equal(by['a.txt'].removed, 0);
  assert.match(by['a.txt'].patch, /^@@ /m);
  assert.match(by['a.txt'].patch, /^\+three$/m);
  // The `diff --git` line and the index/---/+++ noise are stripped: the summary
  // in the pane already names the file.
  assert.doesNotMatch(by['a.txt'].patch, /diff --git|^index |^\+\+\+ |^--- /m);

  // Untracked files are invisible to `git diff HEAD`, so they are synthesized.
  assert.equal(by['new.txt'].added, 2);
  assert.equal(by['new.txt'].removed, 0);
  assert.equal(by['new.txt'].patch, '@@ -0,0 +1,2 @@\n+alpha\n+beta');

  assert.equal(by['blob.bin'].binary, true);
  assert.equal(by['blob.bin'].patch, '');
  assert.equal(by['blob.bin'].added, 0);
});

// The pane's per-file numbers sit inches from the sidebar's totals. If the two
// ever disagree it reads as a bug, so they are held to the same range here.
test('worktreeDiff sums to the same totals worktreeStatus reports', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  await writeFile(join(repo, 'a.txt'), 'two\n');            // -1 line, +0
  await writeFile(join(repo, 'new.txt'), 'x\ny\nz\n');      // +3

  // A *tracked* file under uploads/: an agent that `git add -A`'d the tree can
  // commit one, and worktreeStatus()'s numstat call had no pathspec excluding
  // uploads/ while its porcelain call and worktreeDiff (both pathspec'd) did —
  // this file's edit would count here but be invisible to worktreeDiff, so the
  // two totals split instead of matching.
  await mkdir(join(repo, 'uploads'), { recursive: true });
  await writeFile(join(repo, 'uploads', 'tracked.txt'), 'one\n');
  await run('git', ['add', 'uploads/tracked.txt'], { cwd: repo });
  await run('git', ['commit', '-m', 'track an upload'], { cwd: repo });
  await writeFile(join(repo, 'uploads', 'tracked.txt'), 'one\ntwo\n'); // +1, excluded from both totals

  const [files, status] = await Promise.all([worktreeDiff(repo), worktreeStatus(repo)]);
  const sum = (k: 'added' | 'removed') => files.reduce((n, f) => n + f[k], 0);

  assert.equal(sum('added'), status.added);
  assert.equal(sum('removed'), status.removed);
});

test('worktreeDiff carries the old path through a rename', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  await run('git', ['mv', 'a.txt', 'b.txt'], { cwd: repo });

  const files = await worktreeDiff(repo);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'b.txt');
  assert.equal(files[0].old, 'a.txt');
});

test('worktreeDiff caps a huge patch body and says so', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
  await writeFile(join(repo, 'gen.txt'), `${big}\n`);

  const [file] = await worktreeDiff(repo);
  assert.equal(file.truncated, true);
  assert.equal(file.patch.split('\n').length, 2000);
  assert.equal(file.added, 2500, 'the counts stay honest even when the body is cut');
});

test('worktreeDiff on a clean worktree is an empty list, not a throw', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));

  assert.deepEqual(await worktreeDiff(repo), []);
});

test('changedPaths unions committed and uncommitted work', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/paths');

  await writeFile(join(wt, 'committed.txt'), 'done\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'a commit'], { cwd: wt });
  await writeFile(join(wt, 'dirty.txt'), 'in progress\n');
  await writeFile(join(wt, 'a.txt'), 'modified\n');

  assert.deepEqual(
    await changedPaths(wt, 'main'),
    ['a.txt', 'committed.txt', 'dirty.txt'],
  );
});

test('changedPaths excludes conversation inputs', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/inputs');

  await writeFile(join(wt, 'real.txt'), 'work\n');
  // The name writeContainedUpload actually produces (src/upload.ts) — without
  // the exclusion every session that ever had a screenshot pasted into it would
  // register as overlapping with every other one.
  await writeFile(join(wt, '.switchboard-upload-0123456789abcdef0123456789abcdef-shot.png'), 'png\n');
  await mkdir(join(wt, '.switchboard'), { recursive: true });
  await writeFile(join(wt, '.switchboard', 'handoff.md'), '# Handoff\n');

  assert.deepEqual(await changedPaths(wt, 'main'), ['real.txt']);
});

test('changedPaths skips the committed half when there is no base branch', async (t) => {
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const wt = await createWorktree(repo, 'feat/detached');

  await writeFile(join(wt, 'committed.txt'), 'done\n');
  await run('git', ['add', '.'], { cwd: wt });
  await run('git', ['commit', '-m', 'a commit'], { cwd: wt });
  await writeFile(join(wt, 'dirty.txt'), 'in progress\n');

  // A detached base repo yields '' from currentBranch. Degrade to the
  // uncommitted half rather than failing the whole status response.
  assert.deepEqual(await changedPaths(wt, ''), ['dirty.txt']);
});
