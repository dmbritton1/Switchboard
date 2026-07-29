import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeCodex } from '../src/agents/codex.ts';

test('thread.started reports the vendor session id', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'thread.started', thread_id: 'th_1' } as never),
    [{ type: 'vendor-session-id', id: 'th_1' }],
  );
});

test('turn.started sets working', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.started' } as never),
    [{ type: 'status', status: 'working' }],
  );
});

test('an agent_message item becomes a text msg', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: 'hello' },
    } as never),
    [{ type: 'msg', msg: { kind: 'text', text: 'hello' } }],
  );
});

test('a completed command_execution becomes an ok tool msg', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: {
        id: 'i2', type: 'command_execution', command: 'ls -la',
        aggregated_output: '...', exit_code: 0, status: 'completed',
      },
    } as never),
    [{ type: 'msg', msg: { kind: 'tool', name: 'shell', summary: 'ls -la', status: 'ok' } }],
  );
});

test('a failed command_execution becomes an error tool msg', () => {
  const events = normalizeCodex({
    type: 'item.completed',
    item: {
      id: 'i3', type: 'command_execution', command: 'false',
      aggregated_output: '', exit_code: 1, status: 'failed',
    },
  } as never);
  assert.equal(events[0].type, 'msg');
  assert.deepEqual(events[0], {
    type: 'msg',
    msg: { kind: 'tool', name: 'shell', summary: 'false', status: 'error' },
  });
});

test('a file_change item lists the touched paths', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.completed',
      item: {
        id: 'i4', type: 'file_change', status: 'completed',
        changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }],
      },
    } as never),
    [{ type: 'msg', msg: { kind: 'tool', name: 'edit', summary: 'a.ts, b.ts', status: 'ok' } }],
  );
});

test('item.started is ignored so items are only rendered once', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'item.started',
      item: { id: 'i5', type: 'agent_message', text: 'partial' },
    } as never),
    [],
  );
});

// Pins the decision this task exists to get right: cached_input_tokens,
// cache_write_input_tokens, and reasoning_output_tokens are subsets of
// input_tokens/output_tokens under the Responses API convention, not additions to
// them (unlike Anthropic's cache fields, which the Claude adapter correctly sums).
// Every cache field below is nonzero and distinct so any wrong summation — folding
// in one field, two, or all three — produces a total other than 10 or 5 and fails
// this assertion. Do not "fix" a failure here by summing the fields in; that is
// the regression this test exists to catch.
test('turn.completed reports usage and sets done', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'turn.completed',
      usage: {
        input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 7,
        output_tokens: 5, reasoning_output_tokens: 2,
      },
    } as never),
    [
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'status', status: 'done' },
    ],
  );
});

test('turn.failed stops the session with the error message', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.failed', error: { message: 'nope' } } as never),
    [{ type: 'stopped', reason: 'nope' }],
  );
});

test('a fatal error event stops the session', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'error', message: 'fatal' } as never),
    [{ type: 'stopped', reason: 'fatal' }],
  );
});
