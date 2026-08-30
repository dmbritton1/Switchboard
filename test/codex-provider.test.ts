import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexProviderPool } from '../src/agents/codex-provider.ts';
import { CodexAppServerSupervisor } from '../src/agents/codex-app-server-supervisor.ts';
import { appServerArgs } from '../src/agents/codex-app-server-contract.ts';
import type { Account } from '../src/accounts.ts';
import type { Adapter, AccountLimitSnapshot } from '../src/types.ts';

function account(name: string): Account {
  return { name, provider: 'codex', budget: 1_000, env: {} };
}

function adapter(label: string): Adapter & { label: string } {
  return {
    label,
    start: () => { throw new Error('adapter execution belongs to Task 3'); },
  };
}

type Harness = {
  pool: CodexProviderPool;
  prepared: string[];
  sdkAdapters: Array<Adapter & { label: string }>;
  appAdapters: Array<Adapter & { label: string }>;
  appSupervisors: CodexAppServerSupervisor[];
  launches: Map<string, string[][]>;
  closes: Map<string, number>;
};

async function harness(
  t: { after(fn: () => Promise<void>): void },
  options: { failPreflight?: boolean; failContract?: boolean } = {},
): Promise<Harness> {
  const prepared: string[] = [];
  const sdkAdapters: Array<Adapter & { label: string }> = [];
  const appAdapters: Array<Adapter & { label: string }> = [];
  const appSupervisors: CodexAppServerSupervisor[] = [];
  const launches = new Map<string, string[][]>();
  const closes = new Map<string, number>();
  const pool = new CodexProviderPool({
    prepareRuntime: async (configured) => {
      prepared.push(configured.name);
      if (options.failPreflight) throw new Error('private preflight detail');
      return {
        source: 'explicit' as const,
        commandPath: `/fixture/${configured.name}/codex`,
        version: options.failContract ? '0.144.0' : '0.145.0',
        env: { TEST_PROVIDER_ACCOUNT: configured.name },
        diagnostics: [],
      };
    },
    createSupervisor: (supervisorOptions) => {
      const accountName = supervisorOptions.runtime.env.TEST_PROVIDER_ACCOUNT;
      assert.ok(accountName);
      return new CodexAppServerSupervisor({
        ...supervisorOptions,
        verifyContract: async () => {
          if (options.failContract) throw new Error('private contract detail');
        },
        clientFactory: (clientOptions) => {
          const accountLaunches = launches.get(accountName) ?? [];
          accountLaunches.push([...clientOptions.args]);
          launches.set(accountName, accountLaunches);
          let closed = false;
          return {
            request: async <T>(method: string): Promise<T> => {
              if (method === 'initialize') return { initialized: true } as T;
              if (method === 'account/read') {
                return {
                  account: { type: 'chatgpt', email: null, planType: 'pro' },
                  requiresOpenaiAuth: true,
                } as T;
              }
              if (method === 'account/rateLimits/read') {
                return {
                  rateLimits: {
                    limitId: null,
                    limitName: null,
                    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
                    secondary: null,
                    spendControlReached: false,
                    rateLimitReachedType: null,
                  },
                  rateLimitsByLimitId: null,
                } as T;
              }
              throw new Error(`unsupported fixture method ${method}`);
            },
            notify: () => {},
            respondError: () => {},
            close: async () => {
              if (closed) return;
              closed = true;
              closes.set(accountName, (closes.get(accountName) ?? 0) + 1);
            },
          };
        },
      });
    },
    createSdkAdapter: (runtime) => {
      const value = adapter(`sdk:${runtime.version}`);
      sdkAdapters.push(value);
      return value;
    },
    createAppServerAdapter: (supervisor, sessionId, runtimeVersion) => {
      const value = adapter(`app-server:${sessionId}:${runtimeVersion}`);
      appAdapters.push(value);
      appSupervisors.push(supervisor);
      return value;
    },
  });
  t.after(() => pool.close());
  return { pool, prepared, sdkAdapters, appAdapters, appSupervisors, launches, closes };
}

function listener(snapshots: AccountLimitSnapshot[]): {
  onSnapshot(snapshot: AccountLimitSnapshot): void;
  onStale(reason: string): void;
} {
  return {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStale: () => {},
  };
}

