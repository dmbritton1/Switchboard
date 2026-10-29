import type { ElicitationResponse } from './codex-elicitation.ts';
import { randomUUID } from 'node:crypto';
import type { StructuredQuestion } from '../types.ts';

export type CodexQuestion = {
  wireId: string;
  public: Omit<StructuredQuestion, 'index' | 'total'>;
  labels: Map<string, string>;
};
export type CodexInteractionResult = ElicitationResponse | 'accept' | 'decline' | { answers: Record<string, { answers: string[] }> };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function bounded(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
}

/** Validate the pinned single-choice protocol. Raw IDs/labels stay process-local. */
export function normalizeCodexQuestions(params: unknown, redact: (value: string) => string): CodexQuestion[] | null {
  const value = record(params);
  if (!value || typeof value.isBlocking !== 'boolean' || !Array.isArray(value.questions)
    || !value.questions.length || value.questions.length > 8) return null;
  const ids = new Set<string>();
  const questions: CodexQuestion[] = [];
  let size = 0;
  for (const raw of value.questions) {
    const q = record(raw);
    if (!q || !bounded(q.id, 256) || ids.has(q.id) || !bounded(q.header, 256, true)
      || !bounded(q.question, 8192) || typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'boolean'
      || (q.options !== null && (!Array.isArray(q.options) || !q.options.length || q.options.length > 20))) return null;
    ids.add(q.id);
    const options: StructuredQuestion['options'] = [];
    const labels = new Map<string, string>();
    const seen = new Set<string>();
    size += q.header.length + q.question.length;
    for (const rawOption of (q.options ?? []) as unknown[]) {
      const option = record(rawOption);
      if (!option || !bounded(option.label, 1024) || !bounded(option.description, 4096, true)
        || seen.has(option.label)) return null;
      seen.add(option.label);
      size += option.label.length + option.description.length;
      const id = randomUUID();
      labels.set(id, option.label);
      options.push({ id, label: redact(option.label), description: redact(option.description) });
    }
    if (size > 32768) return null;
    questions.push({ wireId: q.id, labels, public: {
      header: redact(q.header), prompt: redact(q.question), options,
      allowText: q.isOther || options.length === 0, secret: q.isSecret,
    } });
  }
  return questions;
}

export function questionAnswer(value: unknown, question: CodexQuestion): string | null {
  const answer = record(value);
  if (!answer || Object.keys(answer).length !== 1) return null;
  if (typeof answer.optionId === 'string') return question.labels.get(answer.optionId) ?? null;
  if (question.public.allowText && bounded(answer.text, 8192)) return answer.text;
  return null;
}
