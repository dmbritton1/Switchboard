import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Linker, type SpawnLogin } from '../src/link.ts';
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
  const linker = new Linker({
    accountsRoot: join(dir, 'accounts'),
    spawnLogin,
    urlTimeoutMs: options.urlTimeoutMs ?? 5000,
    overallTimeoutMs: options.overallTimeoutMs ?? 10_000,
  });
  return { dir, linker, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
