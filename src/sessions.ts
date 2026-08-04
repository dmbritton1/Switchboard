import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { AdapterEvent, CodexFailureCode, PromptDelivery, Session } from './types.ts';
import type { Usage } from './usage.ts';
import type { Scheduler } from './schedule.ts';

type Init = Pick<Session, 'provider' | 'account' | 'repo' | 'cwd' | 'branch' | 'title'>;

function unsentMessage(count: number): string {
  const noun = count === 1 ? 'prompt was' : 'prompts were';
  return `${count} queued ${noun} not sent. Resend ${count === 1 ? 'it' : 'them'} manually if still needed.`;
}

/**
 * Longest tool output kept. Not a display choice — a storage one: every
 * transcript is serialized whole into the SSE snapshot on every agent message
 * (see snapshot() in server.ts) and rewritten to state.json on every save, so
 * one `cat` of a large file would otherwise be re-sent hundreds of times and
 * persisted forever.
 */
export const MAX_RESULT = 2000;

/**
 * Tool output as stored. Keeps the *tail*: a command that failed explains itself
 * at the end, and failures are what the output is being read for. The dropped
 * count is stated rather than left as a bare ellipsis, so a truncated result is
 * never mistaken for the whole story.
 *
 * ponytail: one flat cap for every tool. A per-tool policy (head for Read, tail
 * for Bash) is a table to maintain for a case nobody has hit yet.
 */
export function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT) return text;
  return `[${text.length - MAX_RESULT} earlier characters not shown]\n${text.slice(-MAX_RESULT)}`;
}

