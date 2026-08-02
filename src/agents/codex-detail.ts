import { redactCodexText } from './codex-runtime.ts';

export const MAX_CODEX_DETAIL_BYTES = 32 * 1024;
export const MAX_CODEX_DETAIL_TOTAL_BYTES = 2 * 1024 * 1024;

export type SafeDetail = { text: string; truncated: boolean };

const CREDENTIAL_KEY = /token|api[_-]?key|secret|password|authorization|cookie|credential/i;
const OPENAI_SECRET = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const TRUNCATION_MARKER = '\n[truncated]';
const COMPACT_TRUNCATION_MARKER = '[truncated]';

function utf8Prefix(text: string, maxBytes: number): string {
  let prefix = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (prefix.endsWith('\uFFFD')) prefix = prefix.slice(0, -1);
  return prefix;
}

function stringifyDetail(value: unknown): string {
  if (typeof value === 'string') return value;

  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, nested) => {
    if (CREDENTIAL_KEY.test(key)) return '[REDACTED]';
    if (nested && typeof nested === 'object') {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  }, 2);
  return serialized ?? String(value);
}

export function safeCodexDetail(
  value: unknown,
  env: Record<string, string>,
  maxBytes = MAX_CODEX_DETAIL_BYTES,
): SafeDetail | null {
  if (value === null || value === undefined) return null;

  const byteLimit = Math.max(0, Math.floor(maxBytes));
  const safe = redactCodexText(stringifyDetail(value), env).replace(OPENAI_SECRET, '[REDACTED]');
  if (Buffer.byteLength(safe, 'utf8') <= byteLimit) return { text: safe, truncated: false };

  const fullMarkerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const marker = byteLimit >= fullMarkerBytes
    ? TRUNCATION_MARKER
    : utf8Prefix(COMPACT_TRUNCATION_MARKER, byteLimit);
  const bodyBytes = byteLimit - Buffer.byteLength(marker, 'utf8');
  return { text: utf8Prefix(safe, bodyBytes) + marker, truncated: true };
}
