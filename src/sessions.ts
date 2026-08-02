import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { MAX_CODEX_DETAIL_TOTAL_BYTES } from './agents/codex-detail.ts';
import type {
  AdapterEvent, CodexFailureCode, PromptDelivery, PublicMsg, PublicSession, Session, ToolMsg, UpsertMsg,
} from './types.ts';
import type { Usage } from './usage.ts';

type Init = Pick<Session, 'provider' | 'account' | 'repo' | 'cwd' | 'branch' | 'title'>;

export type ToolDetailRead = {
  text: string | null;
  truncated: boolean;
  evicted: boolean;
  revision: number;
};

export type RegistryOptions = { maxTotalDetailBytes?: number };

function unsentMessage(count: number): string {
  const noun = count === 1 ? 'prompt was' : 'prompts were';
  return `${count} queued ${noun} not sent. Resend ${count === 1 ? 'it' : 'them'} manually if still needed.`;
}

function safeAttachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((name): name is string => typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0'));
}

export class Registry {
  #sessions = new Map<string, Session>();
  #subs = new Set<() => void>();
  #path: string;
  // Optional so tests (and anything that only cares about sessions) can skip it.
  // The Registry owns the one save/load path, so persisting usage means handing
  // the Usage instance to it rather than inventing a second state file.
  #usage: Usage | undefined;
  #maxTotalDetailBytes: number;
  #nextDetailRevision = 1;
  // Chains every save() behind the previous one so concurrent callers never
  // run writeFile/rename on the same temp path at once. See save() below.
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string, usage?: Usage, options: RegistryOptions = {}) {
    this.#path = path;
    this.#usage = usage;
    this.#maxTotalDetailBytes = options.maxTotalDetailBytes ?? MAX_CODEX_DETAIL_TOTAL_BYTES;
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

  publicSessions(): PublicSession[] {
    return this.all().map((session) => ({
      ...session,
      pending: session.pending ? { ...session.pending } : null,
      transcript: session.transcript.map((message): PublicMsg => {
        if (message.kind !== 'tool') {
          if (message.kind === 'todo') {
            return { ...message, items: message.items.map((item) => ({ ...item })) };
          }
          return { ...message };
        }
        const {
          detail: _detail,
          detailTruncated,
          detailEvicted,
          detailRevision,
          ...summary
        } = message;
        return {
          ...summary,
          detailAvailable: message.detail !== undefined,
          detailTruncated: detailTruncated ?? false,
          detailEvicted: detailEvicted ?? false,
          detailRevision: detailRevision ?? 0,
        };
      }),
    }));
  }

  getToolDetail(sessionId: string, itemId: string): ToolDetailRead | null {
    const session = this.#sessions.get(sessionId);
    const message = session?.transcript.find(
      (candidate): candidate is ToolMsg => candidate.kind === 'tool' && candidate.id === itemId,
    );
    if (!message) return null;
    return {
      text: message.detail ?? null,
      truncated: message.detailTruncated ?? false,
      evicted: message.detailEvicted ?? false,
      revision: message.detailRevision ?? 0,
    };
  }

  remove(id: string): void {
    this.#sessions.delete(id);
    this.#notify();
  }

  appendPrompt(id: string, text: string, delivery: PromptDelivery, attachments: string[] = []): string {
    const s = this.#sessions.get(id);
    const promptId = randomUUID();
    if (!s) return promptId;
    s.transcript.push({
      kind: 'user', id: promptId, text, delivery,
      ...(attachments.length ? { attachments: [...attachments] } : {}),
    });
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
        if (e.msg.kind === 'tool') {
          s.transcript.push(this.#prepareTool(e.msg));
          this.#enforceDetailBudget();
        } else {
          s.transcript.push(e.msg);
        }
        break;
      case 'upsert-msg': {
        const msg = this.#prepareUpsert(e.msg);
        const index = s.transcript.findIndex(
          (candidate) => candidate.kind === msg.kind && 'id' in candidate && candidate.id === msg.id,
        );
        if (index === -1) s.transcript.push(msg);
        else s.transcript[index] = msg;
        this.#enforceDetailBudget();
        break;
      }
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
        if (msg && msg.kind === 'tool') msg.status = e.ok ? 'ok' : 'error';
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
    }
    this.#notify();
  }

  #prepareUpsert(msg: UpsertMsg): UpsertMsg {
    if (msg.kind !== 'tool') {
      return msg.kind === 'todo'
        ? { ...msg, items: msg.items.map((item) => ({ ...item })) }
        : { ...msg };
    }

    return this.#prepareTool(msg);
  }

  #prepareTool<T extends ToolMsg>(msg: T): T {
    const next = { ...msg };
    delete next.detailRevision;
    delete next.detailEvicted;
    if (next.detail !== undefined) {
      next.detailEvicted = false;
      next.detailRevision = this.#nextDetailRevision++;
    }
    return next;
  }

  #enforceDetailBudget(): void {
    let totalBytes = 0;
    const details: ToolMsg[] = [];
    for (const session of this.#sessions.values()) {
      for (const message of session.transcript) {
        if (message.kind !== 'tool' || message.detail === undefined) continue;
        totalBytes += Buffer.byteLength(message.detail, 'utf8');
        details.push(message);
      }
    }

    while (totalBytes > this.#maxTotalDetailBytes && details.length > 0) {
      let oldestIndex = 0;
      for (let index = 1; index < details.length; index++) {
        if ((details[index].detailRevision ?? 0) < (details[oldestIndex].detailRevision ?? 0)) {
          oldestIndex = index;
        }
      }
      const [oldest] = details.splice(oldestIndex, 1);
      totalBytes -= Buffer.byteLength(oldest.detail!, 'utf8');
      delete oldest.detail;
      oldest.detailEvicted = true;
      oldest.detailRevision = this.#nextDetailRevision++;
    }
  }

  #seedDetailRevisions(): void {
    let greatestRevision = 0;
    for (const session of this.#sessions.values()) {
      for (const message of session.transcript) {
        if (message.kind !== 'tool') continue;
        if (typeof message.detailRevision === 'number' && Number.isFinite(message.detailRevision)) {
          greatestRevision = Math.max(greatestRevision, message.detailRevision);
        }
      }
    }

    this.#nextDetailRevision = greatestRevision + 1;
    for (const session of this.#sessions.values()) {
      for (const message of session.transcript) {
        if (message.kind !== 'tool') continue;
        if (message.detail === undefined && !message.detailEvicted) continue;
        if (message.detailRevision === undefined) message.detailRevision = this.#nextDetailRevision++;
        if (message.detail !== undefined && message.detailEvicted === undefined) message.detailEvicted = false;
      }
    }
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
    const state = { sessions: this.all(), usage: this.#usage?.toJSON() ?? {} };
    await writeFile(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, this.#path);
  }

  static async load(path: string, usage?: Usage, options: RegistryOptions = {}): Promise<Registry> {
    const reg = new Registry(path, usage, options);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      // state.json used to be a bare array of sessions; it is now
      // { sessions, usage }. Read both shapes so an existing file keeps its
      // sessions across the upgrade (it just has no usage history to restore) —
      // a shape change must not be worse than the corrupt-JSON path below.
      const isNew = !Array.isArray(parsed);
      const raw = isNew ? (parsed as { sessions?: unknown }).sessions : parsed;
      if (isNew) usage?.restore((parsed as { usage?: unknown }).usage);
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
          const attachments = safeAttachmentNames(message.attachments);
          return [{
            kind: 'user' as const,
            id: message.id ?? randomUUID(),
            text: message.text,
            delivery: wasQueued ? 'unsent' as const : message.delivery ?? 'sent' as const,
            ...(attachments.length ? { attachments } : {}),
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
      reg.#seedDetailRevisions();
      reg.#enforceDetailBudget();
    } catch {
      return reg;
    }
    return reg;
  }
}
