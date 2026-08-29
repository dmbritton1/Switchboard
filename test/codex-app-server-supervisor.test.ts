import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AppServerClient,
  type AppServerClientOptions,
} from '../src/agents/codex-app-server-client.ts';
import { CodexAppServerSupervisor } from '../src/agents/codex-app-server-supervisor.ts';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import type { AccountLimitSnapshot } from '../src/types.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));
const unavailable = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const signedOut = 'Codex account telemetry is unavailable while signed out.';
const externalHeaders = 'Codex account telemetry is unavailable for external header authentication.';
const externalTokens = 'Codex account telemetry is unavailable for external ChatGPT token authentication.';

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...overrides,
  };
}

function runtime(overrides: Record<string, string> = {}): PreparedCodexRuntime {
  return {
    source: 'explicit',
    commandPath: fakeCommand,
    version: '0.145.0',
    env: environment(overrides),
    diagnostics: [],
  };
}

async function calls(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(check: () => boolean, milliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('test timed out waiting for supervisor state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function callbacks(): {
  snapshots: AccountLimitSnapshot[];
  stale: string[];
  onSnapshot: (snapshot: AccountLimitSnapshot) => void;
  onStale: (reason: string) => void;
} {
  const snapshots: AccountLimitSnapshot[] = [];
  const stale: string[] = [];
  return {
    snapshots,
    stale,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStale: (reason) => stale.push(reason),
  };
}

type ScriptedClient = Pick<AppServerClient, 'request' | 'notify' | 'respondError' | 'close'> & {
  crash: () => void;
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function managedAccountResult(): Record<string, unknown> {
  return {
    account: { type: 'chatgpt', email: null, planType: 'pro' },
    requiresOpenaiAuth: true,
  };
}

function rateLimitsResult(usedPercent = 25): Record<string, unknown> {
  return {
    rateLimits: {
      limitId: null,
      limitName: null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: null,
      spendControlReached: false,
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  };
}

function deferredAccountClient(
  options: AppServerClientOptions,
  accountRead: Promise<unknown>,
  requests: string[],
  denied: Array<{ id: string | number; code: number; message: string }> = [],
): ScriptedClient {
  return {
    request: async <T>(method: string): Promise<T> => {
      requests.push(method);
      if (method === 'initialize') return { initialized: true } as T;
      if (method === 'account/read') return accountRead as Promise<T>;
      if (method === 'account/rateLimits/read') return rateLimitsResult() as T;
      throw new Error('unsupported scripted request');
    },
    notify: () => {},
    respondError: (id, code, message) => { denied.push({ id, code, message }); },
    close: async () => {},
    crash: () => options.onExit(new Error('private scripted crash')),
  };
}

function scriptedClient(options: AppServerClientOptions, fail = false): ScriptedClient {
  return {
    request: async <T>(method: string): Promise<T> => {
      if (fail) throw new Error('private scripted failure');
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
      throw new Error('unsupported scripted request');
    },
    notify: () => {},
    respondError: () => {},
    close: async () => {},
    crash: () => options.onExit(new Error('private scripted crash')),
  };
}

test('verifies before one child starts, initializes before reads, coalesces reads, and issues no turn RPCs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-lifecycle-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const lifecycle: string[] = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => { lifecycle.push('verify'); },
    clientFactory: (options: AppServerClientOptions) => {
      lifecycle.push('spawn');
      return new AppServerClient(options);
    },
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()]);
  const reconciled = await Promise.all([supervisor.reconcile(), supervisor.reconcile(), supervisor.reconcile()]);

  assert.deepEqual(lifecycle, ['verify', 'spawn']);
  assert.equal(observed.snapshots.length, 2);
  assert.equal(observed.stale.length, 0);
  assert.ok(reconciled.every((snapshot) => snapshot === reconciled[0]));
  const log = await calls(callLog);
  assert.deepEqual(log.filter((entry) => entry.method).map((entry) => entry.method), [
    'initialize',
    'initialized',
    'account/read',
    'account/rateLimits/read',
    'account/rateLimits/read',
  ]);
  assert.deepEqual(log.find((entry) => entry.method === 'initialize')?.params, {
    clientInfo: { name: 'switchboard_telemetry', title: 'Switchboard telemetry', version: '0.1.0' },
    capabilities: null,
  });
  assert.deepEqual(log.find((entry) => entry.method === 'account/read')?.params, { refreshToken: false });
  assert.equal(log.filter((entry) => entry.method === 'initialize').length, 1);
  assert.equal(log.some((entry) => /^(thread|turn)\//.test(String(entry.method))), false);
  assert.equal(log.some((entry) => entry.method === 'getAuthStatus'), false);
});

test('reconcile joins a pending initialize before reading auth state', async (t) => {
  const initialize = deferred<unknown>();
  const requests: string[] = [];
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => ({
      request: async <T>(method: string): Promise<T> => {
        requests.push(method);
        if (method === 'initialize') return initialize.promise as Promise<T>;
        if (method === 'account/read') return managedAccountResult() as T;
        if (method === 'account/rateLimits/read') return rateLimitsResult() as T;
        throw new Error('unsupported scripted request');
      },
      notify: () => {},
      respondError: () => {},
      close: async () => {},
      crash: () => options.onExit(new Error('private scripted crash')),
    }),
  });
  t.after(() => supervisor.close());

  const startup = supervisor.start();
  await waitFor(() => requests.includes('initialize'));
  const reconciliation = supervisor.reconcile().then(
    (snapshot) => ({ status: 'fulfilled' as const, snapshot }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  const early = await Promise.race([
    reconciliation.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  initialize.resolve({ initialized: true });

  await startup;
  const result = await reconciliation;
  assert.equal(early, 'pending');
  assert.equal(result.status, 'fulfilled');
  if (result.status === 'fulfilled') assert.equal(result.snapshot.fresh, true);
  assert.deepEqual(observed.stale, []);
});

test('token refresh denial during initialize stays unsupported until a managed auth update', async (t) => {
  const initialize = deferred<unknown>();
  const observed = callbacks();
  const requests: string[] = [];
  let protocol!: AppServerClientOptions;
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocol = options;
      return {
        request: async <T>(method: string): Promise<T> => {
          requests.push(method);
          if (method === 'initialize') return initialize.promise as Promise<T>;
          if (method === 'account/read') return managedAccountResult() as T;
          if (method === 'account/rateLimits/read') return rateLimitsResult() as T;
          throw new Error('unsupported scripted request');
        },
        notify: () => {},
        respondError: () => {},
        close: async () => {},
      };
    },
  });
  t.after(() => supervisor.close());

  const startup = supervisor.start();
  await waitFor(() => requests.includes('initialize'));
  protocol.onServerRequest(8_001, 'account/chatgptAuthTokens/refresh', {
    refreshToken: 'private-refresh-token',
  });
  initialize.resolve({ initialized: true });
  await startup;

  assert.deepEqual(observed.stale, [externalTokens]);
  assert.equal(observed.snapshots.length, 0);
  await assert.rejects(
    supervisor.reconcile(),
    (error: unknown) => error instanceof Error && error.message === externalTokens,
  );

  protocol.onNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
  await waitFor(() => observed.snapshots.length === 1);
  assert.equal(observed.snapshots[0]?.plan, 'pro');
});

test('token refresh denial during startup account read stays unsupported until a managed auth update', async (t) => {
  const accountRead = deferred<unknown>();
  const observed = callbacks();
  const requests: string[] = [];
  const denied: Array<{ id: string | number; code: number; message: string }> = [];
  let protocol!: AppServerClientOptions;
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocol = options;
      return deferredAccountClient(options, accountRead.promise, requests, denied);
    },
  });
  t.after(() => supervisor.close());

  const startup = supervisor.start();
  await waitFor(() => requests.includes('account/read'));
  protocol.onServerRequest(7_001, 'account/chatgptAuthTokens/refresh', {
    refreshToken: 'private-refresh-token',
  });
  accountRead.resolve(managedAccountResult());
  await startup;

  assert.deepEqual(denied.map(({ id, code }) => ({ id, code })), [{ id: 7_001, code: -32601 }]);
  assert.deepEqual(observed.stale, [externalTokens]);
  assert.equal(observed.snapshots.length, 0);
  await assert.rejects(
    supervisor.reconcile(),
    (error: unknown) => error instanceof Error && error.message === externalTokens,
  );

  protocol.onNotification('account/updated', { authMode: 'chatgpt', planType: 'pro' });
  await waitFor(() => observed.snapshots.length === 1);
  assert.equal(observed.snapshots[0]?.plan, 'pro');
});

