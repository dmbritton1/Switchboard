import assert from 'node:assert';
import { test } from 'node:test';
import { validateCodexSettings } from '../src/agents/codex-settings.ts';

test('Codex settings inherit when omitted, empty, or a blank model', () => {
  assert.equal(validateCodexSettings(undefined), undefined);
  assert.equal(validateCodexSettings({}), undefined);
  assert.equal(validateCodexSettings({ model: '   ' }), undefined);
});

test('Codex settings retain every explicit valid value, including disabled network access', () => {
  assert.deepEqual(validateCodexSettings({
    model: '  gpt-5.3-codex  ',
    modelReasoningEffort: 'high',
    webSearchMode: 'live',
    networkAccessEnabled: false,
  }), {
    model: 'gpt-5.3-codex',
    modelReasoningEffort: 'high',
    webSearchMode: 'live',
    networkAccessEnabled: false,
  });
});

test('Codex settings accept each approved enum value', () => {
  for (const modelReasoningEffort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.deepEqual(validateCodexSettings({ modelReasoningEffort }), { modelReasoningEffort });
  }
  for (const webSearchMode of ['disabled', 'cached', 'live']) {
    assert.deepEqual(validateCodexSettings({ webSearchMode }), { webSearchMode });
  }
  assert.deepEqual(validateCodexSettings({ networkAccessEnabled: true }), { networkAccessEnabled: true });
});

test('Codex settings reject malformed fields instead of silently applying them', () => {
  const invalid = [
    null,
    [],
    { unknown: 'value' },
    { model: 'x'.repeat(201) },
    { model: 3 },
    { modelReasoningEffort: 'maximum' },
    { webSearchMode: 'always' },
    { networkAccessEnabled: 'false' },
  ];
  for (const value of invalid) {
    assert.throws(() => validateCodexSettings(value), /Codex settings|model|reasoning|web search|network/i);
  }
});
