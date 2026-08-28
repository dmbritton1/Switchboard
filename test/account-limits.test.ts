import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountLimitCoordinator, type CodexSupervisorFactory } from '../src/account-limits.ts';
import { CODEX_TELEMETRY_REASONS } from '../src/agents/codex-limits.ts';
import { Usage } from '../src/usage.ts';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import type { AccountLimitSnapshot } from '../src/types.ts';

const accounts = [
  { name: 'claude', provider: 'claude' as const, budget: 1_000, env: { CLAUDE_TOKEN: 'claude-secret-value' } },
  { name: 'codex-one', provider: 'codex' as const, budget: 1_000, env: { CODEX_TOKEN: 'codex-secret-value' } },
  { name: 'codex-two', provider: 'codex' as const, budget: 1_000, env: {} },
];

function snapshot(overrides: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot {
  return {
    plan: 'pro',
    windows: [{
      id: '5h', label: '5h', usedPercent: 100, windowDurationMins: 300,
      resetsAt: 2_000, reached: true,
    }],
    blocks: [], fetchedAt: 1_000, authoritative: true, fresh: true,
    ...overrides,
  };
}

function availableSnapshot(overrides: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot {
  return snapshot({
    windows: [{
      id: '5h', label: '5h', usedPercent: 10, windowDurationMins: 300,
      resetsAt: 3_000, reached: false,
    }],
    ...overrides,
  });
}

function runtime(): PreparedCodexRuntime {
  return {
    source: 'explicit', commandPath: '/fake/codex', version: '0.145.0', env: {}, diagnostics: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for a coordinator read');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

type FakeSupervisor = {
  reconcile(): Promise<AccountLimitSnapshot>;
  readAtResetBoundary(now?: number): Promise<AccountLimitSnapshot>;
  close(): Promise<void>;
};

function supervisorFactory(
  created: string[],
  reads: string[],
  closed: string[],
  read: (account: string, boundary: boolean) => Promise<AccountLimitSnapshot>,
): CodexSupervisorFactory {
  return ({ account, onSnapshot }) => {
    created.push(account.name);
    const run = async (boundary: boolean) => {
      const value = await read(account.name, boundary);
      onSnapshot(value);
      return value;
    };
    return {
      reconcile: () => run(false),
      readAtResetBoundary: () => run(true),
      close: async () => { closed.push(account.name); },
    } as FakeSupervisor;
  };
}

test('owns one supervisor per Codex account, retains Claude probes, isolates failures, and closes every child', async () => {
  const usage = new Usage();
  const created: string[] = [];
  const reads: string[] = [];
  const closed: string[] = [];
  const probes: string[] = [];
  let changes = 0;
  const coordinator = createAccountLimitCoordinator({
    accounts,
    usage,
    onChange: () => { changes += 1; },
    prepareCodex: async () => runtime(),
    probeClaude: async (env) => {
      probes.push(env.CLAUDE_TOKEN ?? '');
      throw new Error(`private ${env.CLAUDE_TOKEN} at /private/probe`);
    },
    supervisorFactory: supervisorFactory(created, reads, closed, async (account) => {
      reads.push(account);
      if (account === 'codex-one') throw new Error('unavailable');
      return snapshot({ windows: [{
        id: '5h', label: '5h', usedPercent: 20, windowDurationMins: 300,
        resetsAt: 2_000, reached: false,
      }] });
    }),
  });

  await coordinator.start();

  assert.deepEqual(created.sort(), ['codex-one', 'codex-two']);
  assert.deepEqual(reads.sort(), ['codex-one', 'codex-two']);
  assert.deepEqual(probes, ['claude-secret-value']);
  assert.equal(usage.getLimitSnapshot('codex-two').snapshot?.windows[0].usedPercent, 20);
  assert.equal(usage.getLimitSnapshot('claude').error, 'Unable to refresh account limits. Check that this account is signed in.');
  assert.equal(JSON.stringify(usage.getLimitSnapshot('claude')).includes('claude-secret-value'), false);
  assert.equal(JSON.stringify(usage.getLimitSnapshot('claude')).includes('/private/probe'), false);
  assert.equal(changes, 1, 'one reconciliation pass emits one browser update');

  await coordinator.close();
  assert.deepEqual(closed.sort(), ['codex-one', 'codex-two']);
});

test('does not create a supervisor for zero or Claude-only account sets', async () => {
  for (const configured of [[], [accounts[0]]]) {
    const created: string[] = [];
    const coordinator = createAccountLimitCoordinator({
      accounts: configured,
      usage: new Usage(),
      onChange: () => {},
      probeClaude: async () => snapshot(),
      supervisorFactory: supervisorFactory(created, [], [], async () => snapshot()),
    });
    await coordinator.start();
    assert.deepEqual(created, []);
    await coordinator.close();
  }
});

test('starts Claude probes and Codex supervisors concurrently, then publishes one completed pass', async () => {
  const claudeRead = deferred<AccountLimitSnapshot>();
  const codexRead = deferred<AccountLimitSnapshot>();
  const begun: string[] = [];
  let changes = 0;
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[0], accounts[1]], usage: new Usage(), onChange: () => { changes += 1; },
    prepareCodex: async () => runtime(),
    probeClaude: async () => { begun.push('claude'); return claudeRead.promise; },
    supervisorFactory: supervisorFactory([], [], [], async () => {
      begun.push('codex');
      return codexRead.promise;
    }),
  });
  const pass = coordinator.start();
  await waitFor(() => begun.length === 2);
  assert.deepEqual(begun.sort(), ['claude', 'codex']);
  assert.equal(changes, 0, 'the browser update waits for the entire pass');
  claudeRead.resolve(availableSnapshot());
  codexRead.resolve(availableSnapshot());
  await pass;
  assert.equal(changes, 1);
  await coordinator.close();
});

test('coalesces overlapping concurrent reconciliation passes and signals one change after siblings settle', async () => {
  const usage = new Usage();
  const first = deferred<AccountLimitSnapshot>();
  let reads = 0;
  let changes = 0;
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => { changes += 1; },
    prepareCodex: async () => runtime(),
    supervisorFactory: supervisorFactory([], [], [], async () => {
      reads += 1;
      return first.promise;
    }),
  });

  const one = coordinator.reconcile();
  const two = coordinator.reconcile();
  await waitFor(() => reads === 1);
  assert.equal(reads, 1, 'one in-flight pass must own the account read');
  first.resolve(snapshot({ windows: [{
    id: '5h', label: '5h', usedPercent: 30, windowDurationMins: 300, resetsAt: 2_000, reached: false,
  }] }));
  await Promise.all([one, two]);
  assert.equal(changes, 1);
  await coordinator.close();
});

