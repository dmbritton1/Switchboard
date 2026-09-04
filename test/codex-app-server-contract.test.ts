import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import {
  appServerArgs,
  CODEX_TELEMETRY_VERSION,
  type CodexAppServerMode,
  DENIED_SERVER_METHODS,
  PRIVATE_NOTIFICATIONS,
  TELEMETRY_CLIENT_METHODS,
  TELEMETRY_NOTIFICATIONS,
  telemetryAppServerArgs,
  TURN_CLIENT_METHODS,
  TURN_NOTIFICATIONS,
  verifyAppServerContract,
  verifyTelemetryContract,
} from '../src/agents/codex-app-server-contract.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...overrides,
  };
}

function runtime(overrides: Partial<PreparedCodexRuntime> = {}): PreparedCodexRuntime {
  return {
    source: 'explicit',
    commandPath: fakeCommand,
    version: '0.145.0',
    env: env(),
    diagnostics: [],
    ...overrides,
  };
}

async function launch(args: string[], launchEnv: Record<string, string>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(fakeCommand, args, { env: launchEnv, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return error !== null && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'ESRCH';
  }
}

test('the phase-one telemetry allowlist remains exactly pinned', () => {
  assert.equal(CODEX_TELEMETRY_VERSION, '0.145.0');
  assert.deepEqual(TELEMETRY_CLIENT_METHODS, [
    'initialize',
    'account/read',
    'account/rateLimits/read',
  ]);
  assert.deepEqual(TELEMETRY_NOTIFICATIONS, [
    'account/updated',
    'account/rateLimits/updated',
  ]);
  assert.deepEqual(DENIED_SERVER_METHODS, [
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
  ]);
  assert.deepEqual(PRIVATE_NOTIFICATIONS, ['remoteControl/status/changed']);

  for (const method of TELEMETRY_CLIENT_METHODS) {
    assert.equal(method.startsWith('thread/'), false);
    assert.equal(method.startsWith('turn/'), false);
    assert.equal(/account\/(?:login|logout|.*refresh|.*usage|.*credit|.*write|.*delete)/.test(method), false);
  }
});

test('the turn allowlist is pinned separately from telemetry', () => {
  assert.deepEqual(TURN_CLIENT_METHODS, [
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/interrupt',
  ]);
  assert.deepEqual(TURN_NOTIFICATIONS, [
    'error',
    'thread/started',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'turn/completed',
  ]);
  assert.deepEqual(DENIED_SERVER_METHODS, [
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
  ]);
});

test('launch profiles isolate telemetry while preserving turn hooks and MCP configuration', () => {
  assert.deepEqual(appServerArgs('telemetry'), [
    '--strict-config',
    '-c', 'hooks={}',
    '-c', 'mcp_servers={}',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ]);
  assert.deepEqual(appServerArgs('turns'), [
    '--strict-config',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ]);
  assert.deepEqual(telemetryAppServerArgs(), appServerArgs('telemetry'));
});

test('turn launch leaves inherited hooks and MCP configuration enabled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-turn-launch-'));
  const recordPath = join(directory, 'launch.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await launch(appServerArgs('turns'), env({
    FAKE_APP_SERVER_LAUNCH_RECORD: recordPath,
  })), 0);
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
    strict: true,
    configs: ['otel.exporter="none"'],
    inheritedHooks: true,
    inheritedMcpServers: true,
  });
});

test('launch rejects unknown strict configuration in both profiles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-launch-'));
  const hookMarker = join(directory, 'hook-ran');
  const mcpMarker = join(directory, 'mcp-ran');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launchEnv = env({
    FAKE_APP_SERVER_INHERITED_HOOK_MARKER: hookMarker,
    FAKE_APP_SERVER_INHERITED_MCP_MARKER: mcpMarker,
    FAKE_APP_SERVER_STRICT_CONFIG_MARKER: join(directory, 'strict-missing'),
  });

  assert.equal(await launch([
    '--strict-config',
    '-c', 'mcp_servers={}',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ], launchEnv), 2);
  assert.equal(await readFile(hookMarker, 'utf8'), 'inherited hook');

  assert.equal(await launch([
    '--strict-config',
    '-c', 'hooks={}',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ], launchEnv), 2);
  assert.equal(await readFile(mcpMarker, 'utf8'), 'inherited mcp');

  assert.equal(await launch([
    '-c', 'hooks={}',
    '-c', 'mcp_servers={}',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ], launchEnv), 2);
  assert.equal(await readFile(join(directory, 'strict-missing'), 'utf8'), 'strict config missing');

  for (const mode of ['telemetry', 'turns'] as const) {
    const args = appServerArgs(mode);
    args.splice(args.indexOf('app-server'), 0, '-c', 'unknown_option=true');
    assert.equal(await launch(args, launchEnv), 2, `${mode} must reject unknown configuration`);
  }
});

test('generated contract accepts the exact phase-one schema and reuses a verified runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-contract-'));
  const calls = join(directory, 'calls.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = runtime({ env: env({ FAKE_APP_SERVER_CALL_LOG: calls }), version: '0.145.0+cache' });

  await verifyTelemetryContract(prepared);
  await verifyTelemetryContract(prepared);

  assert.deepEqual(
    (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    [{ operation: 'generate-ts' }],
  );
});

test('profiles share generated-schema evidence but verify their surfaces separately', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-contract-profiles-'));
  const calls = join(directory, 'calls.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = runtime({
    env: env({ FAKE_APP_SERVER_CALL_LOG: calls }),
    version: '0.145.0+profile-cache',
  });

  await verifyAppServerContract(prepared, 'telemetry');
  await verifyAppServerContract(prepared, 'turns');
  await verifyAppServerContract(prepared, 'turns');

  assert.deepEqual(
    (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    [{ operation: 'generate-ts' }],
  );
});

