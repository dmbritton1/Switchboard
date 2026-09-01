import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CodexProviderPool } from '../src/agents/codex-provider.ts';
import {
  createSmokeWorkspace,
  runCodexAppServerTransportSmoke,
  type CodexAppServerTransportSmokeEvidence,
} from '../scripts/codex-app-server-transport-smoke.ts';
import type { Account } from '../src/accounts.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));
const secret = 'fixture-transport-secret';
const run = promisify(execFile);

function account(): Account {
  return { name: 'fixture-codex', provider: 'codex', budget: 1_000, env: { CODEX_TOKEN: secret } };
}

function poolFactory(extraEnv: Record<string, string> = {}): () => CodexProviderPool {
  return () => new CodexProviderPool({
    prepareRuntime: async (configured) => ({
      source: 'explicit', commandPath: fakeCommand, version: '0.145.0',
      env: { ...process.env, ...configured.env, ...extraEnv, FAKE_APP_SERVER_MODE: 'turn-multi-session' }, diagnostics: [],
    }),
  });
}

test('fake transport smoke drives the production pool and adapter without publishing private traffic', async (t) => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'switchboard-transport-smoke-test-'));
  const callLog = resolve(fixtureRoot, 'calls.jsonl');
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const telemetry: Array<'snapshot' | 'stale'> = [];
  const observedWorktrees: string[] = [];
  const evidence = await runCodexAppServerTransportSmoke({
    mode: 'fake', account: account(), createPool: poolFactory({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    onTelemetryEvent: (event) => { telemetry.push(event); },
    onWorkspaceReady: async (repository, worktrees) => {
      assert.equal(worktrees.length, 4);
      const commonDirectory = await realpath(resolve(
        worktrees[0],
        (await run('git', ['rev-parse', '--git-common-dir'], { cwd: worktrees[0] })).stdout.trim(),
      ));
      assert.equal(commonDirectory, await realpath(resolve(repository, '.git')));
      for (const worktree of worktrees) {
        observedWorktrees.push(worktree);
        assert.equal((await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: worktree })).stdout.trim(), 'true');
        assert.match((await run('git', ['rev-parse', '--git-dir'], { cwd: worktree })).stdout, /\.git\/worktrees\//);
        assert.equal(await readFile(resolve(worktree, 'AGENTS.md'), 'utf8'), 'Smoke fixture instructions.\n');
        assert.equal(await readFile(resolve(worktree, '.codex', 'config.toml'), 'utf8'), 'model = "fixture-model"\n');
      }
    },
  });

  assert.deepEqual(evidence, {
    version: '0.145.0',
    initialized: true,
    telemetryContinuity: true,
    newThread: true,
    firstTurn: true,
    followUp: true,
    cleanProcessRestart: true,
    resume: true,
    interrupt: true,
    multiSessionRouting: true,
    noReplay: true,
    cleanShutdown: true,
    fixtureIds: ['fixture-a', 'fixture-b', 'fixture-resume'],
  } satisfies CodexAppServerTransportSmokeEvidence);

  const serialized = JSON.stringify(evidence);
  for (const privateValue of [secret, 'fixture-codex', 'session-a-first', '/private/', 'stderr', 'item/completed']) {
    assert.equal(serialized.includes(privateValue), false);
  }

  const calls = (await readFile(callLog, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method?: string; params?: { cwd?: unknown } });
  const routedWorktrees = calls
    .filter((call) => call.method === 'thread/start' || call.method === 'thread/resume')
    .map((call) => call.params?.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string');
  assert.deepEqual([...new Set(routedWorktrees)].sort(), [...observedWorktrees].sort());

  const firstSnapshot = telemetry.indexOf('snapshot');
  const stale = telemetry.indexOf('stale', firstSnapshot + 1);
  const promotedSnapshot = telemetry.indexOf('snapshot', stale + 1);
  assert.deepEqual({
    workspaceObserved: observedWorktrees.length === 4,
    initialSnapshotObserved: firstSnapshot >= 0,
    promotionInvalidatedSnapshot: stale > firstSnapshot,
    postPromotionSnapshotObserved: promotedSnapshot > stale,
  }, {
    workspaceObserved: true,
    initialSnapshotObserved: true,
    promotionInvalidatedSnapshot: true,
    postPromotionSnapshotObserved: true,
  });
  for (const worktree of observedWorktrees) await assert.rejects(access(worktree));
});

test('real-mode workspace helper creates one temporary git worktree and cleans it', async () => {
  const workspace = await createSmokeWorkspace('real');
  try {
    assert.equal(workspace.worktrees.length, 1);
    const worktree = workspace.worktrees[0]!;
    const commonDirectory = await realpath(resolve(
      worktree,
      (await run('git', ['rev-parse', '--git-common-dir'], { cwd: worktree })).stdout.trim(),
    ));
    assert.equal(commonDirectory, await realpath(resolve(workspace.repository, '.git')));
    assert.equal((await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: worktree })).stdout.trim(), 'true');
    assert.match((await run('git', ['rev-parse', '--git-dir'], { cwd: worktree })).stdout, /\.git\/worktrees\//);
    assert.equal(await readFile(resolve(worktree, 'AGENTS.md'), 'utf8'), 'Do not use files or tools during this smoke.\n');
    await assert.rejects(readFile(resolve(worktree, '.codex', 'config.toml'), 'utf8'));
  } finally {
    await workspace.cleanup();
  }
  await assert.rejects(access(workspace.repository));
  await assert.rejects(access(workspace.worktrees[0]!));
});

test('real transport smoke refuses before creating a provider when paid consent or a configured Codex account is absent', async () => {
  let pools = 0;
  let worktrees = 0;
  const createPool = (): CodexProviderPool => {
    pools += 1;
    return poolFactory()();
  };
  const createWorkspace = async (): Promise<never> => {
    worktrees += 1;
    throw new Error('real smoke guard must run before workspace setup');
  };

  await assert.rejects(
    runCodexAppServerTransportSmoke({
      mode: 'real', accountName: 'fixture-codex', accounts: [account()], env: {}, createPool, createWorkspace,
    }),
    /SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1/,
  );
  assert.equal(pools, 0);
  assert.equal(worktrees, 0);

  await assert.rejects(
    runCodexAppServerTransportSmoke({
      mode: 'real', accountName: 'missing', accounts: [account()],
      env: { SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE: '1' }, createPool, createWorkspace,
    }),
    /configured Codex account/,
  );
  assert.equal(pools, 0);
  assert.equal(worktrees, 0);
});