test('publishes supervisor snapshot and stale callbacks immediately outside reconciliation', async () => {
  const usage = new Usage();
  let changes = 0;
  let onSnapshot!: (value: AccountLimitSnapshot) => void;
  let onStale!: (reason: string) => void;
  const factory: CodexSupervisorFactory = (options) => {
    onSnapshot = options.onSnapshot;
    onStale = options.onStale;
    return {
      reconcile: async () => availableSnapshot(),
      readAtResetBoundary: async () => availableSnapshot(),
      close: async () => {},
    };
  };
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => { changes += 1; },
    prepareCodex: async () => runtime(), supervisorFactory: factory,
  });
  await coordinator.start();
  assert.equal(changes, 1);

  onSnapshot(availableSnapshot({ plan: 'team' }));
  assert.equal(changes, 2, 'an unsolicited provider snapshot must reach SSE immediately');
  assert.equal(usage.getLimitSnapshot('codex-one').snapshot?.plan, 'team');

  onStale(CODEX_TELEMETRY_REASONS.apiKey);
  assert.equal(changes, 3, 'an unsolicited stale transition must reach SSE immediately');
  assert.equal(usage.getLimitSnapshot('codex-one').error, CODEX_TELEMETRY_REASONS.apiKey);
  await coordinator.close();
});

test('coalesces supervisor snapshot and stale callbacks to one notification during reconciliation', async () => {
  const usage = new Usage();
  let changes = 0;
  const gate = deferred<AccountLimitSnapshot>();
  let onSnapshot!: (value: AccountLimitSnapshot) => void;
  let onStale!: (reason: string) => void;
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => { changes += 1; },
    prepareCodex: async () => runtime(),
    supervisorFactory: (options) => {
      onSnapshot = options.onSnapshot;
      onStale = options.onStale;
      return {
        reconcile: () => gate.promise,
        readAtResetBoundary: async () => availableSnapshot(),
        close: async () => {},
      };
    },
  });
  const pass = coordinator.start();
  await waitFor(() => typeof onSnapshot === 'function');
  onSnapshot(availableSnapshot());
  onStale(CODEX_TELEMETRY_REASONS.signedOut);
  assert.equal(changes, 0);
  gate.resolve(availableSnapshot());
  await pass;
  assert.equal(changes, 1);
  await coordinator.close();
});