export class Registry {
  #sessions = new Map<string, Session>();
  #subs = new Set<() => void>();
  #path: string;
  // Optional so tests (and anything that only cares about sessions) can skip it.
  // The Registry owns the one save/load path, so persisting usage means handing
  // the Usage instance to it rather than inventing a second state file.
  #usage: Usage | undefined;
  // Optional for the same reason #usage is: tests that only care about sessions
  // shouldn't have to build one. The Registry owns the single save/load path, so
  // persisting the queue means handing it the Scheduler rather than inventing a
  // second state file.
  #scheduler: Scheduler | undefined;
  // Chains every save() behind the previous one so concurrent callers never
  // run writeFile/rename on the same temp path at once. See save() below.
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string, usage?: Usage, scheduler?: Scheduler) {
    this.#path = path;
    this.#usage = usage;
    this.#scheduler = scheduler;
  }

  create(init: Init): Session {
    const now = Date.now();
    const s: Session = {
      ...init,
      id: randomUUID(),
      vendorSessionId: null,
      status: 'working',
      auto: false,
      transcript: [],
      pending: null,
      stoppedReason: null,
      stoppedCode: null,
      startedAt: now,
      statusSince: now,
    };
    this.#sessions.set(s.id, s);
    this.#notify();
    return s;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  all(): Session[] {
    return [...this.#sessions.values()];
  }

  remove(id: string): void {
    this.#sessions.delete(id);
    this.#notify();
  }

  appendPrompt(id: string, text: string, delivery: PromptDelivery): string {
    const s = this.#sessions.get(id);
    const promptId = randomUUID();
    if (!s) return promptId;
    s.transcript.push({ kind: 'user', id: promptId, text, delivery });
    this.#notify();
    return promptId;
  }

  apply(id: string, e: AdapterEvent): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    // A stopped session is terminal until an explicit resume replaces it.
    if (s.status === 'stopped' && e.type !== 'vendor-session-id') return;

    switch (e.type) {
      case 'status':
        // A pending approval outranks any status an adapter reports. The Claude
        // adapter emits `working` on every SDK message and on every send(), both
        // of which run concurrently with a blocked canUseTool() — so an unguarded
        // apply moved a session with a populated `pending` off `needs-you`,
        // losing its sort-first position, its browser notification and its title
        // counter while the Allow/Deny buttons still showed. Guarding here rather
        // than in the adapter covers both adapters and any future one. Safe
        // because `pending` is only ever cleared by `approval-resolved`,
        // `stopped` and revive(), each of which sets the status itself.
        if (!s.pending) this.#setStatus(s, e.status);
        break;
      case 'msg':
        // Codex delivers tool output on the message itself (it has no separate
        // result event), so the cap has to apply on this path too — this and the
        // 'tool-result' branch below are the only two ways output is ever stored.
        s.transcript.push(e.msg.kind === 'tool' && e.msg.result
          ? { ...e.msg, result: truncateResult(e.msg.result) }
          : e.msg);
        break;
      case 'approval':
        s.pending = e.request;
        this.#setStatus(s, 'needs-you');
        break;
      case 'approval-resolved':
        s.pending = null;
        this.#setStatus(s, 'working');
        break;
      case 'vendor-session-id':
        s.vendorSessionId = e.id;
        break;
      case 'tool-result': {
        const msg = s.transcript.find((m) => m.kind === 'tool' && m.id === e.id);
        // A question is always resolved by denying it — that is the only way to
        // hand an answer back through the SDK (see claude.ts decide) — so its
        // tool_result is unconditionally is_error. Answered and skipped are both
        // decisions, not failures, and neither should render as a red card.
        if (msg && msg.kind === 'tool') {
          msg.status = e.ok || msg.name === 'AskUserQuestion' ? 'ok' : 'error';
          // An answered question's "result" is the SDK's own denial boilerplate,
          // not output worth reading — the chosen label already shows on the card.
          if (e.text && msg.name !== 'AskUserQuestion') msg.result = truncateResult(e.text);
        }
        break;
      }
      case 'prompt-delivery': {
        const msg = s.transcript.find((m) => m.kind === 'user' && m.id === e.id);
        if (msg && msg.kind === 'user') msg.delivery = e.delivery;
        break;
      }
      case 'stopped':
        s.pending = null;
        s.stoppedReason = e.reason;
        s.stoppedCode = e.code ?? null;
        this.#setStatus(s, 'stopped');
        break;
      case 'usage':
        break; // handled by the caller, which owns the Usage instance
      case 'rate-limit':
        break; // per-account, not per-session — handled by the caller, which owns Usage
    }
    this.#notify();
  }

  #setStatus(s: Session, status: Session['status']): void {
    if (s.status === status) return;
    s.status = status;
    s.statusSince = Date.now();
  }

  /**
   * Explicitly revives a stopped session (used by `resume`). `apply()`
   * deliberately treats `stopped` as terminal — see its guard above — so
   * reviving can't go through it; this is a separate, deliberate transition
   * with its own notifying method instead of a caller reaching in and
   * mutating the session object directly (which would skip #notify() and
   * leave SSE subscribers showing a stale `stopped` card).
   */
  revive(id: string): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    s.pending = null;
    s.stoppedReason = null;
    s.stoppedCode = null;
    this.#setStatus(s, 'working');
    this.#notify();
  }

  /** Records a readiness failure while preserving the terminal stopped state. */
  recordStoppedFailure(id: string, reason: string, code: CodexFailureCode): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    s.pending = null;
    s.stoppedReason = reason;
    s.stoppedCode = code;
    s.transcript.push({ kind: 'error', text: reason });
    s.status = 'stopped';
    s.statusSince = Math.max(Date.now(), s.statusSince + 1);
    this.#notify();
  }

  /** Sets the auto-approve flag. Separate from apply() because this is a user
   *  decision, not an adapter event — and it must work on a `stopped` session,
   *  which apply()'s terminal guard would drop. */
  setAuto(id: string, on: boolean): void {
    const s = this.#sessions.get(id);
    if (!s || s.auto === on) return;
    s.auto = on;
    this.#notify();
  }

  subscribe(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /**
   * Notifies subscribers with no session mutation of its own. A refresh pass
   * writes new plan limits straight into the Usage instance the Registry does
   * not own, so nothing here detects that change on its own — the caller
   * (the entry-point refresh loop) calls this once the pass completes so an
   * open SSE stream actually sees the new numbers instead of waiting for the
   * next unrelated session event.
   */
  touch(): void {
    this.#notify();
  }

  #notify(): void {
    for (const fn of this.#subs) fn();
  }

  /**
   * Writes are serialized behind #saveChain rather than given unique temp
   * filenames: two concurrent save() calls used to both write `path + '.tmp'`
   * and race each other's rename, so up to 3 of 4 concurrent saves could
   * reject with ENOENT. Chaining is the smaller fix — no extra filenames to
   * clean up on failure, and it also collapses redundant back-to-back writes
   * of identical state into the same queue position. The temp file still
   * lives next to the destination and is only renamed in after a full write,
   * so a crash mid-write still leaves the previous good state.json intact.
   * The chain link itself always resolves (errors are swallowed there) so a
   * failed save doesn't wedge every save after it; the rejection still
   * propagates to the caller that triggered it, via the returned promise.
   */
  async save(): Promise<void> {
    if (this.#path === '/dev/null') return;
    const next = this.#saveChain.then(() => this.#writeNow());
    this.#saveChain = next.catch(() => {});
    return next;
  }

  async #writeNow(): Promise<void> {
    const tmpPath = this.#path + '.tmp';
    const state = {
      sessions: this.all(),
      usage: this.#usage?.toJSON() ?? {},
      queue: this.#scheduler?.toJSON() ?? [],
    };
    await writeFile(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, this.#path);
  }

  static async load(path: string, usage?: Usage, scheduler?: Scheduler): Promise<Registry> {
    const reg = new Registry(path, usage, scheduler);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      // state.json used to be a bare array of sessions; it is now
      // { sessions, usage }. Read both shapes so an existing file keeps its
      // sessions across the upgrade (it just has no usage history to restore) —
      // a shape change must not be worse than the corrupt-JSON path below.
      const isNew = !Array.isArray(parsed);
      const raw = isNew ? (parsed as { sessions?: unknown }).sessions : parsed;
      if (isNew) {
        usage?.restore((parsed as { usage?: unknown }).usage);
        // Absent in any state.json written before scheduling existed; restore()
        // drops a non-array, so the missing key needs no special case here.
        scheduler?.restore((parsed as { queue?: unknown }).queue);
      }
      // state.json is hand-editable, so treat it as untrusted: a `sessions` value
      // that is a string would otherwise be iterated character by character into
      // garbage sessions keyed on `undefined`.
      for (const s of (Array.isArray(raw) ? raw : []) as Session[]) {
        if (!s || typeof s.id !== 'string') continue;
        let interruptedCount = 0;
        const transcript = (Array.isArray(s.transcript) ? s.transcript : []).flatMap((message) => {
          if (!message || typeof message !== 'object') return [];
          if (message.kind !== 'user') return message;
          const wasQueued = message.delivery === 'queued';
          if (wasQueued) interruptedCount++;
          return [{
            kind: 'user' as const,
            id: message.id ?? randomUUID(),
            text: message.text,
            delivery: wasQueued ? 'unsent' as const : message.delivery ?? 'sent' as const,
          }];
        });
        if (interruptedCount > 0) {
          transcript.push({ kind: 'error', text: unsentMessage(interruptedCount) });
        }
        // Agents are children of this process; nothing survived the restart.
        reg.#sessions.set(s.id, {
          ...s,
          transcript,
          status: 'stopped',
          statusSince: Date.now(),
          stoppedReason: s.stoppedReason ?? 'switchboard restarted',
          stoppedCode: s.stoppedCode ?? null,
          pending: null,
          // Predates the auto toggle in any state.json written before it existed,
          // and `undefined` would render as an indeterminate checkbox.
          auto: s.auto ?? false,
        });
      }
    } catch {
      return reg;
    }
    return reg;
  }
}
