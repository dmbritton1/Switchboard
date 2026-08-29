import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Linker, type SpawnLogin } from '../src/link.ts';
import { DEFAULT_BUDGET, type Account } from '../src/accounts.ts';
import { writeFakeLoginCli } from './helpers/fake-login.ts';

/** A controllable stand-in for a spawned child process: a real ChildProcess's
 *  'close' timing can't be forced, which is exactly the timing this exercises
 *  (a stale close arriving after the link that owned it has been replaced).
 *  Only the surface Linker touches is implemented. */
function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  (stdout as unknown as { setEncoding: () => void }).setEncoding = () => {};
  (stderr as unknown as { setEncoding: () => void }).setEncoding = () => {};
  Object.assign(child, {
    stdout, stderr, stdin: { write: () => {} }, kill: () => true,
  });
  return child;
}

async function harness(options: {
  provider?: 'claude' | 'codex';
  mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow';
  email?: string | null;
  urlTimeoutMs?: number;
  overallTimeoutMs?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-link-'));
  const provider = options.provider ?? 'claude';
  const bin = await writeFakeLoginCli(dir, { provider, mode: options.mode, email: options.email });
  const spawnLogin: SpawnLogin = (_p, env) =>
    spawn(bin, provider === 'claude' ? ['auth', 'login'] : ['login'], {
      env: { ...process.env, ...env },
    });
  const accounts: Account[] = [];
  const linker = new Linker({
    accountsRoot: join(dir, 'accounts'),
    accounts: () => accounts,
    spawnLogin,
    claudeBin: bin,
    urlTimeoutMs: options.urlTimeoutMs ?? 5000,
    overallTimeoutMs: options.overallTimeoutMs ?? 10_000,
  });
  return { dir, linker, accounts, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Resolves when the snapshot satisfies `predicate`, or rejects after 5s. */
function until(linker: Linker, predicate: (link: ReturnType<Linker['snapshot']>) => boolean) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!predicate(linker.snapshot())) return false;
      unsub(); clearTimeout(timer); resolve(); return true;
    };
    const timer = setTimeout(() => { unsub(); reject(new Error('timed out waiting for phase')); }, 5000);
    const unsub = linker.subscribe(() => { check(); });
    check();
  });
}

test('a claude link reaches awaiting-user with the URL from stdout', async () => {
  const h = await harness({ provider: 'claude' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const link = h.linker.snapshot();
  assert.equal(link?.provider, 'claude');
  assert.match(link?.url ?? '', /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  await h.linker.cancel();
  await h.cleanup();
});

test('a codex link reaches awaiting-user with the URL from stderr', async () => {
  const h = await harness({ provider: 'codex' });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'awaiting-user' || l?.phase === 'verifying');
  assert.match(h.linker.snapshot()?.url ?? '', /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  await h.linker.cancel();
  await h.cleanup();
});

test('a decoy URL on an unexpected host is ignored', async () => {
  const h = await harness({ mode: 'no-url', urlTimeoutMs: 700 });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'error');
  assert.equal(h.linker.snapshot()?.url, null);
  assert.match(h.linker.snapshot()?.error ?? '', /did not print a sign-in URL/);
  await h.cleanup();
});

test('starting a second link while one is pending is refused', async () => {
  const h = await harness();
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const second = await h.linker.start('claude');
  assert.match(second.error ?? '', /already in progress/);
  await h.linker.cancel();
  await h.cleanup();
});

test('cancel kills the child, clears the snapshot and removes staging', async () => {
  const h = await harness();
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  await h.linker.cancel();
  assert.equal(h.linker.snapshot(), null);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(h.dir, 'accounts')).catch(() => []), []);
  await h.cleanup();
});

