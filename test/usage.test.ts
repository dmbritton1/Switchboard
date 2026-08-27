import { test } from 'node:test';
import assert from 'node:assert';
import { providerTimestampMs, Usage } from '../src/usage.ts';
import type { AccountLimitSnapshot } from '../src/types.ts';

const HOUR = 3600_000;

test('pace is the fraction of budget spent in the last five hours', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  assert.equal(u.pace('main', 1000, 0), 0.2);
});

test('pace ignores samples older than five hours', () => {
  const u = new Usage();
  u.record('main', 500, 500, 0);
  assert.equal(u.pace('main', 1000, 0), 1);
  assert.equal(u.pace('main', 1000, 6 * HOUR), 0);
});

test('record prunes samples that have fallen out of the window', () => {
  const u = new Usage();
  u.record('main', 500, 500, 0);
  u.record('main', 50, 50, 2 * HOUR);
  assert.equal(u.toJSON().samples.main.length, 2);

  u.record('main', 100, 100, 6 * HOUR);
  assert.deepEqual(
    u.toJSON().samples.main,
    [{ t: 2 * HOUR, tokens: 100 }, { t: 6 * HOUR, tokens: 200 }],
    'the 0h sample is outside the 5h window and must not be kept (it is now persisted)',
  );
});

test('pace of an account with no samples is zero', () => {
  const u = new Usage();
  assert.equal(u.pace('never-used', 1000, 0), 0);
});

test('a rejected rate limit stores its reset time; allowed clears it', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  assert.equal(u.resetAt('main'), 5 * HOUR);

  u.noteLimit('main', 'allowed', null);
  assert.equal(u.resetAt('main'), null);
});

test('allowed_warning clears a stored limit — a warning still means allowed', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  u.noteLimit('main', 'allowed_warning', 5 * HOUR);
  assert.equal(u.resetAt('main'), null,
    'a warning means there is still room; storing its resetsAt would block work that is allowed');
});

test('a rejection with no reset time stores nothing', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', null);
  assert.equal(u.resetAt('main'), null);
});

