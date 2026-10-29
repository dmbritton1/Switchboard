import { elicitationResult, type Elicitation } from './codex-elicitation.ts';
import { randomUUID } from 'node:crypto';
import type { ApprovalRequest } from '../types.ts';
import { questionAnswer, type CodexQuestion, type CodexInteractionResult } from './codex-questions.ts';

type Entry = {
  wireId: string | number; public: ApprovalRequest; sent: boolean;
  elicitation?: Elicitation;
  questions?: { items: CodexQuestion[]; index: number; answers: Record<string, { answers: string[] }> };
};

/** Process-local callbacks and answers; Registry receives only the redacted head. */
export class CodexApprovals {
  #entries: Entry[] = [];
  #auto: boolean;
  #visible = false;
  #publish: (pending: ApprovalRequest | null) => void;
  #respond: (id: string | number, result: CodexInteractionResult) => void;

  constructor(auto: boolean, publish: (pending: ApprovalRequest | null) => void,
    respond: (id: string | number, result: CodexInteractionResult) => void) {
    this.#auto = auto;
    this.#publish = publish;
    this.#respond = respond;
  }

  add(wireId: string | number, tool: string, summary: string): void {
    if (this.#entries.some(e => e.wireId === wireId)) return;
    const entry: Entry = { wireId, public: { id: randomUUID(), tool, summary }, sent: false };
    this.#entries.push(entry);
    if (this.#auto) this.#send(entry, true);
    this.#show();
  }

  addQuestions(wireId: string | number, items: CodexQuestion[]): void {
    if (!items.length || this.#entries.some(e => e.wireId === wireId)) return;
    const entry: Entry = {
      wireId, public: { id: randomUUID(), tool: 'question', summary: '' }, sent: false,
      questions: { items, index: 0, answers: Object.create(null) },
    };
    this.#question(entry);
    this.#entries.push(entry);
    this.#show();
  }

  addElicitation(wireId: string | number, elicitation: Elicitation): void {
    if (this.#entries.some(e => e.wireId === wireId)) return;
    this.#entries.push({wireId, sent:false, elicitation, public:{id:randomUUID(),tool:elicitation.public.server,
      summary:elicitation.public.message, elicitation:elicitation.public}});
    this.#show();
  }

  respondElicitation(id: string, response: unknown): boolean {
    const head=this.#entries[0];
    if(!head || head.sent || head.public.id!==id || !head.elicitation)return false;
    const result=elicitationResult(head.elicitation,response);
    if(!result)return false;
    head.sent=true;this.#respond(head.wireId,result);this.#show();return true;
  }

  elicitationUrl(id: string): string | null {
    const head=this.#entries[0];
    return head && !head.sent && head.public.id===id ? head.elicitation?.url??null : null;
  }

  answer(requestId: string, answer: unknown): boolean {
    const head = this.#entries[0];
    if (!head || head.sent || head.public.id !== requestId || !head.questions) return false;
    const questions = head.questions;
    if (answer && typeof answer === 'object' && Object.keys(answer).length === 1
      && 'skip' in answer && answer.skip === true) {
      head.sent = true;
      questions.answers = Object.create(null);
      this.#respond(head.wireId, { answers: {} });
    } else {
      const question = questions.items[questions.index];
      const text = questionAnswer(answer, question);
      if (text === null) return false;
      questions.answers[question.wireId] = { answers: [text] };
      if (++questions.index === questions.items.length) {
        head.sent = true;
        const answers = questions.answers;
        questions.answers = Object.create(null);
        this.#respond(head.wireId, { answers: { ...answers } });
      } else {
        this.#question(head);
      }
    }
    this.#show();
    return true;
  }

  decide(allow: boolean): void {
    const head = this.#entries[0];
    if (!head || head.sent || head.questions || head.elicitation) return;
    this.#send(head, allow);
    this.#show();
  }

  resolved(id: string | number): void {
    const index = this.#entries.findIndex(e => e.wireId === id);
    if (index < 0) return;
    this.#entries.splice(index, 1);
    this.#show();
  }

  setAuto(on: boolean): void {
    this.#auto = on;
    if (on) for (const entry of [...this.#entries]) {
      if (!entry.sent && !entry.questions && !entry.elicitation) this.#send(entry, true);
    }
    this.#show();
  }

  cancel(): void {
    const entries = this.#entries.splice(0);
    try {
      for (const entry of entries) if (!entry.sent) {
        this.#respond(entry.wireId, entry.elicitation ? {action:'cancel',content:null,_meta:null} : entry.questions ? { answers: {} } : 'decline');
      }
    } finally { this.#show(); }
  }

  #question(entry: Entry): void {
    const { items, index } = entry.questions!;
    const question = items[index].public;
    entry.public = { id: randomUUID(), tool: 'question', summary: question.prompt,
      question: { ...question, index: index + 1, total: items.length } };
  }

  #send(entry: Entry, allow: boolean): void {
    entry.sent = true;
    this.#respond(entry.wireId, allow ? 'accept' : 'decline');
  }

  #show(): void {
    const head = this.#entries[0];
    const pending = head && !(this.#auto && head.sent && !head.questions && !head.elicitation)
      ? { ...head.public, responding: head.sent, pendingCount: this.#entries.length } : null;
    if (pending || this.#visible) this.#publish(pending);
    this.#visible = pending !== null;
  }
}