test('unsupported auth update during startup account read stays latched until a later managed update', async (t) => {
  const accountRead = deferred<unknown>();
  const observed = callbacks();
  const requests: string[] = [];
  let protocol!: AppServerClientOptions;
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocol = options;
      return deferredAccountClient(options, accountRead.promise, requests);
    },
  });
  t.after(() => supervisor.close());

  const startup = supervisor.start();
  await waitFor(() => requests.includes('account/read'));
  protocol.onNotification('account/updated', { authMode: 'headers', planType: null });
  accountRead.resolve(managedAccountResult());
  await startup;

  assert.deepEqual(observed.stale, [externalHeaders]);
  assert.equal(observed.snapshots.length, 0);
  await assert.rejects(
    supervisor.reconcile(),
    (error: unknown) => error instanceof Error && error.message === externalHeaders,
  );

  protocol.onNotification('account/updated', { authMode: 'chatgpt', planType: 'team' });
  await waitFor(() => observed.snapshots.length === 1);
  assert.equal(observed.snapshots[0]?.plan, 'team');
});

test('runs real contract verification before telemetry startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-contract-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await supervisor.start();

  const log = await calls(callLog);
  assert.equal(log[0]?.operation, 'generate-ts');
  assert.equal(log.findIndex((entry) => entry.method === 'initialize') > 0, true);
  assert.equal(observed.snapshots.length, 1);
});

