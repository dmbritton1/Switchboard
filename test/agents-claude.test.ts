import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { normalizeClaude } from '../src/agents/claude.ts';
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

test('the init message reports the vendor session id', () => {
  const events = replay(fixture);
  const first = events.find((e) => e.type === 'vendor-session-id');
  assert.ok(first, 'expected a vendor-session-id event');
});

test('the result message reports usage', () => {
  const events = replay(fixture);
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.ok(usage.inputTokens > 0, 'expected non-zero input tokens');
});

test('an assistant text block becomes one text msg', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  } as never);
  assert.deepEqual(events, [{ type: 'msg', msg: { kind: 'text', text: 'hello' } }]);
});

test('a tool_use block is summarized to one line', () => {
  const events = normalizeClaude({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }],
    },
  } as never);
  assert.deepEqual(events, [
    { type: 'msg', msg: { kind: 'tool', name: 'Bash', summary: 'ls -la', status: 'running' } },
  ]);
});

test('an error result becomes an error msg and a stopped event', () => {
  const events = normalizeClaude({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result: 'boom', usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
  assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'boom' });
});
