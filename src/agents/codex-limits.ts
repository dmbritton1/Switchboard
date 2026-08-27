import type {
  AccountLimitBlock,
  AccountLimitBlockReason,
  AccountLimitSnapshot,
  AccountLimitWindow,
} from '../types.ts';
import { providerTimestampMs } from '../usage.ts';

export type CodexTelemetryAuth =
  | { supported: true; plan: string | null }
  | { supported: false; plan: null; reason: string };

const ACCOUNT_READ_ERROR = 'Codex account response is invalid.';
const AUTH_UPDATE_ERROR = 'Codex account update is invalid.';
const RATE_LIMITS_ERROR = 'Codex rate limits response is invalid.';

export const CODEX_TELEMETRY_REASONS = {
  apiKey: 'Codex account telemetry is unavailable for API key authentication.',
  bedrock: 'Codex account telemetry is unavailable for Amazon Bedrock authentication.',
  signedOut: 'Codex account telemetry is unavailable while signed out.',
  externalTokens: 'Codex account telemetry is unavailable for external ChatGPT token authentication.',
  headers: 'Codex account telemetry is unavailable for external header authentication.',
  identity: 'Codex account telemetry is unavailable for agent identity authentication.',
  personalAccessToken: 'Codex account telemetry is unavailable for personal access token authentication.',
} as const;

const BLOCK_REASONS = new Set<AccountLimitBlockReason>([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

type ParsedBucket = {
  windows: AccountLimitWindow[];
  blocks: AccountLimitBlock[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(message);
}

function normalizePlan(value: unknown, error: string): string | null {
  if (value === undefined || value === null || value === 'unknown') return null;
  if (typeof value !== 'string' || value.length === 0) invalid(error);
  return value;
}

export function normalizeCodexAccountRead(input: unknown): CodexTelemetryAuth {
  if (!isObject(input) || typeof input.requiresOpenaiAuth !== 'boolean' || !('account' in input)) {
    invalid(ACCOUNT_READ_ERROR);
  }
  if (input.account === null) {
    if (!input.requiresOpenaiAuth) invalid(ACCOUNT_READ_ERROR);
    return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.signedOut };
  }
  if (!isObject(input.account) || typeof input.account.type !== 'string') invalid(ACCOUNT_READ_ERROR);
  switch (input.account.type) {
    case 'chatgpt':
      if ('email' in input.account
        && input.account.email !== null
        && typeof input.account.email !== 'string') {
        invalid(ACCOUNT_READ_ERROR);
      }
      return {
        supported: true,
        plan: normalizePlan(input.account.planType, ACCOUNT_READ_ERROR),
      };
    case 'apiKey':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.apiKey };
    case 'amazonBedrock':
      if (typeof input.account.usesCodexManagedCredentials !== 'boolean') invalid(ACCOUNT_READ_ERROR);
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.bedrock };
    default:
      return invalid(ACCOUNT_READ_ERROR);
  }
}

export function normalizeCodexAuthUpdate(input: unknown): CodexTelemetryAuth {
  if (!isObject(input) || !('authMode' in input)) invalid(AUTH_UPDATE_ERROR);
  const plan = normalizePlan(input.planType, AUTH_UPDATE_ERROR);
  switch (input.authMode) {
    case null:
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.signedOut };
    case 'chatgpt':
      return { supported: true, plan };
    case 'apikey':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.apiKey };
    case 'chatgptAuthTokens':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.externalTokens };
    case 'headers':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.headers };
    case 'agentIdentity':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.identity };
    case 'personalAccessToken':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.personalAccessToken };
    case 'bedrockApiKey':
      return { supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.bedrock };
    default:
      return invalid(AUTH_UPDATE_ERROR);
  }
}

function hasUsableWindow(value: unknown): boolean {
  return isObject(value) && (isObject(value.primary) || isObject(value.secondary));
}

function windowLabel(limitName: string | null, duration: number | null): string {
  if (limitName !== null) return limitName;
  if (duration === 300) return '5h';
  if (duration === 10_080) return '7d';
  return 'Usage window';
}

