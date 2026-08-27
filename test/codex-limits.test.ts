import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCodexAccountRead,
  normalizeCodexAuthUpdate,
  normalizeCodexRateLimits,
} from '../src/agents/codex-limits.ts';

const reasons = {
  apiKey: 'Codex account telemetry is unavailable for API key authentication.',
  bedrock: 'Codex account telemetry is unavailable for Amazon Bedrock authentication.',
  signedOut: 'Codex account telemetry is unavailable while signed out.',
  externalTokens: 'Codex account telemetry is unavailable for external ChatGPT token authentication.',
  headers: 'Codex account telemetry is unavailable for external header authentication.',
  identity: 'Codex account telemetry is unavailable for agent identity authentication.',
  personalAccessToken: 'Codex account telemetry is unavailable for personal access token authentication.',
} as const;

type WindowInput = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

function bucket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 } satisfies WindowInput,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: 'unknown',
    rateLimitReachedType: null,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rateLimits: bucket(),
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    ...overrides,
  };
}

test('normalizes the account/read tagged vocabulary without crossing it with AuthMode spellings', () => {
  const cases: Array<{ input: unknown; expected: unknown }> = [
    {
      input: {
        account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' },
        requiresOpenaiAuth: true,
      },
      expected: { supported: true, plan: 'pro' },
    },
    {
      input: { account: { type: 'chatgpt', email: null }, requiresOpenaiAuth: true },
      expected: { supported: true, plan: null },
    },
    {
      input: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true },
      expected: { supported: true, plan: 'pro' },
    },
    {
      input: {
        account: { type: 'chatgpt', email: null, planType: 'unknown' },
        requiresOpenaiAuth: true,
      },
      expected: { supported: true, plan: null },
    },
    {
      input: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
      expected: { supported: false, plan: null, reason: reasons.apiKey },
    },
    {
      input: {
        account: { type: 'amazonBedrock', usesCodexManagedCredentials: true },
        requiresOpenaiAuth: false,
      },
      expected: { supported: false, plan: null, reason: reasons.bedrock },
    },
    {
      input: { account: null, requiresOpenaiAuth: true },
      expected: { supported: false, plan: null, reason: reasons.signedOut },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(normalizeCodexAccountRead(input), expected);
  }
  assert.throws(
    () => normalizeCodexAccountRead({ account: { type: 'apikey' }, requiresOpenaiAuth: true }),
    /account response is invalid/i,
  );
});

test('rejects malformed account/read results', () => {
  const malformed: unknown[] = [
    null,
    {},
    { account: null, requiresOpenaiAuth: false },
    { account: { type: 'chatgpt', planType: 7 }, requiresOpenaiAuth: true },
    { account: { type: 'unknown' }, requiresOpenaiAuth: true },
  ];
  for (const value of malformed) {
    assert.throws(() => normalizeCodexAccountRead(value), /account response is invalid/i);
  }
});

test('normalizes all seven account/updated AuthMode values with distinct external-auth reasons', () => {
  const cases: Array<{ authMode: string; expected: unknown }> = [
    ['apikey', { supported: false, plan: null, reason: reasons.apiKey }],
    ['chatgpt', { supported: true, plan: 'plus' }],
    ['chatgptAuthTokens', { supported: false, plan: null, reason: reasons.externalTokens }],
    ['headers', { supported: false, plan: null, reason: reasons.headers }],
    ['agentIdentity', { supported: false, plan: null, reason: reasons.identity }],
    ['personalAccessToken', { supported: false, plan: null, reason: reasons.personalAccessToken }],
    ['bedrockApiKey', { supported: false, plan: null, reason: reasons.bedrock }],
  ].map(([authMode, expected]) => ({ authMode: authMode as string, expected }));

  for (const { authMode, expected } of cases) {
    assert.deepEqual(normalizeCodexAuthUpdate({ authMode, planType: 'plus' }), expected);
  }
  assert.deepEqual(
    normalizeCodexAuthUpdate({ authMode: null, planType: null }),
    { supported: false, plan: null, reason: reasons.signedOut },
  );
  assert.deepEqual(
    normalizeCodexAuthUpdate({ authMode: 'chatgpt', planType: 'unknown' }),
    { supported: true, plan: null },
  );
});

test('rejects malformed account/updated results', () => {
  for (const value of [null, {}, { authMode: 'apiKey', planType: null }, { authMode: 'chatgpt', planType: 1 }]) {
    assert.throws(() => normalizeCodexAuthUpdate(value), /account update is invalid/i);
  }
});

