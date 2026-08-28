import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/agents/codex-app-server-client.ts';
import {
  DENIED_SERVER_METHODS,
  PRIVATE_NOTIFICATIONS,
  telemetryAppServerArgs,
  verifyTelemetryContract,
} from '../src/agents/codex-app-server-contract.ts';
import {
  normalizeCodexAccountRead,
  normalizeCodexRateLimits,
} from '../src/agents/codex-limits.ts';
import { prepareCodexRuntime, redactValues, type PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';

const OBSERVATION_MS = 250;
const PUBLIC_FAILURE = 'Codex telemetry smoke did not produce usable telemetry.';
const KNOWN_AUTH_MODES = new Set([
  'apikey',
  'chatgpt',
  'chatgptAuthTokens',
  'headers',
  'agentIdentity',
  'personalAccessToken',
  'bedrockApiKey',
]);

class SmokeFailure extends Error {
  readonly evidence: CodexTelemetrySmokeEvidence;

  constructor(evidence: CodexTelemetrySmokeEvidence) {
    super(PUBLIC_FAILURE);
    this.evidence = evidence;
  }
}

export type CodexTelemetrySmokeEvidence = {
  version: string;
  contractMatches: boolean;
  safeLaunchProfile: boolean;
  accountKind: 'chatgpt' | 'apiKey' | 'amazonBedrock' | 'signed-out' | 'invalid';
  observedAuthMode: string | null;
  planVisible: boolean;
  usableWindows: boolean;
  blockState: 'none' | 'resettable' | 'blocking' | 'unknown';
  resetTimestampBand: 'seconds-band' | 'milliseconds-band' | 'other' | 'none';
  observedNotifications: string[];
  noForbiddenMethods: boolean;
  cleanShutdown: boolean;
};

type SmokeOptions = {
  command?: string;
  version?: string;
  env?: Record<string, string>;
  runtime?: PreparedCodexRuntime;
  observationMs?: number;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}

function accountKind(input: unknown): CodexTelemetrySmokeEvidence['accountKind'] {
  const response = object(input);
  if (!response || !('account' in response)) return 'invalid';
  if (response.account === null) return 'signed-out';
  const account = object(response.account);
  switch (account?.type) {
    case 'chatgpt':
    case 'apiKey':
    case 'amazonBedrock':
      return account.type;
    default:
      return 'invalid';
  }
}

function resetTimestampBand(input: unknown): CodexTelemetrySmokeEvidence['resetTimestampBand'] {
  const response = object(input);
  const buckets = object(response?.rateLimitsByLimitId)
    ? Object.values(response!.rateLimitsByLimitId as Record<string, unknown>)
    : [response?.rateLimits];
  const values = buckets.flatMap((bucket) => {
    const parsed = object(bucket);
    return [parsed?.primary, parsed?.secondary]
      .map((window) => object(window)?.resetsAt)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  });
  const value = values[0];
  if (value === undefined) return 'none';
  if (value >= 1e9 && value < 1e11) return 'seconds-band';
  if (value >= 1e11 && value < 1e14) return 'milliseconds-band';
  return 'other';
}

function unavailableEvidence(runtime: PreparedCodexRuntime): CodexTelemetrySmokeEvidence {
  return {
    version: runtime.version,
    contractMatches: false,
    safeLaunchProfile: true,
    accountKind: 'invalid',
    observedAuthMode: null,
    planVisible: false,
    usableWindows: false,
    blockState: 'unknown',
    resetTimestampBand: 'none',
    observedNotifications: [],
    noForbiddenMethods: true,
    cleanShutdown: false,
  };
}

function testRuntime(options: SmokeOptions): PreparedCodexRuntime {
  if (options.runtime) return options.runtime;
  if (typeof options.command !== 'string' || typeof options.version !== 'string' || !options.env) {
    throw new Error(PUBLIC_FAILURE);
  }
  return {
    source: 'explicit',
    commandPath: options.command,
    version: options.version,
    env: options.env,
    diagnostics: [],
  };
}

export async function runCodexTelemetrySmoke(options: SmokeOptions): Promise<CodexTelemetrySmokeEvidence> {
  const runtime = testRuntime(options);
  let client: AppServerClient | null = null;
  let cleanShutdown = false;
  let forbidden = false;
  let observedAuthMode: string | null = null;
  const observedNotifications = new Set<string>();
  const evidence = unavailableEvidence(runtime);
  try {
    await verifyTelemetryContract(runtime);
    evidence.contractMatches = true;
    client = new AppServerClient({
      command: runtime.commandPath,
      args: telemetryAppServerArgs(),
      env: runtime.env,
      redact: (text) => redactValues(text, Object.values(runtime.env)),
      onNotification: (method, params) => {
        if ((PRIVATE_NOTIFICATIONS as readonly string[]).includes(method)) return;
        if (method === 'account/updated' || method === 'account/rateLimits/updated') {
          observedNotifications.add(method);
        }
        const update = object(params);
        if (method === 'account/updated' && typeof update?.authMode === 'string'
          && KNOWN_AUTH_MODES.has(update.authMode)) {
          observedAuthMode = update.authMode;
        }
      },
      onServerRequest: (id, method) => {
        forbidden = true;
        client?.respondError(
          id,
          -32601,
          (DENIED_SERVER_METHODS as readonly string[]).includes(method)
            ? 'Unsupported by the Switchboard telemetry smoke client.'
            : 'Unknown to the Switchboard telemetry smoke client.',
        );
      },
      onExit: () => {},
    });
    await client.request('initialize', {
      clientInfo: {
        name: 'switchboard_telemetry_smoke',
        title: 'Switchboard telemetry smoke',
        version: '0.1.0',
      },
      capabilities: null,
    });
    client.notify('initialized');
    const accountInput = await client.request('account/read', { refreshToken: false });
    const kind = accountKind(accountInput);
    evidence.accountKind = kind;
    let rateLimitInput: unknown = null;
    try {
      rateLimitInput = await client.request('account/rateLimits/read');
    } catch {
      // The evidence deliberately withholds provider diagnostics and raw errors.
    }
    const auth = (() => {
      try {
        return normalizeCodexAccountRead(accountInput);
      } catch {
        return null;
      }
    })();
    const snapshot = auth?.supported && rateLimitInput !== null
      ? (() => {
        try {
          return normalizeCodexRateLimits(rateLimitInput, auth.plan);
        } catch {
          return null;
        }
      })()
      : null;
    const wait = typeof options.observationMs === 'number'
      ? Math.max(0, Math.min(options.observationMs, OBSERVATION_MS))
      : OBSERVATION_MS;
    if (wait > 0) await delay(wait);
    await client.close();
    cleanShutdown = true;
    evidence.observedAuthMode = observedAuthMode;
    evidence.planVisible = snapshot?.plan !== null && snapshot?.plan !== undefined;
    evidence.usableWindows = Boolean(snapshot && snapshot.windows.length > 0);
    evidence.blockState = !snapshot
        ? 'unknown'
        : snapshot.blocks.length === 0
          ? 'none'
          : snapshot.blocks.every((block) => block.resettable)
            ? 'resettable'
            : 'blocking',
    evidence.resetTimestampBand = resetTimestampBand(rateLimitInput);
    evidence.observedNotifications = [...observedNotifications].sort();
    evidence.noForbiddenMethods = !forbidden;
    evidence.cleanShutdown = cleanShutdown;
    if (!auth?.supported || !evidence.usableWindows || !evidence.noForbiddenMethods || !evidence.cleanShutdown) {
      throw new SmokeFailure(evidence);
    }
    return evidence;
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure(evidence);
  } finally {
    if (client && !cleanShutdown) {
      try {
        await client.close();
        evidence.cleanShutdown = true;
      } catch {
        // A failed close remains a failed smoke without surfacing private diagnostics.
      }
    }
  }
}

type Account = { provider?: unknown; bin?: unknown; env?: unknown };

async function configuredRuntime(): Promise<PreparedCodexRuntime> {
  let accounts: Account[];
  try {
    const parsed = JSON.parse(await readFile(new URL('../accounts.json', import.meta.url), 'utf8')) as unknown;
    accounts = Array.isArray(parsed) ? parsed as Account[] : [];
  } catch {
    throw new Error(PUBLIC_FAILURE);
  }
  const account = accounts.find((candidate) => candidate.provider === 'codex');
  const env = object(account?.env);
  if (!account || !env || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new Error(PUBLIC_FAILURE);
  }
  return prepareCodexRuntime({
    ...(typeof account.bin === 'string' ? { bin: account.bin } : {}),
    env: env as Record<string, string>,
  });
}

async function evaluate(): Promise<void> {
  try {
    const evidence = await runCodexTelemetrySmoke({ runtime: await configuredRuntime() });
    console.log(JSON.stringify(evidence));
  } catch (error) {
    const evidence = error instanceof SmokeFailure ? error.evidence : null;
    console.log(JSON.stringify(evidence ? { ...evidence, ok: false } : { ok: false, error: PUBLIC_FAILURE }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await evaluate();