test('treats rate-limit notification bursts as one full-read invalidation and ignores sparse payloads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-burst-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({
      FAKE_APP_SERVER_CALL_LOG: callLog,
      FAKE_APP_SERVER_MODE: 'telemetry-rate-burst',
    }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await supervisor.start();
  await waitFor(() => observed.snapshots.length === 2);

  const log = await calls(callLog);
  assert.equal(log.filter((entry) => entry.method === 'account/rateLimits/read').length, 3);
  assert.equal(observed.snapshots.length, 2);
  const publicData = JSON.stringify({ snapshots: observed.snapshots, stale: observed.stale });
  assert.equal(publicData.includes('private-sparse-server'), false);
  assert.equal(publicData.includes('private-sparse-installation'), false);
});

test('rate-limit invalidation during a pending read runs one trailing read for all callers', async (t) => {
  const pendingRead = deferred<unknown>();
  const observed = callbacks();
  let protocol!: AppServerClientOptions;
  let rateLimitReads = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocol = options;
      return {
        request: async <T>(method: string): Promise<T> => {
          if (method === 'initialize') return { initialized: true } as T;
          if (method === 'account/read') return managedAccountResult() as T;
          if (method === 'account/rateLimits/read') {
            rateLimitReads += 1;
            if (rateLimitReads === 1) return rateLimitsResult(10) as T;
            if (rateLimitReads === 2) return pendingRead.promise as Promise<T>;
            return rateLimitsResult(80) as T;
          }
          throw new Error('unsupported scripted request');
        },
        notify: () => {},
        respondError: () => {},
        close: async () => {},
      };
    },
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  const reconciliation = supervisor.reconcile();
  await waitFor(() => rateLimitReads === 2);
  protocol.onNotification('account/rateLimits/updated', { rateLimits: { limitId: null } });
  protocol.onNotification('account/rateLimits/updated', { rateLimits: { limitId: null } });
  protocol.onNotification('account/rateLimits/updated', { rateLimits: { limitId: null } });
  const boundary = supervisor.readAtResetBoundary(2_000);
  pendingRead.resolve(rateLimitsResult(40));

  const [reconciled, boundarySnapshot] = await Promise.all([reconciliation, boundary]);
  assert.equal(rateLimitReads, 3);
  assert.equal(reconciled.windows[0]?.usedPercent, 80);
  assert.equal(boundarySnapshot.windows[0]?.usedPercent, 80);
  assert.equal(reconciled, boundarySnapshot);
  assert.deepEqual(observed.snapshots.map((snapshot) => snapshot.windows[0]?.usedPercent), [10, 80]);
});

