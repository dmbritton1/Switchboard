import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexProviderPool } from '../src/agents/codex-provider.ts';
import {
  runCodexAppServerTransportSmoke,
  type CodexAppServerTransportSmokeEvidence,
} from '../scripts/codex-app-server-transport-smoke.ts';
import type { Account } from '../src/accounts.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));
const secret = 'fixture-transport-secret';

function account(): Account {
  return { name: 'fixture-codex', provider: 'codex', budget: 1_000, env: { CODEX_TOKEN: secret } };
}

function poolFactory(): () => CodexProviderPool {
  return () => new CodexProviderPool({
    prepareRuntime: async (configured) => ({
      source: 'explicit', commandPath: fakeCommand, version: '0.145.0',
      env: { ...process.env, ...configured.env, FAKE_APP_SERVER_MODE: 'turn-multi-session' }, diagnostics: [],
    }),
  });
}

test('fake transport smoke drives the production pool and adapter without publishing private traffic', async () => {
  const evidence = await runCodexAppServerTransportSmoke({
    mode: 'fake', account: account(), createPool: poolFactory(),
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
});

test('real transport smoke refuses before creating a provider when paid consent or a configured Codex account is absent', async () => {
  let pools = 0;
  let worktrees = 0;
  const createPool = (): CodexProviderPool => {
    pools += 1;
    return poolFactory()();
  };
  const createWorktree = async (): Promise<string> => {
    worktrees += 1;
    throw new Error('real smoke guard must run before workspace setup');
  };

  await assert.rejects(
    runCodexAppServerTransportSmoke({
      mode: 'real', accountName: 'fixture-codex', accounts: [account()], env: {}, createPool, createWorktree,
    }),
    /SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1/,
  );
  assert.equal(pools, 0);
  assert.equal(worktrees, 0);

  await assert.rejects(
    runCodexAppServerTransportSmoke({
      mode: 'real', accountName: 'missing', accounts: [account()],
      env: { SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE: '1' }, createPool, createWorktree,
    }),
    /configured Codex account/,
  );
  assert.equal(pools, 0);
  assert.equal(worktrees, 0);
});
