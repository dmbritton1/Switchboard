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
  assert.equal(u.toJSON().main.length, 2);

  u.record('main', 100, 100, 6 * HOUR);
  assert.deepEqual(
    u.toJSON().main,
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
  assert.deepEqual(u.toJSON(), { main: [{ t: 0, tokens: 200 }] });
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
