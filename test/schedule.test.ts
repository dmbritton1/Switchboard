import { test } from 'node:test';
import assert from 'node:assert';
import { Scheduler, GRACE_MS } from '../src/schedule.ts';
import type { Ctx } from '../src/schedule.ts';
import type { Action } from '../src/types.ts';

const HOUR = 3600_000;

/** Every account free and idle unless the test says otherwise. */
function ctx(over: Partial<Ctx> = {}): Ctx {
  return { free: () => true, busy: () => false, ...over };
}

const CREATE: Action = {
  kind: 'create', repo: '/r', branch: 'b', account: 'main', prompt: 'go',
};

test('an at-item is not due before its time, and is due at and after it', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 10 * HOUR }, CREATE, 0);

  assert.equal(s.due(9 * HOUR, ctx()).length, 0);
  assert.equal(s.due(10 * HOUR, ctx()).length, 1);
  assert.equal(s.due(11 * HOUR, ctx()).length, 1);
});

test('an at-item overdue by more than the grace window is marked missed, not fired', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);

  assert.equal(s.due(GRACE_MS, ctx()).length, 1, 'exactly at the boundary still fires');

  const s2 = new Scheduler();
  s2.add({ kind: 'at', time: 0 }, CREATE, 0);
  assert.equal(s2.due(GRACE_MS + 1, ctx()).length, 0);
  assert.equal(s2.all()[0].state, 'missed');
});

test('a missed item stays in the list and is never reconsidered', () => {
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);
  s.due(GRACE_MS + 1, ctx());

  assert.equal(s.all().length, 1);
  assert.equal(s.due(GRACE_MS + 2, ctx()).length, 0, 'only `waiting` items are ever due');
});

test('an at-item fires even when its account is busy', () => {
  // The user asked for a time. Another session running does not change that.
  const s = new Scheduler();
  s.add({ kind: 'at', time: 0 }, CREATE, 0);
  assert.equal(s.due(0, ctx({ busy: () => true })).length, 1);
});

test('a reset-item waits until the account is free', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'main' }, CREATE, 0);

  assert.equal(s.due(HOUR, ctx({ free: () => false })).length, 0);
  assert.equal(s.due(HOUR, ctx({ free: () => true })).length, 1);
});

test('a reset-item waits while its account has a session running', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'main' }, CREATE, 0);

  assert.equal(s.due(HOUR, ctx({ busy: () => true })).length, 0);
  assert.equal(s.due(HOUR, ctx({ busy: () => false })).length, 1);
});

test('two reset-items on one account drain one at a time, oldest first', () => {
  const s = new Scheduler();
  const first = s.add({ kind: 'reset', account: 'main' }, CREATE, 0);
  const second = s.add({ kind: 'reset', account: 'main' }, CREATE, 1);

  const batch = s.due(HOUR, ctx());
  assert.equal(batch.length, 1, 'a fresh window must not be blown by both at once');
  assert.equal(batch[0].id, first.id);

  // The caller removes a fired item; the next tick releases the second.
  s.remove(first.id);
  assert.equal(s.due(2 * HOUR, ctx())[0].id, second.id);
});

test('reset-items on different accounts drain in the same pass', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'a' }, { ...CREATE, account: 'a' }, 0);
  s.add({ kind: 'reset', account: 'b' }, { ...CREATE, account: 'b' }, 0);
  assert.equal(s.due(HOUR, ctx()).length, 2, 'one busy account must not serialize another');
});

test('free/busy are asked about the trigger account, not a global', () => {
  const s = new Scheduler();
  s.add({ kind: 'reset', account: 'b' }, CREATE, 0);
  const asked: string[] = [];
  s.due(HOUR, ctx({ free: (a) => { asked.push(a); return true; } }));
  assert.deepEqual(asked, ['b']);
});

test('fail() takes an item out of contention and records why', () => {
  const s = new Scheduler();
  const item = s.add({ kind: 'at', time: 0 }, CREATE, 0);
  s.fail(item.id, 'branch already exists');

  assert.equal(s.all()[0].state, 'failed');
  assert.equal(s.all()[0].error, 'branch already exists');
  assert.equal(s.due(HOUR, ctx()).length, 0);
});

test('toJSON/restore round-trips the queue', () => {
  const s = new Scheduler();
  const item = s.add({ kind: 'at', time: 10 * HOUR }, CREATE, 0);

  const back = new Scheduler();
  back.restore(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.all().length, 1);
  assert.equal(back.all()[0].id, item.id);
  assert.equal(back.due(10 * HOUR, ctx()).length, 1);
});

test('restore drops malformed items rather than throwing', () => {
  // state.json is hand-editable, so treat it as untrusted.
  const s = new Scheduler();
  s.restore('not an array');
  s.restore([null, {}, { id: 7 }, { id: 'ok', trigger: { kind: 'at', time: 0 } }]);
  assert.equal(s.all().length, 0, 'an item with no action is not usable');
});