test('managed plan updates during a pending read coalesce one trailing read with the latest plan', async (t) => {
  const pendingRead = deferred<unknown>();
  const observed = callbacks();
  let protocol!: AppServerClientOptions;
  let rateLimitReads = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocol = options;
      return {
        request: async <T>(method: string): Promise<T> => {
          if (method === 'initialize') return { initialized: true } as T;
          if (method === 'account/read') return managedAccountResult() as T;
          if (method === 'account/rateLimits/read') {
            rateLimitReads += 1;
            if (rateLimitReads === 1) return rateLimitsResult(10) as T;
            if (rateLimitReads === 2) return pendingRead.promise as Promise<T>;
            return rateLimitsResult(90) as T;
          }
          throw new Error('unsupported scripted request');
        },
        notify: () => {},
        respondError: () => {},
        close: async () => {},
      };
    },
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  const reconciliation = supervisor.reconcile();
  await waitFor(() => rateLimitReads === 2);
  protocol.onNotification('account/updated', { authMode: 'chatgpt', planType: 'plus' });
  protocol.onNotification('account/updated', { authMode: 'chatgpt', planType: 'team' });
  const boundary = supervisor.readAtResetBoundary(2_000);
  pendingRead.resolve(rateLimitsResult(50));

  const [reconciled, boundarySnapshot] = await Promise.all([reconciliation, boundary]);
  assert.equal(rateLimitReads, 3);
  assert.equal(reconciled.plan, 'team');
  assert.equal(reconciled.windows[0]?.usedPercent, 90);
  assert.equal(boundarySnapshot.plan, 'team');
  assert.equal(boundarySnapshot.windows[0]?.usedPercent, 90);
  assert.equal(reconciled, boundarySnapshot);
  assert.deepEqual(observed.snapshots.map((snapshot) => [snapshot.plan, snapshot.windows[0]?.usedPercent]), [
    ['pro', 10],
    ['team', 90],
  ]);
});

test('unsupported auth updates stop reads until managed ChatGPT auth returns', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-auth-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({
      FAKE_APP_SERVER_CALL_LOG: callLog,
      FAKE_APP_SERVER_MODE: 'telemetry-auth-cycle',
    }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await supervisor.start();
  await waitFor(() => observed.snapshots.length === 2);

  assert.deepEqual(observed.stale, [externalHeaders]);
  assert.equal(observed.snapshots[1]?.plan, 'pro');
  const log = await calls(callLog);
  assert.equal(log.filter((entry) => entry.method === 'account/rateLimits/read').length, 2);
});

test('an external-auth update discards an older in-flight authoritative read', async (t) => {
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'telemetry-auth-during-read' }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  await waitFor(() => observed.stale.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(observed.stale, [externalHeaders]);
  assert.equal(observed.snapshots.length, 1);
  await assert.rejects(
    supervisor.reconcile(),
    (error: unknown) => error instanceof Error && error.message === externalHeaders,
  );
});

test('ignores private remote-control notifications without exposing identifiers', async (t) => {
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'telemetry-private-notification' }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const publicData = JSON.stringify({ snapshots: observed.snapshots, stale: observed.stale });
  assert.equal(observed.snapshots.length, 1);
  assert.equal(observed.stale.length, 0);
  assert.equal(publicData.includes('private-server-name'), false);
  assert.equal(publicData.includes('private-installation-id'), false);
  assert.equal(publicData.includes('private-environment-id'), false);
});

test('denies the complete server-request surface without issuing session RPCs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-denial-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({
      FAKE_APP_SERVER_CALL_LOG: callLog,
      FAKE_APP_SERVER_MODE: 'deny-server-requests',
    }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await supervisor.start();

  assert.equal(observed.snapshots.length, 0);
  assert.deepEqual(observed.stale, [externalTokens]);
  const log = await calls(callLog);
  assert.equal(log.some((entry) => /^(thread|turn)\//.test(String(entry.method))), false);
});

test('denies auth refresh, transitions to external telemetry, and drops request secrets', async (t) => {
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'telemetry-refresh-request' }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  await waitFor(() => observed.stale.length === 1);

  assert.deepEqual(observed.stale, [externalTokens]);
  const publicData = JSON.stringify({ snapshots: observed.snapshots, stale: observed.stale });
  assert.equal(publicData.includes('private-refresh-token'), false);
  assert.equal(publicData.includes('private-account-id'), false);
});

test('logged-out startup reports one exact fallback reason and performs no authoritative read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-supervisor-logged-out-'));
  const callLog = join(directory, 'calls.jsonl');
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({
      FAKE_APP_SERVER_CALL_LOG: callLog,
      FAKE_APP_SERVER_ACCOUNT_RESPONSE: JSON.stringify({ account: null, requiresOpenaiAuth: true }),
    }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });

  await supervisor.start();

  assert.deepEqual(observed.stale, [signedOut]);
  assert.equal(observed.snapshots.length, 0);
  await assert.rejects(supervisor.reconcile(), (error: unknown) => error instanceof Error && error.message === signedOut);
  const log = await calls(callLog);
  assert.equal(log.some((entry) => entry.method === 'account/rateLimits/read'), false);
});

