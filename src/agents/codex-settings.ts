import type { CodexThreadSettings } from '../types.ts';

const KEYS = new Set(['model', 'modelReasoningEffort', 'webSearchMode', 'networkAccessEnabled']);
const EFFORTS = new Set<CodexThreadSettings['modelReasoningEffort']>([
  'minimal', 'low', 'medium', 'high', 'xhigh',
]);
const SEARCH_MODES = new Set<CodexThreadSettings['webSearchMode']>(['disabled', 'cached', 'live']);

export function validateCodexSettings(value: unknown): CodexThreadSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex settings must be an object.');
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) throw new Error(`Codex settings include unknown key: ${key}.`);
  }

  const settings: CodexThreadSettings = {};
  if (input.model !== undefined) {
    if (typeof input.model !== 'string') throw new Error('Codex model must be text.');
    const model = input.model.trim();
    if (model.length > 200) throw new Error('Codex model must be at most 200 characters.');
    if (model) settings.model = model;
  }
  if (input.modelReasoningEffort !== undefined) {
    if (!EFFORTS.has(input.modelReasoningEffort as CodexThreadSettings['modelReasoningEffort'])) {
      throw new Error('Codex reasoning effort must be minimal, low, medium, high, or xhigh.');
    }
    settings.modelReasoningEffort = input.modelReasoningEffort as CodexThreadSettings['modelReasoningEffort'];
  }
  if (input.webSearchMode !== undefined) {
    if (!SEARCH_MODES.has(input.webSearchMode as CodexThreadSettings['webSearchMode'])) {
      throw new Error('Codex web search mode must be disabled, cached, or live.');
    }
    settings.webSearchMode = input.webSearchMode as CodexThreadSettings['webSearchMode'];
  }
  if (input.networkAccessEnabled !== undefined) {
    if (typeof input.networkAccessEnabled !== 'boolean') {
      throw new Error('Codex network access must be enabled or disabled.');
    }
    settings.networkAccessEnabled = input.networkAccessEnabled;
  }
  return Object.keys(settings).length ? settings : undefined;
}
