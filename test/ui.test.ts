import { test } from 'node:test';
import assert from 'node:assert';
import {
  sortSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel,
} from '../web/lib.js';

const session = (over = {}) => ({
  id: 'a', repo: '/r/one', branch: 'feat/a', account: 'claude-main',
  status: 'working', pending: null, statusSince: 1000, ...over,
});

test('sortSessions orders needs-you, working, done, stopped', () => {
  const out = sortSessions([
    session({ id: 'd', status: 'stopped' }),
    session({ id: 'c', status: 'done' }),
    session({ id: 'b', status: 'working' }),
    session({ id: 'a', status: 'needs-you' }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c', 'd']);
});

test('sortSessions breaks ties by most recent statusSince', () => {
  const out = sortSessions([
    session({ id: 'old', statusSince: 100 }),
    session({ id: 'new', statusSince: 900 }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['new', 'old']);
});

test('sortSessions does not mutate its input', () => {
  const input = [session({ id: 'b', status: 'stopped' }), session({ id: 'a', status: 'working' })];
  sortSessions(input);
  assert.deepEqual(input.map((s) => s.id), ['b', 'a']);
});

test('cardAction gives a blocked session the approval box', () => {
  const s = session({ status: 'needs-you', pending: { id: 'p', tool: 'Bash', summary: 'ls' } });
  assert.deepEqual(cardAction(s), { kind: 'approve' });
});

test('decideSpecs gives an ordinary tool Allow and Deny', () => {
  assert.deepEqual(decideSpecs({ id: 'p', tool: 'Bash', summary: 'ls' }), [
    ['Allow', { allow: true }],
    ['Deny', { allow: false }],
  ]);
});

test('decideSpecs turns question options into answer buttons plus Skip', () => {
  assert.deepEqual(decideSpecs({
    id: 'p', tool: 'AskUserQuestion', summary: 'TS or Py?', options: ['Python', 'TypeScript'],
  }), [
    ['Python', { answer: 'Python' }],
    ['TypeScript', { answer: 'TypeScript' }],
    ['Skip', { allow: false }],
  ]);
});

test('cardAction gives a working session Stop', () => {
  assert.deepEqual(cardAction(session({ status: 'working' })), { kind: 'stop' });
});

test('cardAction gives a done session nothing', () => {
  assert.deepEqual(cardAction(session({ status: 'done' })), { kind: 'none' });
});

test('cardAction gives a stopped session Resume when nothing is queued for it', () => {
  assert.deepEqual(cardAction(session({ status: 'stopped' })), { kind: 'resume' });
});

test('cardAction gives a stopped session the waiting state when a reset-resume is queued', () => {
  const queue = [{
    id: 'q1', state: 'waiting',
    trigger: { kind: 'reset', account: 'claude-main' },
    action: { kind: 'resume', sessionId: 'a', prompt: 'go on' },
  }];
  assert.deepEqual(cardAction(session({ status: 'stopped' }), queue),
    { kind: 'waiting', account: 'claude-main' });
});

test('cardAction ignores queue items for other sessions, other kinds, and dead states', () => {
  const s = session({ status: 'stopped' });
  const other = { kind: 'reset', account: 'claude-main' };
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: other, action: { kind: 'resume', sessionId: 'zzz' } }]),
    { kind: 'resume' }, 'other session');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: other, action: { kind: 'send', sessionId: 'a' } }]),
    { kind: 'resume' }, 'not a resume');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'failed', trigger: other, action: { kind: 'resume', sessionId: 'a' } }]),
    { kind: 'resume' }, 'not waiting');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: { kind: 'at', time: 1 }, action: { kind: 'resume', sessionId: 'a' } }]),
    { kind: 'resume' }, 'time-triggered, not a reset wait');
});

test('selectionState labels a single-repo selection with the repo name', () => {
  const out = selectionState(
    [session({ id: 'a', status: 'done' }), session({ id: 'b', repo: '/r/one', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.count, 2);
  assert.equal(out.label, '2 selected · one');
  assert.equal(out.merge.enabled, true);
  assert.equal(out.push.enabled, true);
});

test('selectionState disables merge and push across repos', () => {
  const out = selectionState(
    [session({ id: 'a', repo: '/r/one', status: 'done' }), session({ id: 'b', repo: '/r/two', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.label, '2 selected across 2 repos');
  assert.equal(out.merge.enabled, false);
  assert.equal(out.push.enabled, false);
  assert.match(out.merge.reason, /different repos/);
});

test('selectionState disables merge but not push while a selected session runs', () => {
  const out = selectionState(
    [session({ id: 'a', status: 'working', branch: 'feat/live' }), session({ id: 'b', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.merge.enabled, false);
  assert.match(out.merge.reason, /feat\/live/);
  assert.equal(out.push.enabled, true);
});

test('selectionState survives an empty selection', () => {
  const out = selectionState([session()], new Set());
  assert.equal(out.count, 0);
  assert.equal(out.merge.enabled, false);
  assert.equal(out.push.enabled, false);
});

test('triggerLabel formats an at trigger as a local date/time', () => {
  const time = Date.parse('2026-08-01T15:00:00Z');
  assert.equal(triggerLabel({ kind: 'at', time }), new Date(time).toLocaleString());
});

test('triggerLabel names the account for a reset trigger', () => {
  assert.equal(triggerLabel({ kind: 'reset', account: 'claude-main' }), 'when claude-main resets');
});

test('targetLabel names the new branch for a create action', () => {
  const action = { kind: 'create', repo: '/r/one', branch: 'feat/new', account: 'claude-main', prompt: 'go' };
  assert.equal(targetLabel(action, []), 'feat/new · new worktree');
});

test('targetLabel names the branch and kind for a send action on a live session', () => {
  const sessions = [session({ id: 'a', branch: 'feat/a' })];
  const action = { kind: 'send', sessionId: 'a', text: 'keep going' };
  assert.equal(targetLabel(action, sessions), 'feat/a · message');
});

test('targetLabel names the branch and kind for a resume action on a live session', () => {
  const sessions = [session({ id: 'a', branch: 'feat/a' })];
  const action = { kind: 'resume', sessionId: 'a', prompt: 'continue' };
  assert.equal(targetLabel(action, sessions), 'feat/a · resume');
});

test('targetLabel falls back to "deleted session" for a session id no longer in the list', () => {
  const action = { kind: 'resume', sessionId: 'gone', prompt: 'continue' };
  assert.equal(targetLabel(action, []), 'deleted session · resume');
});
