import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, worktreeStatus } from '../src/worktree.ts';

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