test('malformed output, unexpected exit, malformed limits, and request timeout expose one stable error', async (t) => {
  const cases: Array<{ name: string; env: Record<string, string>; timeout?: number }> = [
    { name: 'malformed output', env: { FAKE_APP_SERVER_MODE: 'malformed', PROBE_TOKEN: 'private-malformed-token' } },
    { name: 'unexpected exit', env: { FAKE_APP_SERVER_MODE: 'crash', PROBE_TOKEN: 'private-crash-token' } },
    {
      name: 'malformed limits',
      env: { FAKE_APP_SERVER_RATE_LIMITS_RESPONSE: JSON.stringify({ rateLimits: null, rateLimitsByLimitId: null }) },
    },
    { name: 'request timeout', env: { FAKE_APP_SERVER_MODE: 'hang' }, timeout: 50 },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const observed = callbacks();
      const supervisor = new CodexAppServerSupervisor({
        runtime: runtime(entry.env),
        onSnapshot: observed.onSnapshot,
        onStale: observed.onStale,
        requestTimeoutMs: entry.timeout,
        verifyContract: async () => {},
        setTimer: () => ({ inactive: true }),
        clearTimer: () => {},
      });
      t.after(() => supervisor.close());

      await assert.rejects(
        supervisor.start(),
        (error: unknown) => error instanceof Error && error.message === unavailable,
      );
      assert.deepEqual(observed.stale, [unavailable]);
      const publicData = JSON.stringify(observed);
      assert.equal(publicData.includes('private-malformed-token'), false);
      assert.equal(publicData.includes('private-crash-token'), false);
    });
  }
});

test('one account failure leaves another account process and snapshots healthy', async (t) => {
  const healthy = callbacks();
  const broken = callbacks();
  const timers: number[] = [];
  const healthySupervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: healthy.onSnapshot,
    onStale: healthy.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
  });
  const brokenSupervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: broken.onSnapshot,
    onStale: broken.onStale,
    verifyContract: async () => {},
    clientFactory: (options) => scriptedClient(options, true),
    setTimer: (_callback, delay) => { timers.push(delay); return { delay }; },
    clearTimer: () => {},
  });
  t.after(async () => Promise.all([healthySupervisor.close(), brokenSupervisor.close()]));

  const results = await Promise.allSettled([healthySupervisor.start(), brokenSupervisor.start()]);

  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  assert.equal(healthy.snapshots.length, 1);
  assert.deepEqual(healthy.stale, []);
  assert.deepEqual(broken.stale, [unavailable]);
  assert.deepEqual(timers, [1_000]);
  assert.equal((await healthySupervisor.reconcile()).fresh, true);
});

test('uses injected bounded restart delays and calls onStale once until a read succeeds', async (t) => {
  const observed = callbacks();
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    verifyContract: async () => {},
    clientFactory: (options) => scriptedClient(options, true),
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { callback, delay };
    },
    clearTimer: () => {},
  });
  t.after(() => supervisor.close());

  await assert.rejects(supervisor.start());
  for (let index = 1; index < 6; index += 1) {
    scheduled[index - 1]!.callback();
    await waitFor(() => scheduled.length === index + 1);
  }

  assert.deepEqual(scheduled.map(({ delay }) => delay), [1_000, 2_000, 4_000, 8_000, 30_000, 30_000]);
  assert.deepEqual(observed.stale, [unavailable]);
  assert.equal(observed.snapshots.length, 0);
});

test('directly observed unsupported auth does not reset crash restart backoff', async (t) => {
  const observed = callbacks();
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const clients: ScriptedClient[] = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    verifyContract: async () => {},
    clientFactory: (options) => {
      const client: ScriptedClient = {
        request: async <T>(method: string): Promise<T> => {
          if (method === 'initialize') return { initialized: true } as T;
          if (method === 'account/read') {
            return { account: null, requiresOpenaiAuth: true } as T;
          }
          throw new Error('unsupported scripted request');
        },
        notify: () => {},
        respondError: () => {},
        close: async () => {},
        crash: () => options.onExit(new Error('private scripted crash')),
      };
      clients.push(client);
      return client;
    },
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { callback, delay };
    },
    clearTimer: () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  for (let index = 0; index < 3; index += 1) {
    clients[index]!.crash();
    await waitFor(() => scheduled.length === index + 1);
    if (index < 2) {
      scheduled[index]!.callback();
      await waitFor(() => clients.length === index + 2);
      await supervisor.start();
    }
  }

  assert.deepEqual(scheduled.map(({ delay }) => delay), [1_000, 2_000, 4_000]);
  assert.deepEqual(observed.stale, [signedOut, unavailable, signedOut, unavailable, signedOut, unavailable]);
  assert.equal(observed.snapshots.length, 0);
});

