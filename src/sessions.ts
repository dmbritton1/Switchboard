import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { MAX_CODEX_DETAIL_TOTAL_BYTES } from './agents/codex-detail.ts';
import { validateCodexSettings } from './agents/codex-settings.ts';
import type { CodexTransport } from './agents/codex-provider.ts';
import type {
  AdapterEvent, CodexFailureCode, CodexThreadSettings, NotifyOn, PromptDelivery, PublicMsg, PublicSession, Session, Settings, ToolMsg, TurnUsage, UpsertMsg,
} from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type { Usage } from './usage.ts';
import type { Scheduler } from './schedule.ts';

type Init = Pick<Session, 'provider' | 'account' | 'repo' | 'cwd' | 'branch' | 'title' | 'codexSettings' | 'codexTransport'>;
type StoredSession = Session & {
  /** Fail-closed persistence marker; never projected through PublicSession. */
  codexTransportInvalid?: true;
};

const INVALID_STORED_TRANSPORT = 'This Codex session has an invalid stored transport. Delete it and create a new session.';

function isCodexTransport(value: unknown): value is CodexTransport {
  return value === 'sdk' || value === 'app-server';
}

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

function storedTurnUsage(value: unknown): TurnUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Partial<TurnUsage>;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(Number.isFinite(usage.cachedInputTokens) ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(Number.isFinite(usage.cacheWriteInputTokens) ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
    ...(Number.isFinite(usage.reasoningOutputTokens) ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
  };
}

/**
 * Coerces a parsed `settings` value into a real Settings, key by key.
 *
 * state.json is hand-editable and can also be written by a newer build than
 * the one reading it, so every key is validated individually and a bad one
 * falls back to its default rather than poisoning the whole block. Unknown
 * keys are dropped by construction: the output is built from the defaults, not
 * spread from the input.
 */
function coerceSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS, notifyOn: [...DEFAULT_SETTINGS.notifyOn] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.autoApprove === 'boolean') out.autoApprove = r.autoApprove;
  if (typeof r.collapseDone === 'boolean') out.collapseDone = r.collapseDone;
  if (typeof r.autoRequeue === 'boolean') out.autoRequeue = r.autoRequeue;
  if (typeof r.branchPrefix === 'string') out.branchPrefix = r.branchPrefix;
  if (r.account === null || typeof r.account === 'string') out.account = r.account;
  if (r.sort === 'blocked' || r.sort === 'newest' || r.sort === 'account') out.sort = r.sort;
  if (Array.isArray(r.notifyOn)) {
    const valid = r.notifyOn.filter(
      (v): v is NotifyOn => v === 'needs-you' || v === 'done' || v === 'stopped',
    );
    // An array that is present but has nothing valid in it means "notify me
    // about nothing", which is a legitimate choice — so an empty result is
    // kept, unlike a non-array which is a shape error and falls back.
    out.notifyOn = valid;
  }
  return out;
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
  #sessions = new Map<string, StoredSession>();
  #subs = new Set<() => void>();
  #path: string;
  // Optional so tests (and anything that only cares about sessions) can skip it.
  // The Registry owns the one save/load path, so persisting usage means handing
  // the Usage instance to it rather than inventing a second state file.
  #usage: Usage | undefined;
  #maxTotalDetailBytes: number;
  #nextDetailRevision = 1;
  // Optional for the same reason #usage is: tests that only care about sessions
  // shouldn't have to build one. The Registry owns the single save/load path, so
  // persisting the queue means handing it the Scheduler rather than inventing a
  // second state file.
  #scheduler: Scheduler | undefined;
  // Chains every save() behind the previous one so concurrent callers never
  // run writeFile/rename on the same temp path at once. See save() below.
  #saveChain: Promise<void> = Promise.resolve();
  // notifyOn is copied explicitly: a spread is shallow, and sharing the frozen
  // default array means any future in-place mutation throws instead of writing.
  #settings: Settings = { ...DEFAULT_SETTINGS, notifyOn: [...DEFAULT_SETTINGS.notifyOn] };

  constructor(
    path: string,
    usage?: Usage,
    schedulerOrOptions?: Scheduler | RegistryOptions,
    options: RegistryOptions = {},
  ) {
    this.#path = path;
    this.#usage = usage;
    const scheduler = schedulerOrOptions && typeof (schedulerOrOptions as Scheduler).all === 'function'
      ? schedulerOrOptions as Scheduler
      : undefined;
    const resolvedOptions = scheduler ? options : (schedulerOrOptions as RegistryOptions | undefined) ?? options;
    this.#scheduler = scheduler;
    this.#maxTotalDetailBytes = resolvedOptions.maxTotalDetailBytes ?? MAX_CODEX_DETAIL_TOTAL_BYTES;
  }

  create(init: Init, id = randomUUID()): Session {
    if (init.provider === 'codex' && !isCodexTransport(init.codexTransport)) {
      throw new Error('Codex transport must be explicitly selected when creating a Codex session.');
    }
    if (init.provider === 'claude' && Object.hasOwn(init, 'codexTransport')) {
      throw new Error('Claude sessions cannot have a Codex transport.');
    }
    if (this.#sessions.has(id)) throw new Error('Session id is already registered.');
    const now = Date.now();
    const s: StoredSession = {
      ...init,
      id,
      vendorSessionId: null,
      status: 'working',
      auto: false,
      lastUsage: null,
      transcript: [],
      pending: null,
      stoppedReason: null,
      stoppedCode: null,
      ...(init.provider === 'codex' ? { codexTransport: init.codexTransport } : {}),
      ...(init.codexSettings ? { codexSettings: { ...init.codexSettings } } : {}),
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
    return [...this.#sessions.values()].map((storedSession) => {
      const { codexTransportInvalid: _codexTransportInvalid, ...session } = storedSession;
      return {
        ...session,
        lastUsage: session.lastUsage ? { ...session.lastUsage } : null,
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
      };
    });
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
        s.lastUsage = {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          ...(e.cachedInputTokens !== undefined ? { cachedInputTokens: e.cachedInputTokens } : {}),
          ...(e.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: e.cacheWriteInputTokens } : {}),
          ...(e.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: e.reasoningOutputTokens } : {}),
        };
        break;
      case 'rate-limit':
        break; // per-account, not per-session — handled by the caller, which owns Usage
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
    if (next.result) next.result = truncateResult(next.result);
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

  /** Records the initial Codex runtime for diagnostics only. It never changes routing. */
  recordCodexRuntimeVersion(id: string, runtimeVersion: string): void {
    const session = this.#sessions.get(id);
    if (!session
      || session.provider !== 'codex'
      || session.vendorSessionId !== null
      || session.codexRuntimeVersion !== undefined
      || typeof runtimeVersion !== 'string'
      || runtimeVersion.length === 0) return;
    session.codexRuntimeVersion = runtimeVersion;
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

  setCodexSettings(id: string, settings: CodexThreadSettings | undefined): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    if (settings) s.codexSettings = { ...settings };
    else delete s.codexSettings;
    this.#notify();
  }

  settings(): Settings {
    return this.#settings;
  }

  /** Merges a partial over the current settings. A merge rather than a replace
   *  so a client that knows about six settings cannot silently reset a seventh
   *  it has never heard of. Validation belongs to the caller — the server's
   *  `settings` command rejects a bad patch before it reaches here. */
  setSettings(patch: Partial<Settings>): void {
    this.#settings = { ...this.#settings, ...patch };
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
      settings: this.#settings,
    };
    await writeFile(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, this.#path);
  }

  static async load(
    path: string,
    usage?: Usage,
    schedulerOrOptions?: Scheduler | RegistryOptions,
    options: RegistryOptions = {},
  ): Promise<Registry> {
    const scheduler = schedulerOrOptions && typeof (schedulerOrOptions as Scheduler).all === 'function'
      ? schedulerOrOptions as Scheduler
      : undefined;
    const reg = new Registry(path, usage, schedulerOrOptions, options);
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
        // Absent in any state.json written before settings existed;
        // coerceSettings returns the defaults for a missing or junk value.
        reg.#settings = coerceSettings((parsed as { settings?: unknown }).settings);
      }
      // state.json is hand-editable, so treat it as untrusted: a `sessions` value
      // that is a string would otherwise be iterated character by character into
      // garbage sessions keyed on `undefined`.
      for (const s of (Array.isArray(raw) ? raw : []) as StoredSession[]) {
        if (!s || typeof s.id !== 'string') continue;
        let codexSettings: CodexThreadSettings | undefined;
        if (s.provider === 'codex') {
          try {
            codexSettings = validateCodexSettings(s.codexSettings);
          } catch {
            // State is hand-editable: drop malformed settings rather than
            // forwarding an unvalidated value into the SDK on resume.
          }
        }
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
        const hasStoredTransport = Object.hasOwn(s, 'codexTransport');
        const hasInvalidTransportMarker = s.codexTransportInvalid === true;
        const storedTransport = s.codexTransport;
        const codexTransport = s.provider === 'codex'
          ? (hasInvalidTransportMarker
              ? undefined
              : hasStoredTransport
                ? (isCodexTransport(storedTransport) ? storedTransport : undefined)
                : 'sdk')
          : undefined;
        const invalidTransport = s.provider === 'codex'
          && (hasInvalidTransportMarker || (hasStoredTransport && codexTransport === undefined));
        const codexRuntimeVersion = s.provider === 'codex' && typeof s.codexRuntimeVersion === 'string'
          && s.codexRuntimeVersion.length > 0
          ? s.codexRuntimeVersion
          : undefined;
        const {
          codexSettings: _storedCodexSettings,
          codexTransport: _storedCodexTransport,
          codexTransportInvalid: _storedCodexTransportInvalid,
          codexRuntimeVersion: _storedCodexRuntimeVersion,
          ...stored
        } = s;
        reg.#sessions.set(s.id, {
          ...stored,
          ...(codexSettings ? { codexSettings } : {}),
          ...(codexTransport ? { codexTransport } : {}),
          ...(invalidTransport ? { codexTransportInvalid: true as const } : {}),
          ...(codexRuntimeVersion ? { codexRuntimeVersion } : {}),
          transcript,
          status: 'stopped',
          statusSince: Date.now(),
          stoppedReason: invalidTransport ? INVALID_STORED_TRANSPORT : (s.stoppedReason ?? 'switchboard restarted'),
          stoppedCode: s.stoppedCode ?? null,
          pending: null,
          // Predates the auto toggle in any state.json written before it existed,
          // and `undefined` would render as an indeterminate checkbox.
          auto: s.auto ?? false,
          lastUsage: storedTurnUsage(s.lastUsage),
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
