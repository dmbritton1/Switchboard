import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactValues, type PreparedCodexRuntime } from './codex-runtime.ts';

export const CODEX_TELEMETRY_VERSION = '0.145.0';
export const TELEMETRY_CLIENT_METHODS = [
  'initialize',
  'account/read',
  'account/rateLimits/read',
] as const;
export const TELEMETRY_NOTIFICATIONS = [
  'account/updated',
  'account/rateLimits/updated',
] as const;
export const DENIED_SERVER_METHODS = [
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
] as const;
export const PRIVATE_NOTIFICATIONS = [
  'remoteControl/status/changed',
] as const;

const GENERATION_TIMEOUT_MS = 10_000;
const GENERATION_TERMINATION_GRACE_MS = 250;
const VERIFIED_CONTRACTS = new Map<string, Promise<void>>();
const AUTH_MODES = [
  'apikey',
  'chatgpt',
  'chatgptAuthTokens',
  'headers',
  'agentIdentity',
  'personalAccessToken',
  'bedrockApiKey',
];
const ACCOUNT_TYPES = ['apiKey', 'chatgpt', 'amazonBedrock'];

export type ContractDeps = {
  timeoutMs?: number;
};

export function telemetryAppServerArgs(): string[] {
  return [
    '--strict-config',
    '-c', 'hooks={}',
    '-c', 'mcp_servers={}',
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ];
}

function publishedVersion(version: string): string {
  return version.split('+', 1)[0];
}

function contractError(runtime: PreparedCodexRuntime): Error {
  return new Error(redactValues('Codex telemetry contract verification failed.', Object.values(runtime.env)));
}

function sameMembers(actual: Iterable<string>, expected: readonly string[]): boolean {
  const values = [...new Set(actual)].sort();
  return values.length === expected.length && values.every((value, index) => value === [...expected].sort()[index]);
}

function methods(source: string): string[] {
  return [...source.matchAll(/"method"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function quoted(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

async function generatedFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(current: string, relative = ''): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const childRelative = join(relative, entry.name);
      const child = join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.set(childRelative, await readFile(child, 'utf8'));
    }
  }
  await walk(directory);
  return files;
}

async function generate(commandPath: string, env: Record<string, string>, directory: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timingOut = false;
    const child = spawn(commandPath, ['app-server', 'generate-ts', '--out', directory], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.resume();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let resolveClose: () => void;
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const waitForClose = (milliseconds: number): Promise<boolean> => Promise.race([
      close.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
    ]);
    const timer = setTimeout(() => {
      timingOut = true;
      void (async () => {
        child.kill('SIGTERM');
        if (!await waitForClose(GENERATION_TERMINATION_GRACE_MS)) child.kill('SIGKILL');
        await close;
        finish(new Error('schema generation timed out'));
      })();
    }, timeoutMs);
    child.once('error', () => finish(new Error('schema generation failed')));
    child.once('close', (code, signal) => {
      resolveClose();
      if (!timingOut) {
        if (code === 0 && signal === null) finish();
        else finish(new Error('schema generation failed'));
      }
    });
  });
}

function assertContract(files: Map<string, string>): void {
  const all = [...files.values()].join('\n');
  const client = files.get('ClientRequest.ts');
  const server = files.get('ServerRequest.ts');
  const notifications = files.get('ServerNotification.ts');
  const envelope = files.get('ServerNotificationEnvelope.ts');
  const account = files.get(join('v2', 'Account.ts'));
  const authMode = files.get('AuthMode.ts');
  const rateLimits = files.get(join('v2', 'GetAccountRateLimitsResponse.ts'));
  const snapshot = files.get(join('v2', 'RateLimitSnapshot.ts'));
  const updated = files.get(join('v2', 'AccountRateLimitsUpdatedNotification.ts'));
  if (!client || !server || !notifications || !envelope || !account || !authMode || !rateLimits || !snapshot || !updated) {
    throw new Error('generated schema is incomplete');
  }
  if (!TELEMETRY_CLIENT_METHODS.every((method) => methods(client).includes(method))
    || !TELEMETRY_NOTIFICATIONS.every((method) => methods(notifications).includes(method))
    || !PRIVATE_NOTIFICATIONS.every((method) => methods(notifications).includes(method))
    || !sameMembers(methods(server), DENIED_SERVER_METHODS)
    || !sameMembers([...account.matchAll(/"type"\s*:\s*"([^"]+)"/g)].map((match) => match[1]), ACCOUNT_TYPES)
    || !sameMembers(quoted(authMode), AUTH_MODES)
    || !/emittedAtMs\s*\?\s*:\s*number/.test(envelope)
    || !/usedPercent/.test(all)
    || !/windowDurationMins/.test(all)
    || !/resetsAt/.test(all)
    || !/rateLimitsByLimitId/.test(rateLimits)
    || !/rateLimitReachedType/.test(snapshot)
    || !/spendControlReached/.test(snapshot)
    || !/limitId\s*:\s*string\s*\|\s*null/.test(snapshot)
    || !/Sparse rolling rate-limit update/.test(updated)
    || !/rateLimits\s*:\s*RateLimitSnapshot/.test(updated)) {
    throw new Error('generated schema differs from the telemetry contract');
  }
}

async function verify(runtime: PreparedCodexRuntime, timeoutMs: number): Promise<void> {
  if (publishedVersion(runtime.version) !== CODEX_TELEMETRY_VERSION) throw contractError(runtime);
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-contract-'));
  try {
    await generate(runtime.commandPath, runtime.env, directory, timeoutMs);
    assertContract(await generatedFiles(directory));
  } catch {
    throw contractError(runtime);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function verifyTelemetryContract(
  runtime: PreparedCodexRuntime,
  deps: ContractDeps = {},
): Promise<void> {
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
    ? deps.timeoutMs
    : GENERATION_TIMEOUT_MS;
  const key = `${runtime.commandPath}\u0000${runtime.version}`;
  const existing = VERIFIED_CONTRACTS.get(key);
  if (existing) return existing;
  const verification = verify(runtime, timeoutMs);
  VERIFIED_CONTRACTS.set(key, verification);
  void verification.catch(() => {
    if (VERIFIED_CONTRACTS.get(key) === verification) VERIFIED_CONTRACTS.delete(key);
  });
  return verification;
}
