import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
