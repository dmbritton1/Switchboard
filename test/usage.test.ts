import { test } from 'node:test';
import assert from 'node:assert';
import { Usage } from '../src/usage.ts';

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

test('freestAccount picks the lowest pace, not the lowest raw spend', () => {
  const u = new Usage();
  u.record('big', 400, 400, 0);    // 800 of 10000 = 0.08
  u.record('small', 100, 100, 0);  // 200 of 1000  = 0.20
  const freest = u.freestAccount(
    [{ name: 'big', budget: 10000 }, { name: 'small', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'big');
});

test('freestAccount throws when given no accounts', () => {
  const u = new Usage();
  assert.throws(() => u.freestAccount([], 0), /no accounts/i);
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

test('resetsAt in seconds is normalized to milliseconds', () => {
  const u = new Usage();
  // The SDK types resetsAt as a bare `number` with no documented unit.
  u.noteLimit('sec', 'rejected', 1_800_000_000);        // seconds
  u.noteLimit('ms', 'rejected', 1_800_000_000_000);     // milliseconds
  assert.equal(u.resetAt('sec'), 1_800_000_000_000);
  assert.equal(u.resetAt('ms'), 1_800_000_000_000);
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

const limits = (five: number, seven: number) => ({
  fiveHour: { utilization: five, resetsAt: '2026-08-03T19:10:00Z' },
  sevenDay: { utilization: seven, resetsAt: '2026-08-10T08:00:00Z' },
  subscription: 'pro',
});

test('getLimits on an unprobed account is empty, not undefined', () => {
  const u = new Usage();
  assert.deepEqual(u.getLimits('main'), { limits: null, error: null });
});

test('setLimits stores limits and a later success clears a previous error', () => {
  const u = new Usage();
  u.setLimits('main', null, 'logged out');
  assert.deepEqual(u.getLimits('main'), { limits: null, error: 'logged out' });

  u.setLimits('main', limits(11, 1), null);
  assert.deepEqual(u.getLimits('main'), { limits: limits(11, 1), error: null });
});

test('limits are not persisted: a percentage is wrong the moment we are not running', () => {
  const u = new Usage();
  u.record('main', 100, 100, 0);
  u.setLimits('main', limits(11, 1), null);
  // The persisted shape gained a `resets` block when scheduling landed (a reset
  // time is still true after a restart, unlike a utilization percentage). The
  // assertion this test exists for is unchanged: nothing from setLimits() is in
  // here — no utilization, no subscription, no error.
  assert.deepEqual(u.toJSON(), { samples: { main: [{ t: 0, tokens: 200 }] }, resets: {} });
});

test('freestAccount prefers a supplied load over pace', () => {
  const u = new Usage();
  // 'real' looks the busiest by local estimate (90% of budget) but its real plan
  // utilization is 5%; 'est' has no real number and a 40% estimate. Ranking on
  // pace alone would pick 'est' — which is the point: drop the `load` override
  // from freestAccount and this test must fail.
  u.record('real', 900, 0, 0);
  u.record('est', 400, 0, 0);
  const freest = u.freestAccount(
    [{ name: 'real', budget: 1000, load: 0.05 }, { name: 'est', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'real');
});

test('freestAccount falls back to pace for accounts with no load', () => {
  const u = new Usage();
  u.record('busy', 800, 0, 0);
  const freest = u.freestAccount(
    [{ name: 'busy', budget: 1000 }, { name: 'quiet', budget: 1000 }],
    0,
  );
  assert.equal(freest, 'quiet');
});
