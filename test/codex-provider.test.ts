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

function accountGeneration(name: string, generation: string): Account {
  return {
    name,
    provider: 'codex',
    budget: 1_000,
    env: { TEST_PROVIDER_GENERATION: generation },
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  closeStarts: Map<string, number>;
  preparedGenerations: string[];
};

async function harness(
  t: { after(fn: () => Promise<void>): void },
  options: {
    failPreflight?: boolean;
    failPreflightAttempts?: number;
    failContract?: boolean;
    failInitialization?: boolean;
    beforeRuntimePrepare?: (generation: string) => Promise<void>;
    beforeClientClose?: (generation: string) => Promise<void>;
  } = {},
): Promise<Harness> {
  const prepared: string[] = [];
  const sdkAdapters: Array<Adapter & { label: string }> = [];
  const appAdapters: Array<Adapter & { label: string }> = [];
  const appSupervisors: CodexAppServerSupervisor[] = [];
  const launches = new Map<string, string[][]>();
  const closes = new Map<string, number>();
  const closeStarts = new Map<string, number>();
  const preparedGenerations: string[] = [];
  let prepareAttempts = 0;
  const pool = new CodexProviderPool({
    prepareRuntime: async (configured) => {
      prepared.push(configured.name);
      const generation = configured.env.TEST_PROVIDER_GENERATION ?? configured.name;
      preparedGenerations.push(generation);
      await options.beforeRuntimePrepare?.(generation);
      prepareAttempts += 1;
      if (options.failPreflight || prepareAttempts <= (options.failPreflightAttempts ?? 0)) {
        throw new Error('private preflight detail');
      }
      return {
        source: 'explicit' as const,
        commandPath: `/fixture/${configured.name}/codex`,
        version: options.failContract ? '0.144.0' : '0.145.0',
        env: {
          TEST_PROVIDER_ACCOUNT: configured.name,
          TEST_PROVIDER_GENERATION: generation,
        },
        diagnostics: [],
      };
    },
    createSupervisor: (supervisorOptions) => {
      const accountName = supervisorOptions.runtime.env.TEST_PROVIDER_ACCOUNT;
      const generation = supervisorOptions.runtime.env.TEST_PROVIDER_GENERATION;
      assert.ok(accountName);
      assert.ok(generation);
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
              if (method === 'initialize') {
                if (options.failInitialization) throw new Error('private initialization detail');
                return { initialized: true } as T;
              }
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
              closeStarts.set(generation, (closeStarts.get(generation) ?? 0) + 1);
              await options.beforeClientClose?.(generation);
              closes.set(generation, (closes.get(generation) ?? 0) + 1);
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
  return {
    pool,
    prepared,
    sdkAdapters,
    appAdapters,
    appSupervisors,
    launches,
    closes,
    closeStarts,
    preparedGenerations,
  };
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

test('app-server preparation preserves sanitized typed setup failure codes without SDK fallback', async (t) => {
  const cases = [
    { name: 'contract', options: { failContract: true }, code: 'codex_protocol_mismatch' },
    { name: 'initialization', options: { failInitialization: true }, code: 'codex_app_server_initialization_failed' },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fixture = await harness(t, entry.options);
      await assert.rejects(
        fixture.pool.prepare(account(`typed-${entry.name}`), 'app-server', 'session'),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, entry.code);
          assert.doesNotMatch(String((error as Error).message), /private/);
          return true;
        },
      );
      assert.equal(fixture.sdkAdapters.length, 0);
      assert.equal(fixture.appAdapters.length, 0);
    });
  }
});

test('concurrent app-server prepares share a transient preflight failure and a later prepare retries', async (t) => {
  const fixture = await harness(t, { failPreflightAttempts: 1 });
  const configured = account('retry');

  const failed = await Promise.allSettled([
    fixture.pool.prepare(configured, 'app-server', 'session-one'),
    fixture.pool.prepare(configured, 'app-server', 'session-two'),
  ]);

  assert.deepEqual(failed.map(({ status }) => status), ['rejected', 'rejected']);
  assert.deepEqual(fixture.prepared, ['retry'], 'concurrent callers share one in-flight preflight');
  assert.equal(fixture.sdkAdapters.length, 0, 'app-server failure never falls back to SDK');

  const retried = await fixture.pool.prepare(configured, 'app-server', 'session-three');

  assert.equal(retried.adapter, fixture.appAdapters[0]);
  assert.deepEqual(fixture.prepared, ['retry', 'retry']);
  assert.equal(fixture.sdkAdapters.length, 0);
  assert.deepEqual(fixture.launches.get('retry'), [appServerArgs('turns')]);
});

test('retirement closes the old child and relinking prepares fresh SDK and app-server ownership', async (t) => {
  const f = await harness(t);
  const old = account('relinked');
  await f.pool.prepare(old, 'sdk', 'old-sdk');
  await f.pool.prepare(old, 'app-server', 'old-app');
  const oldSupervisor = f.appSupervisors[0];
  await f.pool.retire(old);
  assert.equal(f.closes.get(old.name), 1);
  await assert.rejects(oldSupervisor.start());
  await assert.rejects(f.pool.prepare(old, 'sdk', 'retired'), /retired/);
  const replacement = account(old.name);
  await f.pool.prepare(replacement, 'sdk', 'new-sdk');
  await f.pool.prepare(replacement, 'app-server', 'new-app');
  assert.deepEqual(f.prepared, ['relinked', 'relinked']);
  assert.notEqual(f.appSupervisors[1], oldSupervisor);
  await f.pool.retire(old); // An old identity cannot retire its replacement.
  await f.appSupervisors[1].start();
  assert.equal(f.closes.get(old.name), 1);
});

test('same-name replacement waits for the removed entry retirement before preparing new ownership', async (t) => {
  const oldClose = deferred();
  const oldCloseStarted = deferred();
  const fixture = await harness(t, {
    beforeClientClose: async (generation) => {
      if (generation !== 'old') return;
      oldCloseStarted.resolve();
      await oldClose.promise;
    },
  });
  const old = accountGeneration('relinked-gated', 'old');
  const replacement = accountGeneration(old.name, 'replacement');

  await fixture.pool.prepare(old, 'app-server', 'old-session');
  const retirement = fixture.pool.retire(old);
  await oldCloseStarted.promise;
  const replacementPreparation = fixture.pool.prepare(replacement, 'app-server', 'new-session');

  await fixture.pool.prepare(accountGeneration('independent', 'independent'), 'sdk', 'independent');
  try {
    assert.deepEqual(
      fixture.preparedGenerations,
      ['old', 'independent'],
      'replacement runtime preparation must remain behind the old close',
    );
    assert.equal(fixture.appSupervisors.length, 1);
  } finally {
    oldClose.resolve();
    await Promise.allSettled([retirement, replacementPreparation]);
  }
  assert.deepEqual(fixture.preparedGenerations, ['old', 'independent', 'replacement']);
  assert.equal(fixture.appSupervisors.length, 2);

  await fixture.pool.close();
  assert.equal(fixture.closeStarts.get('old'), 1);
  assert.equal(fixture.closeStarts.get('replacement'), 1);
  assert.equal(fixture.closes.get('old'), 1);
  assert.equal(fixture.closes.get('replacement'), 1);
});

test('same-name replacement waits for retired identity runtime preparation to settle', async (t) => {
  const oldRuntimeEntered = deferred();
  const releaseOldRuntime = deferred();
  const fixture = await harness(t, {
    beforeRuntimePrepare: async (generation) => {
      if (generation !== 'old') return;
      oldRuntimeEntered.resolve();
      await releaseOldRuntime.promise;
    },
  });
  const old = accountGeneration('runtime-gated', 'old');
  const replacement = accountGeneration(old.name, 'replacement');
  const oldPreparation = fixture.pool.prepare(old, 'app-server', 'old-session');
  const oldRejected = assert.rejects(oldPreparation, /retired/);
  await oldRuntimeEntered.promise;

  const retirement = fixture.pool.retire(old);
  const replacementPreparation = fixture.pool.prepare(replacement, 'app-server', 'replacement-session');
  try {
    await nextTurn();
    assert.deepEqual(
      fixture.preparedGenerations,
      ['old'],
      'replacement preparation must remain behind all work owned by the retired identity',
    );
  } finally {
    releaseOldRuntime.resolve();
    await Promise.allSettled([oldRejected, retirement, replacementPreparation]);
  }

  assert.deepEqual(fixture.preparedGenerations, ['old', 'replacement']);
  assert.equal(fixture.appAdapters.length, 1);
  assert.equal(fixture.sdkAdapters.length, 0);
});

test('pool close joins a removed retirement and rejects its waiting same-name replacement before construction', async (t) => {
  const oldClose = deferred();
  const oldCloseStarted = deferred();
  const anchorCloseStarted = deferred();
  const fixture = await harness(t, {
    beforeClientClose: async (generation) => {
      if (generation === 'old') {
        oldCloseStarted.resolve();
        await oldClose.promise;
      }
      if (generation === 'anchor') anchorCloseStarted.resolve();
    },
  });
  const old = accountGeneration('shutdown-race', 'old');
  const replacement = accountGeneration(old.name, 'replacement');
  await fixture.pool.prepare(old, 'app-server', 'old-session');
  await fixture.pool.prepare(accountGeneration('shutdown-anchor', 'anchor'), 'app-server', 'anchor-session');

  const retirement = fixture.pool.retire(old);
  await oldCloseStarted.promise;
  const replacementPreparation = fixture.pool.prepare(replacement, 'app-server', 'replacement-session');
  const replacementRejected = assert.rejects(replacementPreparation, /closed/);
  await fixture.pool.prepare(accountGeneration('shutdown-yield', 'yield'), 'sdk', 'yield-session');

  let closeResolved = false;
  const closing = fixture.pool.close().then(() => { closeResolved = true; });
  try {
    await anchorCloseStarted.promise;
    await nextTurn();
    assert.equal(closeResolved, false, 'shutdown must still be joining the removed old retirement');
  } finally {
    oldClose.resolve();
    await Promise.allSettled([retirement, replacementRejected, closing]);
  }

  assert.equal(fixture.preparedGenerations.includes('replacement'), false);
  assert.equal(fixture.closeStarts.get('old'), 1);
  assert.equal(fixture.closeStarts.get('anchor'), 1);
  assert.equal(fixture.closeStarts.get('replacement'), undefined);
});

test('pool close joins failed supervisor preparation and closes its supervisor exactly once', async () => {
  const preparationEntered = deferred();
  const failPreparation = deferred();
  const closeCalled = deferred();
  let supervisorCloses = 0;
  let sdkAdapters = 0;
  let appAdapters = 0;
  const supervisor = {
    ensureTurnTransport: async () => {
      preparationEntered.resolve();
      await failPreparation.promise;
      throw new Error('failed supervisor preparation');
    },
    close: async () => {
      supervisorCloses += 1;
      closeCalled.resolve();
    },
  } as unknown as CodexAppServerSupervisor;
  const pool = new CodexProviderPool({
    prepareRuntime: async () => ({
      source: 'explicit',
      commandPath: '/fixture/codex',
      version: '0.145.0',
      env: {},
      diagnostics: [],
    }),
    createSupervisor: () => supervisor,
    createSdkAdapter: () => { sdkAdapters += 1; return adapter('unexpected-sdk'); },
    createAppServerAdapter: () => { appAdapters += 1; return adapter('unexpected-app-server'); },
  });
  const preparation = pool.prepare(account('failed-preparation'), 'app-server', 'session');
  const preparationRejected = assert.rejects(preparation, /failed supervisor preparation/);
  await preparationEntered.promise;

  let closeResolved = false;
  const closing = pool.close().then(() => { closeResolved = true; });
  await closeCalled.promise;
  await nextTurn();
  try {
    assert.equal(closeResolved, false, 'shutdown must wait for the in-flight preparation to reject');
  } finally {
    failPreparation.resolve();
    await Promise.allSettled([preparationRejected, closing, pool.close()]);
  }
  assert.equal(supervisorCloses, 1);
  assert.equal(sdkAdapters, 0);
  assert.equal(appAdapters, 0);
});

test('pool close drains gated runtime preparation and concurrent identity retirement', async () => {
  const runtimeEntered = deferred();
  const releaseRuntime = deferred();
  let created = 0;
  const pool = new CodexProviderPool({
    prepareRuntime: async () => {
      runtimeEntered.resolve();
      await releaseRuntime.promise;
      return {
        source: 'explicit',
        commandPath: '/fixture/codex',
        version: '0.145.0',
        env: {},
        diagnostics: [],
      };
    },
    createSdkAdapter: () => { created += 1; return adapter('unexpected-sdk'); },
    createSupervisor: () => { created += 1; throw new Error('unexpected supervisor'); },
  });
  const configured = account('shutdown-runtime');
  const preparation = pool.prepare(configured, 'app-server', 'session');
  const preparationRejected = assert.rejects(preparation, /closed|retired/);
  await runtimeEntered.promise;

  let closeResolved = false;
  let retireResolved = false;
  const closing = pool.close().then(() => { closeResolved = true; });
  const retiring = pool.retire(configured).then(() => { retireResolved = true; });
  try {
    await nextTurn();
    assert.equal(closeResolved, false, 'shutdown must drain the in-flight runtime preparation');
    assert.equal(retireResolved, false, 'concurrent retirement must share the same ownership drain');
  } finally {
    releaseRuntime.resolve();
    await Promise.allSettled([preparationRejected, closing, retiring]);
  }

  assert.equal(created, 0);
  await pool.close();
});

test('retirement fails closed during SDK, app-server, and telemetry runtime preparation', async () => {
  for (const transport of ['sdk', 'app-server', 'limits'] as const) {
    let resolve!: (value: any) => void;
    let created = 0;
    const pool = new CodexProviderPool({
      prepareRuntime: () => new Promise((r) => { resolve = r; }),
      createSdkAdapter: () => { created++; return adapter('unexpected'); },
      createSupervisor: () => { created++; throw new Error('unexpected supervisor'); },
    });
    const old = account('pending');
    const pending = transport === 'limits' ? pool.limits(old, listener([])) : pool.prepare(old, transport, 'pending');
    const rejected = assert.rejects(pending, /retired/);
    await Promise.resolve();
    let retirementResolved = false;
    const retired = pool.retire(old).then(() => { retirementResolved = true; });
    await nextTurn();
    assert.equal(retirementResolved, false, 'retirement must retain in-flight preparation ownership');
    resolve({ source: 'explicit', commandPath: '/fixture/codex', version: '0.145.0', env: {}, diagnostics: [] });
    await Promise.all([retired, rejected]);
    assert.equal(created, 0);
    await pool.close();
  }
});

test('retirement during supervisor preparation prevents adapter creation', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let adapters = 0;
  const pool = new CodexProviderPool({
    prepareRuntime: async () => ({ source: 'explicit', commandPath: '/fixture/codex', version: '0.145.0', env: {}, diagnostics: [] }),
    createSupervisor: (options) => new CodexAppServerSupervisor({
      ...options, verifyContract: async () => { entered(); await gate; },
      clientFactory: () => { throw new Error('retired preparation must not launch'); },
    }),
    createAppServerAdapter: () => { adapters++; return adapter('unexpected'); },
  });
  const old = account('preparing');
  const pending = pool.prepare(old, 'app-server', 'session');
  const rejected = assert.rejects(pending);
  await started;
  const retired = pool.retire(old);
  release();
  await Promise.all([retired, rejected]);
  assert.equal(adapters, 0);
  await pool.close();
});
