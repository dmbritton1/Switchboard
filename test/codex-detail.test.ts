import { test } from 'node:test';
import assert from 'node:assert';
import { safeCodexDetail } from '../src/agents/codex-detail.ts';

test('safeCodexDetail redacts credential keys and launch-environment values', () => {
  const detail = safeCodexDetail({
    command: 'curl -H "Authorization: Bearer abcdefghijklmnop"',
    apiKey: 'visible-key',
    nested: { password: 'hunter2', ordinary: 'keep me' },
  }, { OPENAI_API_KEY: 'visible-key', PRIVATE_TOKEN: 'hunter2' })!;

  assert.doesNotMatch(detail.text, /abcdefghijklmnop|visible-key|hunter2/);
  assert.match(detail.text, /\[REDACTED\]/);
  assert.match(detail.text, /keep me/);
});

test('safeCodexDetail caps valid UTF-8 including its marker', () => {
  const detail = safeCodexDetail('🙂'.repeat(20_000), {}, 1024)!;
  assert.equal(Buffer.byteLength(detail.text, 'utf8') <= 1024, true);
  assert.equal(detail.truncated, true);
  assert.match(detail.text, /\n\[truncated\]$/);
  assert.doesNotMatch(detail.text, /�/);
});

test('safeCodexDetail returns null only for nullish values', () => {
  assert.equal(safeCodexDetail(null, {}), null);
  assert.equal(safeCodexDetail(undefined, {}), null);
  assert.deepEqual(safeCodexDetail('', {}), { text: '', truncated: false });
});

test('safeCodexDetail preserves an ordinary string below the limit', () => {
  assert.deepEqual(safeCodexDetail('plain output', {}, 64), {
    text: 'plain output', truncated: false,
  });
});

test('safeCodexDetail serializes objects as stable indented JSON', () => {
  assert.deepEqual(safeCodexDetail({ zebra: 1, alpha: { ok: true } }, {}), {
    text: '{\n  "zebra": 1,\n  "alpha": {\n    "ok": true\n  }\n}',
    truncated: false,
  });
});

test('safeCodexDetail replaces circular object references', () => {
  const value: Record<string, unknown> = { ordinary: 'kept' };
  value.self = value;
  const detail = safeCodexDetail(value, {})!;
  assert.match(detail.text, /"ordinary": "kept"/);
  assert.match(detail.text, /"self": "\[Circular\]"/);
});

test('safeCodexDetail redacts Bearer and OpenAI-style secrets in strings', () => {
  const detail = safeCodexDetail(
    'Authorization: Bearer bearer-secret and sk-1234567890_ABCDEFG',
    {},
  )!;
  assert.doesNotMatch(detail.text, /bearer-secret|sk-1234567890_ABCDEFG/);
  assert.match(detail.text, /Bearer \[REDACTED\]/);
});
