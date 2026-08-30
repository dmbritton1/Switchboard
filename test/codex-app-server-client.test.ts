import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/agents/codex-app-server-client.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...overrides,
  };
}

function clientFor(options: {
  mode?: string;
  requestTimeoutMs?: number;
  overrides?: Record<string, string>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (id: string | number, method: string, params: unknown) => void;
  onExit?: (error: Error) => void;
} = {}): AppServerClient {
  return new AppServerClient({
    command: fakeCommand,
    args: [],
    env: env({
      ...(options.mode ? { FAKE_APP_SERVER_MODE: options.mode } : {}),
      ...options.overrides,
    }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    redact: (text) => text.replaceAll('client-secret-value', '[redacted]'),
    onNotification: options.onNotification ?? (() => {}),
    onServerRequest: options.onServerRequest ?? (() => {}),
    onExit: options.onExit ?? (() => {}),
  });
}

async function rejectsWithin(
  promise: Promise<unknown>,
  milliseconds: number,
  validate: (error: unknown) => boolean,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('test timed out waiting for client rejection')), milliseconds);
  });
  try {
    await assert.rejects(Promise.race([promise, deadline]), validate);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
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

async function waitForMarker(path: string, expectedContent: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, 'utf8');
      assert.equal(content, expectedContent);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  // On timeout, try to read one more time to get a better error message
  try {
    const content = await readFile(path, 'utf8');
    assert.equal(content, expectedContent);
  } catch (error) {
    throw new Error(`marker file assertion failed after ${timeoutMs}ms: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test('correlates out-of-order responses while delivering notifications and colliding server requests', async (t) => {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: Array<{ id: string | number; method: string; params: unknown }> = [];
  let client: AppServerClient;
  client = clientFor({
    mode: 'client-correlation',
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: (id, method, params) => {
      requests.push({ id, method, params });
      client.respondError(id, -32601, 'Unsupported by this client.');
    },
  });
  t.after(() => client.close());

  assert.deepEqual(await client.request('initialize', { purpose: 'test' }), { initialized: true });
  const [first, second] = await Promise.all([
    client.request('client/first', { value: 1 }),
    client.request('client/second', { value: 2 }),
  ]);

  assert.deepEqual(first, { response: 'first' });
  assert.deepEqual(second, { response: 'second' });
  assert.deepEqual(notifications, [{ method: 'fixture/notice', params: { delivered: true } }]);
  assert.deepEqual(requests, [
    { id: 1, method: 'fixture/numeric-server-request', params: { source: 'server' } },
    { id: 'server-1', method: 'fixture/string-server-request', params: { source: 'server' } },
  ]);
});

test('rejects malformed JSON without exposing the output secret', async (t) => {
  const exits: Error[] = [];
  const client = clientFor({
    mode: 'malformed',
    overrides: { PROBE_TOKEN: 'client-secret-value' },
    onExit: (error) => exits.push(error),
  });
  t.after(() => client.close());

  await rejectsWithin(
    client.request('initialize'),
    1_500,
    (error) => error instanceof Error && /invalid JSON/i.test(error.message) && !error.message.includes('client-secret-value'),
  );
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.message.includes('client-secret-value'), false);
});

test('rejects an unknown response ID', async (t) => {
  const client = clientFor({ mode: 'unknown-response' });
  t.after(() => client.close());

  await rejectsWithin(
    client.request('initialize'),
    1_500,
    (error) => error instanceof Error && /unknown response id/i.test(error.message),
  );
});

test('settles a request when its input write fails', async (t) => {
  const client = clientFor({ mode: 'write-failure' });
  t.after(() => client.close());

  await rejectsWithin(
    client.request('initialize'),
    1_500,
    (error) => error instanceof Error && /input closed unexpectedly|exited unexpectedly/i.test(error.message),
  );
});

test('times out a request and terminates the child', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-client-timeout-'));
  const marker = join(directory, 'terminated');
  const pidFile = join(directory, 'pid');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const client = clientFor({
    mode: 'hang',
    requestTimeoutMs: 300,
    overrides: {
      FAKE_APP_SERVER_EXIT_MARKER: marker,
      FAKE_APP_SERVER_PID_FILE: pidFile,
    },
  });
  t.after(() => client.close());

  await waitForFile(pidFile);
  await rejectsWithin(
    client.request('initialize'),
    2_000,
    (error) => error instanceof Error && /initialize timed out after 300ms/i.test(error.message),
  );
  await waitForMarker(marker, 'SIGTERM');
});

test('rejects a pending request when the child exits without exposing stderr', async (t) => {
  const exits: Error[] = [];
  const client = clientFor({
    mode: 'crash',
    overrides: { PROBE_TOKEN: 'client-secret-value' },
    onExit: (error) => exits.push(error),
  });
  t.after(() => client.close());

  await rejectsWithin(
    client.request('initialize'),
    1_500,
    (error) => error instanceof Error && /exited unexpectedly/i.test(error.message) && !error.message.includes('client-secret-value'),
  );
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.message.includes('client-secret-value'), false);
});

test('escalates SIGTERM to SIGKILL before a timed-out request settles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-client-sigkill-'));
  const marker = join(directory, 'signals');
  const pidFile = join(directory, 'pid');
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const client = clientFor({
    mode: 'ignore-term',
    requestTimeoutMs: 300,
    overrides: {
      FAKE_APP_SERVER_EXIT_MARKER: marker,
      FAKE_APP_SERVER_PID_FILE: pidFile,
    },
  });
  t.after(() => client.close());

  await waitForFile(pidFile);
  await rejectsWithin(
    client.request('initialize'),
    2_000,
    (error) => error instanceof Error && /initialize timed out after 300ms/i.test(error.message),
  );
  await waitForMarker(marker, 'SIGTERM');
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => objectErrorCode(error) === 'ESRCH',
  );
});

test('close is idempotent', async () => {
  const client = clientFor();
  await Promise.all([client.close(), client.close(), client.close()]);
});

test('close settles a pending request when the child exits cleanly', async (t) => {
  const exits: Error[] = [];
  const client = clientFor({
    mode: 'pending-until-eof',
    requestTimeoutMs: 1_000,
    overrides: { PROBE_TOKEN: 'client-secret-value' },
    onExit: (error) => exits.push(error),
  });
  t.after(() => client.close());

  const pending = client.request('initialize');
  const rejected = rejectsWithin(
    pending,
    250,
    (error) => error instanceof Error
      && /closed|terminated/i.test(error.message)
      && !error.message.includes('client-secret-value'),
  );
  await client.close();
  await rejected;
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.message.includes('client-secret-value'), false);
});

test('multiple racing terminal signals settle a pending request and callback exactly once', async (t) => {
  const exits: Error[] = [];
  const client = clientFor({ mode: 'malformed-and-exit', onExit: (error) => exits.push(error) });
  t.after(() => client.close());

  await rejectsWithin(
    client.request('initialize'),
    1_500,
    (error) => error instanceof Error && /invalid JSON|exited unexpectedly/i.test(error.message),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(exits.length, 1);
});

function objectErrorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}