test('latched unsupported auth does not reset crash restart backoff', async (t) => {
  const observed = callbacks();
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const clients: ScriptedClient[] = [];
  const protocols: AppServerClientOptions[] = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocols.push(options);
      const client = scriptedClient(options);
      clients.push(client);
      return client;
    },
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { callback, delay };
    },
    clearTimer: () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  protocols[0]!.onServerRequest(9_002, 'account/chatgptAuthTokens/refresh', {
    refreshToken: 'private-refresh-token',
  });
  for (let index = 0; index < 3; index += 1) {
    clients[index]!.crash();
    await waitFor(() => scheduled.length === index + 1);
    if (index < 2) {
      scheduled[index]!.callback();
      await waitFor(() => clients.length === index + 2);
      await supervisor.start();
    }
  }

  assert.deepEqual(scheduled.map(({ delay }) => delay), [1_000, 2_000, 4_000]);
  assert.equal(observed.snapshots.length, 1);
  assert.equal(observed.stale.includes(externalTokens), true);
});

test('a successful restarted read resets backoff to one second', async (t) => {
  const observed = callbacks();
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const clients: ScriptedClient[] = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      const client = scriptedClient(options);
      clients.push(client);
      return client;
    },
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { callback, delay };
    },
    clearTimer: () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  clients[0]!.crash();
  await waitFor(() => scheduled.length === 1);
  scheduled[0]!.callback();
  await waitFor(() => observed.snapshots.length === 2);
  clients[1]!.crash();
  await waitFor(() => scheduled.length === 2);

  assert.deepEqual(scheduled.map(({ delay }) => delay), [1_000, 1_000]);
  assert.equal(observed.snapshots.length, 2);
  assert.deepEqual(observed.stale, [unavailable, unavailable]);
});

test('restart preserves unsupported auth until the restarted client reports a managed update', async (t) => {
  const observed = callbacks();
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const clients: ScriptedClient[] = [];
  const protocols: AppServerClientOptions[] = [];
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime(),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    verifyContract: async () => {},
    clientFactory: (options) => {
      protocols.push(options);
      const client = scriptedClient(options);
      clients.push(client);
      return client;
    },
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { callback, delay };
    },
    clearTimer: () => {},
  });
  t.after(() => supervisor.close());

  await supervisor.start();
  assert.equal(observed.snapshots.length, 1);
  protocols[0]!.onServerRequest(9_001, 'account/chatgptAuthTokens/refresh', {
    refreshToken: 'private-refresh-token',
  });
  clients[0]!.crash();
  await waitFor(() => scheduled.length === 1);
  scheduled[0]!.callback();
  await waitFor(() => clients.length === 2);
  await supervisor.start();

  assert.equal(observed.snapshots.length, 1);
  assert.equal(observed.stale.at(-1), externalTokens);
  await assert.rejects(
    supervisor.reconcile(),
    (error: unknown) => error instanceof Error && error.message === externalTokens,
  );

  protocols[1]!.onNotification('account/updated', { authMode: 'chatgpt', planType: 'team' });
  await waitFor(() => observed.snapshots.length === 2);
  assert.equal(observed.snapshots[1]?.plan, 'team');
});

test('close is bounded and idempotent even when the child ignores EOF and SIGTERM', async () => {
  const observed = callbacks();
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'ignore-eof' }),
    onSnapshot: observed.onSnapshot,
    onStale: observed.onStale,
    now: () => 1_000,
    requestTimeoutMs: 1_500,
    verifyContract: async () => {},
  });
  await supervisor.start();

  const deadline = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('supervisor close was not bounded')), 3_000);
  });
  await Promise.race([
    Promise.all([supervisor.close(), supervisor.close(), supervisor.close()]),
    deadline,
  ]);
});
