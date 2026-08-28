import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Linker, type SpawnLogin } from '../src/link.ts';
import { DEFAULT_BUDGET, type Account } from '../src/accounts.ts';
import { writeFakeLoginCli } from './helpers/fake-login.ts';

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