test('providerTimestampMs normalizes seconds while retaining milliseconds and fake clocks', () => {
  assert.equal(providerTimestampMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(providerTimestampMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(providerTimestampMs(5 * HOUR), 5 * HOUR);
  assert.equal(providerTimestampMs(null), null);
  assert.equal(providerTimestampMs(Infinity), null);
  assert.equal(providerTimestampMs('1_800_000_000'), null);
});

test('noteLimit uses provider timestamp normalization without changing Claude recovery', () => {
  const u = new Usage();
  u.noteLimit('sec', 'rejected', 1_800_000_000);
  assert.equal(u.resetAt('sec'), 1_800_000_000_000);
});

test('free() prefers a known reset time over the pace estimate', () => {
  const u = new Usage();
  u.noteLimit('main', 'rejected', 5 * HOUR);
  // No samples at all, so pace() is 0 — but a known future reset must win.
  assert.equal(u.free('main', 1000, 4 * HOUR), false);
  assert.equal(u.free('main', 1000, 5 * HOUR), true, 'now === resetsAt means the window has rolled');
  assert.equal(u.free('main', 1000, 6 * HOUR), true);
});

test('free() falls back to the pace estimate when no reset time is known', () => {
  const u = new Usage();
  u.record('busy', 450, 450, 0);   // 900 of 1000 = 0.90, over RESET_PACE
  u.record('calm', 350, 350, 0);   // 700 of 1000 = 0.70, under RESET_PACE
  assert.equal(u.free('busy', 1000, 0), false);
  assert.equal(u.free('calm', 1000, 0), true);
});

test('toJSON/restore round-trips both samples and resets', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  u.noteLimit('main', 'rejected', 5 * HOUR);

  const back = new Usage();
  back.restore(JSON.parse(JSON.stringify(u.toJSON())), 0);
  assert.equal(back.pace('main', 1000, 0), 0.2);
  assert.equal(back.resetAt('main'), 5 * HOUR);
});

test('restore still accepts the old bare account-to-samples map', () => {
  // state.json written before resets existed is a bare map, not { samples, resets }.
  const u = new Usage();
  u.restore({ main: [{ t: 0, tokens: 200 }] }, 0);
  assert.equal(u.pace('main', 1000, 0), 0.2);
  assert.equal(u.resetAt('main'), null);
});

test('restore ignores a malformed resets block', () => {
  const u = new Usage();
  u.restore({ samples: {}, resets: { a: 'soon', b: NaN, c: 5 * HOUR } }, 0);
  assert.equal(u.resetAt('a'), null);
  assert.equal(u.resetAt('b'), null);
  assert.equal(u.resetAt('c'), 5 * HOUR);
});

const snapshot = (over: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot => ({
  plan: 'pro',
  windows: [
    { id: 'short', label: 'Short', usedPercent: 11, windowDurationMins: 60, resetsAt: 10 * HOUR, reached: false },
    { id: 'long', label: 'Long', usedPercent: 1, windowDurationMins: 10_080, resetsAt: 20 * HOUR, reached: false },
  ],
  blocks: [],
  fetchedAt: 0,
  authoritative: true,
  fresh: true,
  ...over,
});

test('getLimitSnapshot on an unprobed account is empty, not undefined', () => {
  const u = new Usage();
  assert.deepEqual(u.getLimitSnapshot('main'), { snapshot: null, error: null });
});

test('setLimitSnapshot stores arbitrary windows and clears a previous error', () => {
  const u = new Usage();
  u.failLimitSnapshot('main', 'logged out');
  assert.deepEqual(u.getLimitSnapshot('main'), { snapshot: null, error: 'logged out' });

  const read = snapshot({
    windows: [
      { id: 'monthly', label: 'Monthly', usedPercent: 45, windowDurationMins: 43_200, resetsAt: 30 * 24 * HOUR, reached: false },
      { id: 'burst', label: 'Burst', usedPercent: 12, windowDurationMins: null, resetsAt: null, reached: false },
    ],
  });
  u.setLimitSnapshot('main', read);
  assert.deepEqual(u.getLimitSnapshot('main'), { snapshot: read, error: null });
});

test('a failed snapshot refresh retains provider data but marks it stale', () => {
  const u = new Usage();
  const read = snapshot();
  u.setLimitSnapshot('main', read);
  u.failLimitSnapshot('main', 'refresh failed');

  assert.deepEqual(u.getLimitSnapshot('main'), {
    snapshot: { ...read, fresh: false },
    error: 'refresh failed',
  });
});

test('a failed snapshot refresh without prior data keeps only the error', () => {
  const u = new Usage();
  u.failLimitSnapshot('main', 'refresh failed');
  assert.deepEqual(u.getLimitSnapshot('main'), { snapshot: null, error: 'refresh failed' });
});

test('authoritative reset eligibility uses the latest reset across reached windows', () => {
  const u = new Usage();
  u.setLimitSnapshot('main', snapshot({ windows: [
    { id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: 10 * HOUR, reached: true },
    { id: 'week', label: 'Week', usedPercent: 100, windowDurationMins: 10_080, resetsAt: 20 * HOUR, reached: true },
  ] }));
  assert.deepEqual(u.authoritativeResetEligibility('main', 5 * HOUR), { eligible: true, resetsAt: 20 * HOUR });
});

test('authoritative reset eligibility rejects stale, unreached, and missing/past reset states', () => {
  const cases: Array<{ name: string; read: AccountLimitSnapshot; now: number }> = [
    { name: 'stale', read: snapshot({ fresh: false }), now: 0 },
    { name: 'unreached', read: snapshot(), now: 0 },
    { name: 'missing reset', read: snapshot({ windows: [
      { id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: null, reached: true },
    ] }), now: 0 },
    { name: 'past reset', read: snapshot({ windows: [
      { id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: 5 * HOUR, reached: true },
    ] }), now: 5 * HOUR },
  ];

  for (const { name, read, now } of cases) {
    const u = new Usage();
    u.setLimitSnapshot('main', read);
    const result = u.authoritativeResetEligibility('main', now);
    assert.equal(result.eligible, false, name);
  }
});

test('only resettable rate-limit blocks may accompany reset scheduling', () => {
  const resettable = new Usage();
  resettable.setLimitSnapshot('main', snapshot({
    windows: [{ id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: 10 * HOUR, reached: true }],
    blocks: [{ id: 'default', reason: 'rate_limit_reached', resettable: true }],
  }));
  assert.deepEqual(resettable.authoritativeResetEligibility('main', 0), { eligible: true, resetsAt: 10 * HOUR });

  for (const reason of [
    'workspace_owner_credits_depleted',
    'workspace_member_credits_depleted',
    'workspace_owner_usage_limit_reached',
    'workspace_member_usage_limit_reached',
    'spend_control_reached',
  ] as const) {
    const u = new Usage();
    u.setLimitSnapshot('main', snapshot({
      windows: [{ id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: 10 * HOUR, reached: true }],
      blocks: [{ id: 'default', reason, resettable: true }],
    }));
    assert.equal(u.authoritativeResetEligibility('main', 0).eligible, false, reason);
  }
});

test('provider snapshots are never persisted while token samples and Claude resets round-trip', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  u.noteLimit('main', 'rejected', 5 * HOUR);
  u.setLimitSnapshot('main', snapshot({
    plan: 'max',
    blocks: [{ id: 'workspace', reason: 'spend_control_reached', resettable: false }],
  }));

  const persisted = u.toJSON();
  const serialized = JSON.stringify(persisted);
  for (const hidden of ['max', 'windows', 'blocks', 'fetchedAt', String(10 * HOUR)]) {
    assert.doesNotMatch(serialized, new RegExp(hidden));
  }

  const back = new Usage();
  back.restore(persisted, 0);
  assert.equal(back.pace('main', 1000, 0), 0.2);
  assert.equal(back.resetAt('main'), 5 * HOUR);
  assert.deepEqual(back.getLimitSnapshot('main'), { snapshot: null, error: null });
});

test('a generic snapshot never populates the Claude rejected-event reset channel', () => {
  const u = new Usage();
  u.setLimitSnapshot('main', snapshot({ windows: [
    { id: 'hour', label: 'Hour', usedPercent: 100, windowDurationMins: 60, resetsAt: 10 * HOUR, reached: true },
  ] }));
  assert.equal(u.resetAt('main'), null);
});