test('claude requests a code, discovered from the CLI\'s own output', async () => {
  const h = await harness({ provider: 'claude', mode: 'ok' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  assert.equal(h.linker.snapshot()?.codeRequested, true);
  await h.linker.cancel();
  await h.cleanup();
});

test('subscribers are notified on every phase change and stop after unsubscribe', async () => {
  const h = await harness();
  let calls = 0;
  const unsub = h.linker.subscribe(() => { calls += 1; });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  assert.ok(calls >= 2, `expected >= 2 notifications, got ${calls}`);
  unsub();
  const before = calls;
  await h.linker.cancel();
  assert.equal(calls, before);
  await h.cleanup();
});

test('pasting a code completes a claude link and proposes a name', async () => {
  const h = await harness({ provider: 'claude', email: 'dwight@example.com' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  assert.equal(h.linker.submitCode('good-code').error, undefined);
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity?.email, 'dwight@example.com');
  assert.equal(link?.suggestedName, 'claude-dwight');
  await h.linker.cancel();
  await h.cleanup();
});

test('a CLI that never prompts goes straight to naming', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  assert.equal(h.linker.snapshot()?.codeRequested, false);
  await h.linker.cancel();
  await h.cleanup();
});

test('a codex link decodes the email out of the id_token', async () => {
  const h = await harness({ provider: 'codex', email: 'dwight@example.com' });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity?.email, 'dwight@example.com');
  assert.equal(link?.identity?.subscription, null);
  assert.equal(link?.suggestedName, 'codex-dwight');
  await h.linker.cancel();
  await h.cleanup();
});

test('an auth.json with no id_token still links, with a bare provider name', async () => {
  const h = await harness({ provider: 'codex', email: null });
  await h.linker.start('codex');
  await until(h.linker, (l) => l?.phase === 'naming');
  const link = h.linker.snapshot();
  assert.equal(link?.identity, null);
  assert.equal(link?.suggestedName, 'codex');
  await h.linker.cancel();
  await h.cleanup();
});

test('a bad code fails the link and leaves no staging directory', async () => {
  const h = await harness({ provider: 'claude', mode: 'bad-code' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  h.linker.submitCode('wrong');
  await until(h.linker, (l) => l?.phase === 'error');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(h.dir, 'accounts')).catch(() => []), []);
  await h.cleanup();
});

test('submitCode is refused before the CLI has asked for one', async () => {
  const h = await harness({ provider: 'codex' });
  assert.match(h.linker.submitCode('x').error ?? '', /not waiting for a code/);
  await h.cleanup();
});

test('the submitted code never appears in the snapshot', async () => {
  const h = await harness({ provider: 'claude', mode: 'bad-code' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  h.linker.submitCode('sentinel-secret-code');
  await until(h.linker, (l) => l?.phase === 'error');
  assert.ok(!JSON.stringify(h.linker.snapshot()).includes('sentinel-secret-code'));
  await h.cleanup();
});

test('linking an identity that is already linked fails and leaves no staging directory', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt', email: 'dwight@example.com' });
  h.accounts.push({
    name: 'existing-claude',
    provider: 'claude',
    budget: DEFAULT_BUDGET,
    env: {},
    identity: 'dwight@example.com',
  });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'error');
  const link = h.linker.snapshot();
  assert.match(link?.error ?? '', /already linked as/);
  assert.ok(link?.error?.includes('existing-claude'));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(h.dir, 'accounts')).catch(() => []), []);
  await h.cleanup();
});

test('linking a different identity than an existing account still reaches naming', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt', email: 'dwight@example.com' });
  h.accounts.push({
    name: 'someone-else',
    provider: 'claude',
    budget: DEFAULT_BUDGET,
    env: {},
    identity: 'other@example.com',
  });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  assert.equal(h.linker.snapshot()?.identity?.email, 'dwight@example.com');
  await h.linker.cancel();
  await h.cleanup();
});

test('commit renames staging into the accounts root and returns the entry', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt', email: 'dwight@example.com' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  const { account, error } = await h.linker.commit('claude-dwight');
  assert.equal(error, undefined);
  assert.equal(account?.name, 'claude-dwight');
  assert.equal(account?.provider, 'claude');
  assert.equal(account?.budget, 2_000_000);
  assert.equal(account?.identity, 'dwight@example.com');
  assert.equal(account?.env.CLAUDE_CONFIG_DIR, join(h.dir, 'accounts', 'claude-dwight'));
  const { readFile } = await import('node:fs/promises');
  assert.ok(await readFile(join(h.dir, 'accounts', 'claude-dwight', '.claude.json'), 'utf8'));
  assert.equal(h.linker.snapshot(), null);
  await h.cleanup();
});

test('commit rejects a name that could escape the accounts root', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  for (const bad of ['../evil', 'a/b', '', 'UPPER']) {
    const { error } = await h.linker.commit(bad);
    assert.equal(typeof error, 'string', `expected ${bad} rejected`);
  }
  assert.equal(h.linker.snapshot()?.phase, 'naming');
  await h.linker.cancel();
  await h.cleanup();
});

test('commit rejects a name already taken', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  h.accounts.push({ name: 'taken', provider: 'claude', budget: 1, env: {} });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  const { error } = await h.linker.commit('taken');
  assert.match(error ?? '', /already exists/);
  await h.linker.cancel();
  await h.cleanup();
});

