import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DENIED_SERVER_METHODS } from '../src/agents/codex-app-server-contract.ts';
import { probeAppServer } from '../scripts/codex-app-server-probe.ts';

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

test('malformed JSON rejects safely without hanging', async () => {
  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({ FAKE_APP_SERVER_MODE: 'malformed' }),
      fixtureMode: true,
    }),
    1_500,
    (error) => error instanceof Error && /invalid JSON/i.test(error.message),
  );
});

test('an unexpected app-server exit rejects promptly without exposing stderr secrets', async () => {
  const secret = 'probe-secret-value';
  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({ FAKE_APP_SERVER_MODE: 'crash', PROBE_TOKEN: secret }),
      fixtureMode: true,
    }),
    1_500,
    (error) => error instanceof Error
      && /exited unexpectedly/i.test(error.message)
      && !error.message.includes(secret),
  );
});

test('an idle exit remains terminal between a response and the next request', async () => {
  const secret = 'idle-crash-secret';
  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({ FAKE_APP_SERVER_MODE: 'crash-after-initialize', PROBE_TOKEN: secret }),
      fixtureMode: true,
    }),
    1_500,
    (error) => error instanceof Error
      && /exited unexpectedly/i.test(error.message)
      && !error.message.includes(secret),
  );
});

test('a terminal exit before notification registration is not masked as a timeout', async () => {
  await rejectsWithin(
    probeAppServer({
      command: fakeCommand,
      env: env({ FAKE_APP_SERVER_MODE: 'crash-after-turn-response' }),
      fixtureMode: true,
    }),
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