test('two telemetry callers share one runtime, supervisor, and child while both stay subscribed', async (t) => {
  const fixture = await harness(t);
  const snapshotsA: AccountLimitSnapshot[] = [];
  const snapshotsB: AccountLimitSnapshot[] = [];
  const configured = account('shared');

  const [one, two] = await Promise.all([
    fixture.pool.limits(configured, listener(snapshotsA)),
    fixture.pool.limits(configured, listener(snapshotsB)),
  ]);
  assert.equal(one, two);
  await one.start();

  assert.deepEqual(fixture.prepared, ['shared']);
  assert.equal(fixture.launches.get('shared')?.length, 1);
  assert.equal(snapshotsA.length, 1);
  assert.equal(snapshotsB.length, 1);
});

test('telemetry followed by app-server preparation promotes the same supervisor', async (t) => {
  const fixture = await harness(t);
  const configured = account('promoted');
  const supervisor = await fixture.pool.limits(configured, listener([]));
  await supervisor.start();

  const prepared = await fixture.pool.prepare(configured, 'app-server', 'session-a');

  assert.equal(prepared.adapter, fixture.appAdapters[0]);
  assert.equal(prepared.runtimeVersion, '0.145.0');
  assert.equal(fixture.appSupervisors[0], supervisor);
  assert.deepEqual(fixture.launches.get('promoted'), [
    appServerArgs('telemetry'),
    appServerArgs('turns'),
  ]);
});

test('two app-server sessions share one turn child and receive distinct adapters', async (t) => {
  const fixture = await harness(t);
  const configured = account('turns');

  const [one, two] = await Promise.all([
    fixture.pool.prepare(configured, 'app-server', 'session-one'),
    fixture.pool.prepare(configured, 'app-server', 'session-two'),
  ]);

  assert.notEqual(one.adapter, two.adapter);
  assert.equal(fixture.appSupervisors[0], fixture.appSupervisors[1]);
  assert.deepEqual(fixture.appAdapters.map((value) => value.label).sort(), [
    'app-server:session-one:0.145.0',
    'app-server:session-two:0.145.0',
  ]);
  assert.deepEqual(fixture.launches.get('turns'), [
    appServerArgs('turns'),
  ]);
});

test('SDK preparation uses the SDK adapter without promoting telemetry', async (t) => {
  const fixture = await harness(t);
  const configured = account('sdk');
  const supervisor = await fixture.pool.limits(configured, listener([]));
  await supervisor.start();

  const prepared = await fixture.pool.prepare(configured, 'sdk', 'sdk-session');

  assert.equal(prepared.adapter, fixture.sdkAdapters[0]);
  assert.equal(fixture.appAdapters.length, 0);
  assert.deepEqual(fixture.launches.get('sdk'), [
    appServerArgs('telemetry'),
  ]);
});

test('configured Codex accounts never share runtime or child ownership', async (t) => {
  const fixture = await harness(t);
  const [one, two] = await Promise.all([
    fixture.pool.limits(account('one'), listener([])),
    fixture.pool.limits(account('two'), listener([])),
  ]);
  await Promise.all([one.start(), two.start()]);

  assert.notEqual(one, two);
  assert.deepEqual(fixture.prepared.sort(), ['one', 'two']);
  assert.equal(fixture.launches.get('one')?.length, 1);
  assert.equal(fixture.launches.get('two')?.length, 1);
});

test('pool close settles every supervisor exactly once and is idempotent', async (t) => {
  const fixture = await harness(t);
  const one = await fixture.pool.limits(account('one'), listener([]));
  const two = await fixture.pool.limits(account('two'), listener([]));
  await Promise.all([one.start(), two.start()]);

  await Promise.all([fixture.pool.close(), fixture.pool.close(), fixture.pool.close()]);

  assert.equal(fixture.closes.get('one'), 1);
  assert.equal(fixture.closes.get('two'), 1);
});

test('app-server preflight and contract failures fail closed without constructing an SDK adapter', async (t) => {
  await t.test('preflight', async (t) => {
    const fixture = await harness(t, { failPreflight: true });
    await assert.rejects(fixture.pool.prepare(account('preflight'), 'app-server', 'session'));
    assert.equal(fixture.sdkAdapters.length, 0);
    assert.equal(fixture.appAdapters.length, 0);
  });
  await t.test('contract', async (t) => {
    const fixture = await harness(t, { failContract: true });
    await assert.rejects(fixture.pool.prepare(account('contract'), 'app-server', 'session'));
    assert.equal(fixture.sdkAdapters.length, 0);
    assert.equal(fixture.appAdapters.length, 0);
  });
});
