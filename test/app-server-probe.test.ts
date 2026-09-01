import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DENIED_SERVER_METHODS } from '../src/agents/codex-app-server-contract.ts';
import { normalizeCodexRateLimits } from '../src/agents/codex-limits.ts';
import { probeAppServer } from '../scripts/codex-app-server-probe.ts';
import { runCodexTelemetrySmoke } from '../scripts/codex-telemetry-smoke.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...overrides,
  };
}

async function rejectsWithin(
  promise: Promise<unknown>,
  milliseconds: number,
  validate: (error: unknown) => boolean,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('test timed out waiting for probe rejection')), milliseconds);
  });
  try {
    await assert.rejects(Promise.race([promise, deadline]), validate);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for file: ${path}`);
}

function observePending<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

async function createReadyMarker(t: { after: (fn: () => Promise<void> | void) => void }, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return join(directory, 'ready');
}

test('fake app-server proves the bounded stable lifecycle and approval surface', async () => {
  const evidence = await probeAppServer({ command: fakeCommand, env: env(), fixtureMode: true });

  assert.deepEqual(evidence, {
    version: '0.145.0',
    schemaGenerated: false,
    initialized: true,
    authStateReadable: true,
    lifecycleRoundTrip: true,
    followUpRoundTrip: true,
    resumeRoundTrip: true,
    cancellationRoundTrip: true,
    commandApprovalRoundTrip: true,
    fileApprovalRoundTrip: true,
    mcpElicitationObserved: true,
    processCrashHandled: true,
    vendorThreadMigration: 'not-proven',
    cleanShutdown: true,
  });
});

test('server request IDs remain distinct from interleaved client responses', async () => {
  const evidence = await probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_INTERLEAVE: '1' }),
    fixtureMode: true,
  });

  assert.equal(evidence.authStateReadable, true);
  assert.equal(evidence.commandApprovalRoundTrip, true);
  assert.equal(evidence.fileApprovalRoundTrip, true);
  assert.equal(evidence.mcpElicitationObserved, true);
});

test('fixture probe denies every pinned server request including auth refresh', async () => {
  const evidence = await probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_MODE: 'deny-server-requests' }),
    fixtureMode: true,
  });

  assert.equal(evidence.initialized, true);
  assert.equal(evidence.authStateReadable, true);
  assert.ok(DENIED_SERVER_METHODS.includes('account/chatgptAuthTokens/refresh'));
});

test('fixture identifiers never claim SDK vendor-thread migration', async () => {
  const evidence = await probeAppServer({ command: fakeCommand, env: env(), fixtureMode: true });

  assert.equal(evidence.vendorThreadMigration, 'not-proven');
});

test('every fixture text turn uses the complete generated UserInput shape', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-app-server-inputs-'));
  const callLog = join(dir, 'calls.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    fixtureMode: true,
  });

  const turns = (await readFile(callLog, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
    .filter((entry) => entry.method === 'turn/start');
  assert.deepEqual(turns.map((entry) => entry.params), [
    {
      threadId: 'fixture-thread',
      input: [{ type: 'text', text: 'fixture lifecycle', text_elements: [] }],
    },
    {
      threadId: 'fixture-thread',
      input: [{ type: 'text', text: 'fixture follow-up', text_elements: [] }],
    },
    {
      threadId: 'fixture-thread',
      input: [{ type: 'text', text: 'fixture interrupt', text_elements: [] }],
    },
  ]);
});

test('non-fixture evaluation generates matching types and performs no turn', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-app-server-no-turn-'));
  const callLog = join(dir, 'calls.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const evidence = await probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    fixtureMode: false,
  });

  assert.deepEqual(evidence, {
    version: '0.145.0',
    schemaGenerated: true,
    initialized: true,
    authStateReadable: true,
    lifecycleRoundTrip: false,
    followUpRoundTrip: false,
    resumeRoundTrip: false,
    cancellationRoundTrip: false,
    commandApprovalRoundTrip: false,
    fileApprovalRoundTrip: false,
    mcpElicitationObserved: false,
    processCrashHandled: false,
    vendorThreadMigration: 'not-proven',
    cleanShutdown: true,
  });
  assert.deepEqual(
    (await readFile(callLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    [
      { operation: 'generate-ts' },
      {
        method: 'initialize',
        params: {
          clientInfo: { name: 'switchboard_probe', title: 'Switchboard probe', version: '0.1.0' },
          capabilities: null,
        },
      },
      { method: 'initialized' },
      { method: 'account/read', params: { refreshToken: false } },
      { operation: 'eof' },
    ],
  );
});

test('telemetry smoke records only safe no-turn evidence for a supported account', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-telemetry-smoke-'));
  const callLog = join(dir, 'calls.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const evidence = await runCodexTelemetrySmoke({
    command: fakeCommand,
    version: '0.145.0',
    env: env({ FAKE_APP_SERVER_CALL_LOG: callLog }),
    observationMs: 20,
  });

  assert.deepEqual(evidence, {
    version: '0.145.0',
    contractMatches: true,
    safeLaunchProfile: true,
    accountKind: 'chatgpt',
    observedAuthMode: 'chatgpt',
    planVisible: false,
    usableWindows: true,
    blockState: 'none',
    resetTimestampBand: 'seconds-band',
    observedNotifications: ['account/updated'],
    noForbiddenMethods: true,
    cleanShutdown: true,
  });
  const calls = (await readFile(callLog, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method?: string; operation?: string; params?: unknown })
    .filter((entry) => entry.method !== undefined || entry.operation === 'eof');
  assert.deepEqual(calls, [
    {
      method: 'initialize',
      params: {
        clientInfo: { name: 'switchboard_telemetry_smoke', title: 'Switchboard telemetry smoke', version: '0.1.0' },
        capabilities: null,
      },
    },
    { method: 'initialized' },
    { method: 'account/read', params: { refreshToken: false } },
    { method: 'account/rateLimits/read' },
    { operation: 'eof' },
  ]);
});

test('telemetry smoke fails closed for the pinned logged-out account/read and rate-limit pair', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-telemetry-logged-out-'));
  const callLog = join(dir, 'calls.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    runCodexTelemetrySmoke({
      command: fakeCommand,
      version: '0.145.0',
      env: env({
        FAKE_APP_SERVER_CALL_LOG: callLog,
        FAKE_APP_SERVER_ACCOUNT_RESPONSE: JSON.stringify({ account: null, requiresOpenaiAuth: true }),
        FAKE_APP_SERVER_RATE_LIMITS_ERROR: JSON.stringify({
          code: -32600,
          message: 'codex account authentication required to read rate limits',
        }),
      }),
      observationMs: 0,
    }),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry smoke did not produce usable telemetry.'
      && 'evidence' in error
      && (error as Error & { evidence?: unknown }).evidence !== null
      && typeof (error as Error & { evidence?: unknown }).evidence === 'object'
      && (error as Error & { evidence: { accountKind?: unknown } }).evidence.accountKind === 'signed-out',
  );
  assert.deepEqual(
    (await readFile(callLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry: { method?: string; operation?: string }) => entry.method !== undefined || entry.operation === 'eof'),
    [
      {
        method: 'initialize',
        params: {
          clientInfo: { name: 'switchboard_telemetry_smoke', title: 'Switchboard telemetry smoke', version: '0.1.0' },
          capabilities: null,
        },
      },
      { method: 'initialized' },
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/rateLimits/read' },
      { operation: 'eof' },
    ],
  );
});

test('telemetry smoke excludes private remote-control notification canaries', async () => {
  const canaries = ['private-server-name', 'private-installation-id', 'private-environment-id'];
  const evidence = await runCodexTelemetrySmoke({
    command: fakeCommand,
    version: '0.145.0',
    env: env({ FAKE_APP_SERVER_MODE: 'telemetry-private-notification' }),
    observationMs: 25,
  });

  const encoded = JSON.stringify(evidence);
  for (const canary of canaries) assert.equal(encoded.includes(canary), false);
  assert.deepEqual(evidence.observedNotifications, ['account/updated']);
});

test('telemetry smoke fails after a valid read when the child exits during observation', async () => {
  const secret = 'terminal-exit-secret';
  await rejectsWithin(
    runCodexTelemetrySmoke({
      command: fakeCommand,
      version: '0.145.0',
      env: env({
        FAKE_APP_SERVER_MODE: 'telemetry-exit-after-rate-read',
        PROBE_TOKEN: secret,
      }),
      observationMs: 30,
    }),
    1_500,
    (error) => {
      const evidence = error instanceof Error && 'evidence' in error
        ? (error as Error & { evidence: { cleanShutdown?: unknown } }).evidence
        : null;
      return evidence?.cleanShutdown === false && !JSON.stringify(error).includes(secret);
    },
  );
});

test('telemetry smoke fails after a valid read when malformed output arrives during observation', async () => {
  const secret = 'malformed-after-read-secret';
  await rejectsWithin(
    runCodexTelemetrySmoke({
      command: fakeCommand,
      version: '0.145.0',
      env: env({
        FAKE_APP_SERVER_MODE: 'telemetry-malformed-after-rate-read',
        PROBE_TOKEN: secret,
      }),
      observationMs: 30,
    }),
    1_500,
    (error) => {
      const evidence = error instanceof Error && 'evidence' in error
        ? (error as Error & { evidence: { cleanShutdown?: unknown } }).evidence
        : null;
      return evidence?.cleanShutdown === false && !JSON.stringify(error).includes(secret);
    },
  );
});

test('telemetry smoke follows normalizer precedence for empty and unusable keyed maps', async (t) => {
  const cases = [
    { name: 'empty keyed map', keyed: {} },
    {
      name: 'unusable keyed map',
      keyed: {
        ignored: {
          limitId: 'ignored',
          limitName: null,
          primary: null,
          secondary: null,
          spendControlReached: false,
          rateLimitReachedType: null,
        },
      },
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const response = {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
          secondary: null,
          spendControlReached: false,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: fixture.keyed,
        rateLimitResetCredits: null,
      };
      const normalized = normalizeCodexRateLimits(response, null, 1_000);
      assert.equal(normalized.windows[0]?.id, 'default:primary');
      assert.equal(normalized.windows[0]?.resetsAt, 2_000_000_000_000);

      const evidence = await runCodexTelemetrySmoke({
        command: fakeCommand,
        version: '0.145.0',
        env: env({ FAKE_APP_SERVER_RATE_LIMITS_RESPONSE: JSON.stringify(response) }),
        observationMs: 0,
      });
      assert.equal(evidence.usableWindows, true);
      assert.equal(evidence.resetTimestampBand, 'seconds-band');
    });
  }
});

test('telemetry smoke denies the complete server-request fixture and emits only safe failure evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-telemetry-denial-'));
  const callLog = join(dir, 'calls.jsonl');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const privateValues = [
    'private-account@example.com',
    'private-env-secret',
    '/private/absolute/account/path',
    'private-raw-response',
    'private-stderr-output',
    'private-server-name',
    'private-installation-id',
  ];
  let serializedFailure = '';
  await rejectsWithin(
    runCodexTelemetrySmoke({
      command: fakeCommand,
      version: '0.145.0',
      env: env({
        FAKE_APP_SERVER_MODE: 'deny-server-requests',
        FAKE_APP_SERVER_CALL_LOG: callLog,
        FAKE_APP_SERVER_PRIVATE_NOTIFICATION: '1',
        FAKE_APP_SERVER_STDERR_AFTER_RATE: 'private-stderr-output',
        ACCOUNT_TOKEN: 'private-env-secret',
        FAKE_APP_SERVER_ACCOUNT_RESPONSE: JSON.stringify({
          account: {
            type: 'chatgpt',
            email: 'private-account@example.com',
            planType: 'pro',
            absolutePath: '/private/absolute/account/path',
          },
          requiresOpenaiAuth: true,
          rawResponse: 'private-raw-response',
        }),
      }),
      observationMs: 30,
    }),
    1_500,
    (error) => {
      serializedFailure = JSON.stringify(error);
      const evidence = error instanceof Error && 'evidence' in error
        ? (error as Error & { evidence: { noForbiddenMethods?: unknown } }).evidence
        : null;
      return evidence?.noForbiddenMethods === false;
    },
  );
  for (const value of privateValues) assert.equal(serializedFailure.includes(value), false);

  const expectedDeniedMethods = [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'item/permissions/requestApproval',
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'applyPatchApproval',
    'execCommandApproval',
  ];
  const responses = (await readFile(callLog, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.operation === 'server-response');
  assert.deepEqual(responses, expectedDeniedMethods.map((method) => ({
    operation: 'server-response',
    method,
    code: -32601,
    message: 'Unsupported by the Switchboard telemetry smoke client.',
  })));
});

test('telemetry smoke success evidence excludes account, process, and response canaries', async () => {
  const privateValues = [
    'private-success@example.com',
    'private-success-env',
    '/private/success/path',
    'private-success-response',
    'private-success-stderr',
    'private-server-name',
    'private-installation-id',
  ];
  const evidence = await runCodexTelemetrySmoke({
    command: fakeCommand,
    version: '0.145.0',
    env: env({
      FAKE_APP_SERVER_PRIVATE_NOTIFICATION: '1',
      FAKE_APP_SERVER_STDERR_AFTER_RATE: 'private-success-stderr',
      ACCOUNT_TOKEN: 'private-success-env',
      FAKE_APP_SERVER_ACCOUNT_RESPONSE: JSON.stringify({
        account: {
          type: 'chatgpt',
          email: 'private-success@example.com',
          planType: 'pro',
          absolutePath: '/private/success/path',
        },
        requiresOpenaiAuth: true,
        rawResponse: 'private-success-response',
      }),
    }),
    observationMs: 30,
  });
  const serialized = JSON.stringify(evidence);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});

test('schema evidence fails when any stable lifecycle notification is absent', async (t) => {
  const lifecycleNotifications = [
    'thread/started',
    'turn/started',
    'item/started',
    'item/completed',
    'turn/completed',
  ];

  for (const omitted of lifecycleNotifications) {
    await t.test(omitted, async () => {
      const evidence = await probeAppServer({
        command: fakeCommand,
        env: env({ FAKE_APP_SERVER_SCHEMA_OMIT: omitted }),
        fixtureMode: false,
      });
      assert.equal(evidence.schemaGenerated, false);
    });
  }
});

test('malformed JSON rejects safely without hanging', async (t) => {
  const ready = await createReadyMarker(t, 'switchboard-probe-malformed-');
  const probe = observePending(probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_MODE: 'malformed', FAKE_APP_SERVER_READY_MARKER: ready }),
    fixtureMode: true,
  }));
  await waitForFile(ready);
  await rejectsWithin(
    probe,
    1_500,
    (error) => error instanceof Error && /invalid JSON/i.test(error.message),
  );
});

test('an unexpected app-server exit rejects promptly without exposing stderr secrets', async (t) => {
  const secret = 'probe-secret-value';
  const ready = await createReadyMarker(t, 'switchboard-probe-crash-');
  const probe = observePending(probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_MODE: 'crash', PROBE_TOKEN: secret, FAKE_APP_SERVER_READY_MARKER: ready }),
    fixtureMode: true,
  }));
  await waitForFile(ready);
  await rejectsWithin(
    probe,
    1_500,
    (error) => error instanceof Error
      && /exited unexpectedly/i.test(error.message)
      && !error.message.includes(secret),
  );
});

test('an idle exit remains terminal between a response and the next request', async (t) => {
  const secret = 'idle-crash-secret';
  const ready = await createReadyMarker(t, 'switchboard-probe-idle-exit-');
  const probe = observePending(probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_MODE: 'crash-after-initialize', PROBE_TOKEN: secret, FAKE_APP_SERVER_READY_MARKER: ready }),
    fixtureMode: true,
  }));
  await waitForFile(ready);
  await rejectsWithin(
    probe,
    1_500,
    (error) => error instanceof Error
      && /exited unexpectedly/i.test(error.message)
      && !error.message.includes(secret),
  );
});

test('a terminal exit before notification registration is not masked as a timeout', async (t) => {
  const ready = await createReadyMarker(t, 'switchboard-probe-turn-crash-');
  const probe = observePending(probeAppServer({
    command: fakeCommand,
    env: env({ FAKE_APP_SERVER_MODE: 'crash-after-turn-response', FAKE_APP_SERVER_READY_MARKER: ready }),
    fixtureMode: true,
  }));
  await waitForFile(ready);
  await rejectsWithin(
    probe,
    1_500,
    (error) => error instanceof Error && /exited unexpectedly/i.test(error.message),
  );
});

test('a five-second request timeout terminates the child process', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-app-server-timeout-'));
  const marker = join(dir, 'terminated');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({ FAKE_APP_SERVER_MODE: 'hang', FAKE_APP_SERVER_EXIT_MARKER: marker }),
      fixtureMode: true,
    }),
    7_000,
    (error) => error instanceof Error && /timed out after 5000ms/i.test(error.message),
  );

  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      await access(marker);
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('timed-out child did not record termination');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
});

test('a child that ignores SIGTERM is reaped with SIGKILL before timeout rejection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-app-server-sigkill-'));
  const marker = join(dir, 'signals');
  const pidFile = join(dir, 'pid');
  t.after(() => rm(dir, { recursive: true, force: true }));

  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({
        FAKE_APP_SERVER_MODE: 'ignore-term',
        FAKE_APP_SERVER_EXIT_MARKER: marker,
        FAKE_APP_SERVER_PID_FILE: pidFile,
      }),
      fixtureMode: true,
    }),
    8_000,
    (error) => error instanceof Error && /timed out after 5000ms/i.test(error.message),
  );

  assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => objectErrorCode(error) === 'ESRCH',
  );
});

function objectErrorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}