function parseWindow(
  value: unknown,
  id: string,
  limitName: string | null,
): AccountLimitWindow {
  if (!isObject(value)
    || typeof value.usedPercent !== 'number'
    || !Number.isFinite(value.usedPercent)
    || (value.windowDurationMins !== null
      && (typeof value.windowDurationMins !== 'number'
        || !Number.isFinite(value.windowDurationMins)
        || value.windowDurationMins < 0))
    || (value.resetsAt !== null
      && (typeof value.resetsAt !== 'number' || !Number.isFinite(value.resetsAt)))) {
    invalid(RATE_LIMITS_ERROR);
  }
  return {
    id,
    label: windowLabel(limitName, value.windowDurationMins),
    usedPercent: value.usedPercent,
    windowDurationMins: value.windowDurationMins,
    resetsAt: providerTimestampMs(value.resetsAt),
    reached: value.usedPercent >= 100,
  };
}

function parseBucket(value: unknown, bucketId: string, keyed: boolean, now: number): ParsedBucket {
  if (!isObject(value)
    || bucketId.length === 0
    || !('limitId' in value)
    || (value.limitId !== null && typeof value.limitId !== 'string')
    || (keyed && value.limitId !== null && value.limitId !== bucketId)
    || !('limitName' in value)
    || (value.limitName !== null && (typeof value.limitName !== 'string' || value.limitName.length === 0))
    || !('primary' in value)
    || !('secondary' in value)
    || (value.primary !== null && !isObject(value.primary))
    || (value.secondary !== null && !isObject(value.secondary))
    || !('spendControlReached' in value)
    || (value.spendControlReached !== null && typeof value.spendControlReached !== 'boolean')
    || !('rateLimitReachedType' in value)
    || (value.rateLimitReachedType !== null
      && (typeof value.rateLimitReachedType !== 'string'
        || !BLOCK_REASONS.has(value.rateLimitReachedType as AccountLimitBlockReason)))) {
    invalid(RATE_LIMITS_ERROR);
  }

  const limitName = value.limitName as string | null;
  const windows: AccountLimitWindow[] = [];
  if (value.primary !== null) windows.push(parseWindow(value.primary, `${bucketId}:primary`, limitName));
  if (value.secondary !== null) windows.push(parseWindow(value.secondary, `${bucketId}:secondary`, limitName));
  if (windows.length === 0) invalid(RATE_LIMITS_ERROR);

  const blocks: AccountLimitBlock[] = [];
  if (value.rateLimitReachedType !== null) {
    const reason = value.rateLimitReachedType as AccountLimitBlockReason;
    blocks.push({
      id: bucketId,
      reason,
      resettable: reason === 'rate_limit_reached'
        && windows.some((window) => window.reached && window.resetsAt !== null && window.resetsAt > now),
    });
  }
  if (value.spendControlReached === true) {
    blocks.push({ id: bucketId, reason: 'spend_control_reached', resettable: false });
  }
  return { windows, blocks };
}

export function normalizeCodexRateLimits(
  input: unknown,
  plan: string | null,
  now = Date.now(),
): AccountLimitSnapshot {
  if (!isObject(input)
    || !Number.isFinite(now)
    || (input.rateLimitsByLimitId !== null
      && input.rateLimitsByLimitId !== undefined
      && !isObject(input.rateLimitsByLimitId))) {
    invalid(RATE_LIMITS_ERROR);
  }

  const keyed = isObject(input.rateLimitsByLimitId)
    ? Object.entries(input.rateLimitsByLimitId)
    : [];
  const useKeyed = keyed.some(([, value]) => hasUsableWindow(value));
  const parsed = useKeyed
    ? keyed.map(([bucketId, value]) => parseBucket(value, bucketId, true, now))
    : [parseBucket(input.rateLimits, 'default', false, now)];
  const windows = parsed.flatMap((bucket) => bucket.windows);
  const seen = new Set<string>();
  for (const window of windows) {
    if (seen.has(window.id)) invalid(RATE_LIMITS_ERROR);
    seen.add(window.id);
  }
  windows.sort((left, right) => {
    const leftDuration = left.windowDurationMins ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.windowDurationMins ?? Number.POSITIVE_INFINITY;
    return leftDuration - rightDuration || left.id.localeCompare(right.id);
  });

  return {
    plan: normalizePlan(plan, RATE_LIMITS_ERROR),
    windows,
    blocks: parsed.flatMap((bucket) => bucket.blocks),
    fetchedAt: now,
    authoritative: true,
    fresh: true,
  };
}