test('turn profile rejects every missing method or notification while retaining the denied server set', async () => {
  const required = [...TURN_CLIENT_METHODS, ...TURN_NOTIFICATIONS];
  for (const [index, member] of required.entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-member-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_OMIT: member }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject missing ${member}`,
    );
  }

  for (const mode of ['telemetry', 'turns'] as const satisfies readonly CodexAppServerMode[]) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+${mode}-server-request`,
        env: env({ FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST: 'item/future/requestApproval' }),
      }), mode),
    );
  }
});

test('turn profile requires the pinned request, item, turn, usage, and routing shapes', async () => {
  for (const [index, shape] of [
    'thread-params',
    'turn-params',
    'user-input',
    'thread-items',
    'turn-status',
    'turn-error',
    'error-will-retry',
    'token-usage',
    'routing-ids',
  ].entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-shape-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT: shape }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject missing ${shape}`,
    );
  }
});

test('turn profile requires pinned thread safety aliases and config maps on start and resume', async () => {
  for (const [index, shape] of [
    'approval-never',
    'approval-alias-extra',
    'sandbox-workspace-write',
    'sandbox-alias-extra',
    'thread-start-approval-type',
    'thread-start-approval-union',
    'thread-resume-approval-type',
    'thread-resume-approval-union',
    'thread-start-sandbox-type',
    'thread-start-sandbox-union',
    'thread-resume-sandbox-type',
    'thread-resume-sandbox-union',
    'thread-start-config-type',
    'thread-start-config-union',
    'thread-resume-config-type',
    'thread-resume-config-union',
    'json-value-type',
  ].entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-safety-shape-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT: shape }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject incompatible ${shape}`,
    );
  }
});

test('turn profile keeps required input fields within their exact union members', async () => {
  for (const [index, shape] of [
    'user-input-text-union',
    'user-input-text-elements',
    'user-input-text-elements-union',
    'user-input-local-image-path',
    'user-input-local-image-path-union',
  ].entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-input-member-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT: shape }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject incompatible ${shape}`,
    );
  }
});

test('turn profile requires a typed token-usage notification payload', async () => {
  for (const [index, shape] of [
    'token-usage-payload',
    'token-usage-payload-union',
  ].entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-token-usage-payload-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT: shape }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject incompatible ${shape}`,
    );
  }
});

// Mutation caught: a substring check for `willRetry: boolean` accepts nullable,
// widened, literal-only, and longer prefixed types instead of the exact field.
test('turn profile requires an exact required willRetry boolean field', async () => {
  for (const [index, shape] of [
    'error-will-retry-optional',
    'error-will-retry-nullable',
    'error-will-retry-union',
    'error-will-retry-literals',
    'error-will-retry-no-delimiter',
  ].entries()) {
    await assert.rejects(
      verifyAppServerContract(runtime({
        version: `0.145.0+turn-will-retry-${index}`,
        env: env({ FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT: shape }),
      }), 'turns'),
      (error: unknown) => error instanceof Error
        && error.message === 'Codex app-server turn contract verification failed.',
      `turn profile should reject incompatible ${shape}`,
    );
  }
});

test('generated contract rejects an omitted required member', async () => {
  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+omitted',
      env: env({ FAKE_APP_SERVER_SCHEMA_OMIT: 'account/rateLimits/updated' }),
    })),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );
});

test('generated contract rejects a newly added server request', async () => {
  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+server-request',
      env: env({ FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST: 'item/future/requestApproval' }),
    })),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );
});

test('generated contract rejects an incompatible runtime version before generation', async () => {
  await assert.rejects(
    verifyTelemetryContract(runtime({ version: '0.146.0' })),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );
});

test('generated contract bounds schema generation time', async () => {
  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+timeout',
      env: env({ FAKE_APP_SERVER_SCHEMA_MODE: 'hang' }),
    }), { timeoutMs: 30 }),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );
});

test('generated contract reaps a generator that ignores SIGTERM after timeout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-contract-reap-'));
  const marker = join(directory, 'signals');
  const pidFile = join(directory, 'pid');
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined && !processIsGone(pid)) process.kill(pid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+ignore-term',
      env: env({
        FAKE_APP_SERVER_SCHEMA_MODE: 'ignore-term',
        FAKE_APP_SERVER_SCHEMA_EXIT_MARKER: marker,
        FAKE_APP_SERVER_SCHEMA_PID_FILE: pidFile,
      }),
    }), { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );

  await waitForFile(marker, 1_000);
  pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
  assert.equal(processIsGone(pid), true);
});

test('generated contract rejects malformed schema output', async () => {
  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+malformed',
      env: env({ FAKE_APP_SERVER_SCHEMA_MODE: 'malformed' }),
    })),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.',
  );
});

test('generated contract never exposes account values or raw stderr', async () => {
  const secret = 'contract-account-secret';
  await assert.rejects(
    verifyTelemetryContract(runtime({
      version: '0.145.0+stderr',
      env: env({ FAKE_APP_SERVER_SCHEMA_MODE: 'error', CODEX_TOKEN: secret }),
    })),
    (error: unknown) => error instanceof Error
      && error.message === 'Codex telemetry contract verification failed.'
      && !error.message.includes(secret)
      && !error.message.includes('fake schema failure'),
  );
});
