import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { normalizeClaude, approvalQueue } from '../src/agents/claude.ts';
import type { AdapterEvent } from '../src/types.ts';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/claude-basic.json', import.meta.url), 'utf8'),
);

function replay(messages: unknown[]): AdapterEvent[] {
  return messages.flatMap((m) => normalizeClaude(m as never));
}

test('a recorded session yields text, a tool call, and a final done status', () => {
  const events = replay(fixture);

  assert.ok(events.some((e) => e.type === 'msg' && e.msg.kind === 'tool'),
    'expected at least one tool message');
  assert.ok(events.some((e) => e.type === 'msg' && e.msg.kind === 'text'),
    'expected at least one text message');
  assert.equal(events.at(-1)?.type, 'status');
  assert.deepEqual(events.at(-1), { type: 'status', status: 'done' });
});

test('the init message reports the vendor session id exactly once', () => {
  // Locks in the round-2 fix: hook_started/hook_response/post_turn_summary system
  // messages in the fixture also carry session_id, but only the true init message
  // (subtype: 'init') should produce a vendor-session-id event.
  const events = replay(fixture);
  const vendorEvents = events.filter((e) => e.type === 'vendor-session-id');
  assert.equal(vendorEvents.length, 1, 'expected exactly one vendor-session-id event');
});

test('the result message folds cache tokens into inputTokens', () => {
  // Round-2 fix for finding 1: the fixture's result.usage is
  // { input_tokens: 4, output_tokens: 82, cache_creation_input_tokens: 19007,
  //   cache_read_input_tokens: 18919 } — cache tokens are real input-side spend
  // and must be folded in, or usage is undercounted by ~442x.
  const events = replay(fixture);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.inputTokens, 4 + 19007 + 18919);
  assert.equal(usage.outputTokens, 82);
});

test('an assistant text block becomes one text msg', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  } as never);
  assert.deepEqual(events, [{ type: 'msg', msg: { kind: 'text', text: 'hello' } }]);
});

test('a tool_use block is summarized to one line and carries its id', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }],
    },
  } as never);
  assert.deepEqual(events, [
    { type: 'msg', msg: { kind: 'tool', name: 'Bash', summary: 'ls -la', status: 'running', id: 't1' } },
  ]);
});

test('a tool_result block becomes a tool-result event', () => {
  const events = normalizeClaude({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
    },
  } as never);
  assert.deepEqual(events, [{ type: 'tool-result', id: 't1', ok: true }]);
});

test('a failed tool_result reports ok: false', () => {
  const events = normalizeClaude({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }],
    },
  } as never);
  assert.deepEqual(events, [{ type: 'tool-result', id: 't2', ok: false }]);
});

test('an error result becomes an error msg and a stopped event', () => {
  const events = normalizeClaude({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result: 'boom', usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
  assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'boom' });
});

test('approvalQueue resolves the oldest pending request first, not a concurrent second one', async () => {
  // Round-2 fix for finding 2: a single resolveApproval slot orphaned an earlier
  // pending request when a second canUseTool call arrived before the first was
  // answered. This proves FIFO order: decide() on request 1 must not touch
  // request 2's still-pending promise, and request 2 resolves on the next call.
  const q = approvalQueue();
  const req1 = { id: 'a1', tool: 'Bash', summary: 'ls' };
  const req2 = { id: 'a2', tool: 'Bash', summary: 'pwd' };
  const { promise: p1 } = q.wait(req1);
  const { promise: p2 } = q.wait(req2);

  const outcome1 = q.resolve({ behavior: 'allow', updatedInput: {} });
  assert.deepEqual(outcome1, { next: req2 }, 'resolving should surface the next pending request');
  assert.deepEqual(await p1, { behavior: 'allow', updatedInput: {} });

  const outcome2 = q.resolve({ behavior: 'deny', message: 'no' });
  assert.deepEqual(outcome2, { next: null }, 'queue should be empty after both are resolved');
  assert.deepEqual(await p2, { behavior: 'deny', message: 'no' });

  assert.equal(q.resolve({ behavior: 'allow', updatedInput: {} }), null,
    'resolving an empty queue should be a no-op, not throw');
});

test('approvalQueue signals emission only for the request that is actually decided next', () => {
  // Round-2-of-2 fix: canUseTool used to emit `approval` for every request the
  // instant it arrived. Session.pending is a single slot, so a second
  // concurrent request overwrote the card with its own summary before the
  // first request was resolved -- the user could authorize a different tool
  // call than the one displayed. Only the request that just became the head
  // of the queue (isHead) should ever be surfaced.
  const q = approvalQueue();
  const req1 = { id: 'a1', tool: 'Read', summary: 'package.json' };
  const req2 = { id: 'a2', tool: 'Bash', summary: 'rm -rf dist' };

  const w1 = q.wait(req1);
  assert.equal(w1.isHead, true, 'the first request enqueued must become the head and be surfaced');

  const w2 = q.wait(req2);
  assert.equal(w2.isHead, false,
    'a second request queued behind an unresolved one must stay hidden from the UI');

  const outcome = q.resolve({ behavior: 'allow', updatedInput: {} });
  assert.deepEqual(outcome, { next: req2 },
    'once request 1 is decided, request 2 becomes head and should now be surfaced');
});