test('rejects Claude and unknown accounts from Codex-only reset APIs', async () => {
  const coordinator = createAccountLimitCoordinator({ accounts, usage: new Usage(), onChange: () => {} });
  assert.throws(() => coordinator.codexResetEligibility('claude'), /Codex account/);
  assert.throws(() => coordinator.codexResetEligibility('missing'), /Codex account/);
  await assert.rejects(coordinator.releaseCodexAfterFreshRead('claude'), /Codex account/);
  await assert.rejects(coordinator.releaseCodexAfterFreshRead('missing'), /Codex account/);
  await coordinator.close();
});

test('does not read before a known future Codex reset boundary, then releases only after a clean authoritative read', async () => {
  const usage = new Usage();
  usage.setLimitSnapshot('codex-one', snapshot());
  let reads = 0;
  let now = 1_000;
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => {}, now: () => now,
    prepareCodex: async () => runtime(),
    supervisorFactory: supervisorFactory([], [], [], async () => {
      reads += 1;
      return snapshot({ windows: [{
        id: '5h', label: '5h', usedPercent: 10, windowDurationMins: 300, resetsAt: 3_000, reached: false,
      }] });
    }),
  });

  assert.deepEqual(await coordinator.releaseCodexAfterFreshRead('codex-one'), {
    ready: false, reason: 'Codex reset boundary has not arrived.',
  });
  assert.equal(reads, 0);

  now = 2_000;
  assert.deepEqual(await coordinator.releaseCodexAfterFreshRead('codex-one'), {
    ready: true, reason: 'Codex account limits are available.',
  });
  assert.equal(reads, 1);
  await coordinator.close();
});

test('forces a boundary read when the current Codex snapshot is absent or stale', async () => {
  for (const current of [null, snapshot({ fresh: false })]) {
    const usage = new Usage();
    if (current) usage.setLimitSnapshot('codex-one', current);
    let reads = 0;
    const coordinator = createAccountLimitCoordinator({
      accounts: [accounts[1]], usage, onChange: () => {}, prepareCodex: async () => runtime(),
      supervisorFactory: supervisorFactory([], [], [], async () => {
        reads += 1;
        return availableSnapshot();
      }),
    });
    assert.deepEqual(await coordinator.releaseCodexAfterFreshRead('codex-one', 2_000), {
      ready: true, reason: 'Codex account limits are available.',
    });
    assert.equal(reads, 1);
    await coordinator.close();
  }
});

test('coalesces boundary reads and blocks timeout, failed, unsupported, malformed, non-resettable, and indeterminate results', async () => {
  const usage = new Usage();
  const pending = deferred<AccountLimitSnapshot>();
  let reads = 0;
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => {}, boundaryTimeoutMs: 5,
    prepareCodex: async () => runtime(),
    supervisorFactory: supervisorFactory([], [], [], async () => {
      reads += 1;
      return pending.promise;
    }),
  });

  const one = coordinator.releaseCodexAfterFreshRead('codex-one', 2_000);
  const two = coordinator.releaseCodexAfterFreshRead('codex-one', 2_000);
  assert.deepEqual(await one, { ready: false, reason: 'Timed out waiting for a fresh Codex limit read.' });
  assert.deepEqual(await two, { ready: false, reason: 'Timed out waiting for a fresh Codex limit read.' });
  assert.equal(reads, 1);
  pending.reject(new Error('late rejected provider read'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await coordinator.close();
});

test('blocks a fresh snapshot that has a block, a reached window without a future reset, or stale data', async () => {
  const cases = [
    snapshot({ blocks: [{ id: 'default', reason: 'spend_control_reached', resettable: false }] }),
    snapshot({ windows: [{ id: '5h', label: '5h', usedPercent: 100, windowDurationMins: 300, resetsAt: null, reached: true }] }),
    snapshot({ fresh: false }),
  ];
  for (const value of cases) {
    const coordinator = createAccountLimitCoordinator({
      accounts: [accounts[1]], usage: new Usage(), onChange: () => {},
      prepareCodex: async () => runtime(),
      supervisorFactory: supervisorFactory([], [], [], async () => value),
    });
    const result = await coordinator.releaseCodexAfterFreshRead('codex-one', 2_000);
    assert.equal(result.ready, false);
    await coordinator.close();
  }
});