test('prefers usable keyed buckets, expands both windows, and sorts stable output by duration then ID', () => {
  const normalized = normalizeCodexRateLimits(response({
    rateLimits: bucket({
      primary: { usedPercent: 99, windowDurationMins: 1, resetsAt: 1 },
    }),
    rateLimitsByLimitId: {
      weekly: bucket({
        limitId: 'weekly',
        primary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 2_000_604_800 },
      }),
      codex: bucket({
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 20, windowDurationMins: null, resetsAt: null },
      }),
      hourly: bucket({
        limitId: null,
        primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: 1_900_000_000_000 },
      }),
    },
  }), 'unknown', 1234);

  assert.deepEqual(normalized, {
    plan: null,
    windows: [
      {
        id: 'hourly:primary',
        label: 'Usage window',
        usedPercent: 5,
        windowDurationMins: 60,
        resetsAt: 1_900_000_000_000,
        reached: false,
      },
      {
        id: 'codex:primary',
        label: 'Codex',
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: 2_000_000_000_000,
        reached: false,
      },
      {
        id: 'weekly:primary',
        label: '7d',
        usedPercent: 70,
        windowDurationMins: 10_080,
        resetsAt: 2_000_604_800_000,
        reached: false,
      },
      {
        id: 'codex:secondary',
        label: 'Codex',
        usedPercent: 20,
        windowDurationMins: null,
        resetsAt: null,
        reached: false,
      },
    ],
    blocks: [],
    fetchedAt: 1234,
    authoritative: true,
    fresh: true,
  });
});

test('falls back to the legacy default bucket when no keyed bucket is usable', () => {
  const normalized = normalizeCodexRateLimits(response({
    rateLimits: bucket({
      limitId: null,
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
    }),
    rateLimitsByLimitId: {},
  }), 'team', 77);

  assert.deepEqual(normalized.windows.map((window) => ({
    id: window.id,
    label: window.label,
    reached: window.reached,
  })), [
    { id: 'default:primary', label: '5h', reached: true },
    { id: 'default:secondary', label: '7d', reached: false },
  ]);
  assert.equal(normalized.plan, 'team');
  assert.equal(normalized.fetchedAt, 77);
});

test('normalizes bucket blocks separately from reached windows and only marks resettable rate blocks', () => {
  const normalized = normalizeCodexRateLimits(response({
    rateLimitsByLimitId: {
      below: bucket({
        limitId: 'below',
        primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 3_000 },
        rateLimitReachedType: 'rate_limit_reached',
      }),
      future: bucket({
        limitId: 'future',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 3_000 },
        rateLimitReachedType: 'rate_limit_reached',
      }),
      depleted: bucket({
        limitId: 'depleted',
        primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 4_000 },
        rateLimitReachedType: 'workspace_member_credits_depleted',
        spendControlReached: true,
      }),
      noReset: bucket({
        limitId: 'noReset',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        rateLimitReachedType: 'rate_limit_reached',
      }),
    },
  }), 'pro', 2_000);

  assert.deepEqual(normalized.windows.map(({ id, reached }) => ({ id, reached })), [
    { id: 'below:primary', reached: false },
    { id: 'future:primary', reached: true },
    { id: 'noReset:primary', reached: true },
    { id: 'depleted:primary', reached: false },
  ]);
  assert.deepEqual(normalized.blocks, [
    { id: 'below', reason: 'rate_limit_reached', resettable: false },
    { id: 'future', reason: 'rate_limit_reached', resettable: true },
    { id: 'depleted', reason: 'workspace_member_credits_depleted', resettable: false },
    { id: 'depleted', reason: 'spend_control_reached', resettable: false },
    { id: 'noReset', reason: 'rate_limit_reached', resettable: false },
  ]);
});

test('rejects conflicting keyed IDs, malformed buckets, empty windows, and non-finite percentages', () => {
  const malformed: unknown[] = [
    response({ rateLimitsByLimitId: { codex: bucket({ limitId: 'other' }) } }),
    response({ rateLimitsByLimitId: { good: bucket({ limitId: 'good' }), bad: null } }),
    response({ rateLimits: bucket({ primary: null, secondary: null }) }),
    response({ rateLimits: bucket({ primary: { usedPercent: Infinity, windowDurationMins: 300, resetsAt: null } }) }),
    response({ rateLimits: bucket({ primary: { usedPercent: 10, windowDurationMins: Infinity, resetsAt: null } }) }),
    response({ rateLimits: bucket({ primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Infinity } }) }),
    response({ rateLimits: bucket({ rateLimitReachedType: 'undocumented_block' }) }),
  ];

  for (const value of malformed) {
    assert.throws(() => normalizeCodexRateLimits(value, null, 1), /rate limits response is invalid/i);
  }
});
