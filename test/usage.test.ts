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