test('blocks failed, unsupported, and malformed boundary reads without exposing provider diagnostics', async () => {
  const responses: Array<{ read: () => Promise<AccountLimitSnapshot>; expected: string }> = [
    {
      read: async () => { throw new Error('provider failed at /private/path with codex-secret-value'); },
      expected: 'Codex account telemetry is temporarily unavailable. Using the local estimate.',
    },
    {
      read: async () => { throw new Error(CODEX_TELEMETRY_REASONS.apiKey); },
      expected: CODEX_TELEMETRY_REASONS.apiKey,
    },
    {
      read: async () => null as unknown as AccountLimitSnapshot,
      expected: 'Codex account telemetry is temporarily unavailable. Using the local estimate.',
    },
  ];
  for (const { read, expected } of responses) {
    const usage = new Usage();
    const coordinator = createAccountLimitCoordinator({
      accounts: [accounts[1]], usage, onChange: () => {}, prepareCodex: async () => runtime(),
      supervisorFactory: supervisorFactory([], [], [], async () => read()),
    });
    const result = await coordinator.releaseCodexAfterFreshRead('codex-one', 2_000);
    assert.equal(result.ready, false);
    assert.equal(usage.getLimitSnapshot('codex-one').error, expected);
    assert.equal(JSON.stringify(usage.getLimitSnapshot('codex-one')).includes('/private/path'), false);
    assert.equal(JSON.stringify(usage.getLimitSnapshot('codex-one')).includes('codex-secret-value'), false);
    await coordinator.close();
  }
});

test('preserves every known stable unsupported-auth reason', async () => {
  const expectedKeys = [
    'apiKey',
    'bedrock',
    'signedOut',
    'externalTokens',
    'headers',
    'identity',
    'personalAccessToken',
  ] as const;
  assert.deepEqual(Object.keys(CODEX_TELEMETRY_REASONS).sort(), [...expectedKeys].sort());

  for (const key of expectedKeys) {
    const reason = CODEX_TELEMETRY_REASONS[key];
    const usage = new Usage();
    const coordinator = createAccountLimitCoordinator({
      accounts: [accounts[1]], usage, onChange: () => {}, prepareCodex: async () => runtime(),
      supervisorFactory: supervisorFactory([], [], [], async () => { throw new Error(reason); }),
    });
    assert.equal((await coordinator.releaseCodexAfterFreshRead('codex-one')).ready, false);
    assert.equal(usage.getLimitSnapshot('codex-one').error, reason);
    await coordinator.close();
  }

  const usage = new Usage();
  const coordinator = createAccountLimitCoordinator({
    accounts: [accounts[1]], usage, onChange: () => {}, prepareCodex: async () => runtime(),
    supervisorFactory: supervisorFactory([], [], [], async () => {
      throw new Error(`hostile /private/provider ${accounts[1].env.CODEX_TOKEN}`);
    }),
  });
  await coordinator.releaseCodexAfterFreshRead('codex-one');
  assert.equal(usage.getLimitSnapshot('codex-one').error, 'Codex account telemetry is temporarily unavailable. Using the local estimate.');
  await coordinator.close();
});

test('fails closed on empty or malformed normalized windows', async () => {
  const malformed: AccountLimitSnapshot[] = [
    availableSnapshot({ windows: [] }),
    availableSnapshot({ windows: [{
      id: '', label: '5h', usedPercent: 10, windowDurationMins: 300, resetsAt: 3_000, reached: false,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '', usedPercent: 10, windowDurationMins: 300, resetsAt: 3_000, reached: false,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '5h', usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: 3_000, reached: false,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '5h', usedPercent: 10, windowDurationMins: -1, resetsAt: 3_000, reached: false,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '5h', usedPercent: 10, windowDurationMins: 300, resetsAt: Number.NaN, reached: false,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '5h', usedPercent: 10, windowDurationMins: 300, resetsAt: 3_000,
      reached: 'no' as unknown as boolean,
    }] }),
    availableSnapshot({ windows: [{
      id: '5h', label: '5h', usedPercent: 100, windowDurationMins: 300, resetsAt: 3_000, reached: false,
    }] }),
  ];
  for (const value of malformed) {
    const coordinator = createAccountLimitCoordinator({
      accounts: [accounts[1]], usage: new Usage(), onChange: () => {}, prepareCodex: async () => runtime(),
      supervisorFactory: supervisorFactory([], [], [], async () => value),
    });
    assert.equal((await coordinator.releaseCodexAfterFreshRead('codex-one')).ready, false);
    await coordinator.close();
  }
});