test('commit is refused before the link reaches naming', async () => {
  const h = await harness({ provider: 'claude' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const { error } = await h.linker.commit('claude-x');
  assert.match(error ?? '', /not ready/);
  await h.linker.cancel();
  await h.cleanup();
});

test('sweep removes leftover staging dirs and nothing else', async () => {
  const h = await harness();
  const { mkdir, readdir } = await import('node:fs/promises');
  const root = join(h.dir, 'accounts');
  await mkdir(join(root, '.pending-abandoned'), { recursive: true });
  await mkdir(join(root, 'claude-keep'), { recursive: true });
  await h.linker.sweep();
  assert.deepEqual((await readdir(root)).sort(), ['claude-keep']);
  await h.cleanup();
});

test('sweep leaves an in-progress link\'s own staging directory alone', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'awaiting-user');
  const staging = h.linker.stagingDir();
  assert.ok(staging);
  await h.linker.sweep();
  const { readdir } = await import('node:fs/promises');
  const root = join(h.dir, 'accounts');
  assert.ok((await readdir(root)).some((entry) => join(root, entry) === staging));
  await until(h.linker, (l) => l?.phase === 'naming');
  await h.linker.cancel();
  await h.cleanup();
});

test('sweep resolves without throwing when the accounts root does not exist', async () => {
  const h = await harness();
  await assert.doesNotReject(() => h.linker.sweep());
  await h.cleanup();
});

// C2: #fail deliberately leaves #pending set (in the 'error' phase) so the
// error can be rendered. start() used to refuse whenever #pending was
// non-null at all, which permanently locked out linking after the first
// failure — nothing else ever clears it. A settled pending must not block a
// fresh start().
test('a new link can start after a failed one, without cancelling first', async () => {
  const h = await harness({ provider: 'claude', mode: 'bad-code' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.codeRequested === true);
  h.linker.submitCode('wrong');
  await until(h.linker, (l) => l?.phase === 'error');

  const { error } = await h.linker.start('claude');
  assert.equal(error, undefined);
  await until(h.linker, (l) => l?.codeRequested === true);
  assert.equal(h.linker.snapshot()?.phase, 'awaiting-user');
  await h.linker.cancel();
  await h.cleanup();
});

// I1: a stale 'close' from a cancelled child must not touch whatever link
// replaced it. Uses fake, hand-controlled children rather than real
// processes so the race (a late event arriving strictly after cancel() +
// a second start()) is deterministic instead of dependent on OS signal
// timing.
test('a stale close event from a cancelled link does not affect the next link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-link-'));
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnLogin: SpawnLogin = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const linker = new Linker({ accountsRoot: join(dir, 'accounts'), accounts: () => [], spawnLogin });

  await linker.start('claude');
  const first = children[0];
  await linker.cancel();
  await linker.start('claude');
  assert.equal(linker.snapshot()?.phase, 'starting');

  // The first (cancelled) child's close event arrives late, after the second
  // link has already replaced it in #pending.
  first.emit('close', null);
  // The buggy path is async (#fail awaits an rm()); give it a window to run
  // to completion before asserting nothing changed.
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  assert.equal(linker.snapshot()?.phase, 'starting', 'the second link must be untouched');
  assert.equal(linker.snapshot()?.error, null);

  await linker.cancel();
  await rm(dir, { recursive: true, force: true });
});

// I2 regression guard: Promise.all([commit(x), commit(x)]) races both calls
// onto the same `p`, so the second rename() always throws (source already
// moved by the first). Before I2 the catch redacted only `p.staging`, so the
// (still raw) destination path — the exact directory about to become the
// account's CLAUDE_CONFIG_DIR — leaked into the error text.
test('commit\'s double-submit race does not leak the destination credential path', async () => {
  const h = await harness({ provider: 'claude', mode: 'no-prompt', email: 'dwight@example.com' });
  await h.linker.start('claude');
  await until(h.linker, (l) => l?.phase === 'naming');
  const target = join(h.dir, 'accounts', 'race-name');

  const [a, b] = await Promise.all([h.linker.commit('race-name'), h.linker.commit('race-name')]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.account).length, 1, 'exactly one commit should succeed');
  const failed = results.find((r) => r.error);
  assert.ok(failed, 'exactly one commit should fail');
  assert.ok(
    !failed!.error!.includes(target) && !failed!.error!.includes(h.dir),
    `error leaked a credential path: ${failed!.error}`,
  );
  await h.cleanup();
});
