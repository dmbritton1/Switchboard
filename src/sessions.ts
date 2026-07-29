import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { AdapterEvent, Session } from './types.ts';

type Init = Pick<Session, 'provider' | 'account' | 'repo' | 'cwd' | 'branch' | 'title'>;

export class Registry {
  #sessions = new Map<string, Session>();
  #subs = new Set<() => void>();
  #path: string;
  // Chains every save() behind the previous one so concurrent callers never
  // run writeFile/rename on the same temp path at once. See save() below.
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  create(init: Init): Session {
    const now = Date.now();
    const s: Session = {
      ...init,
      id: randomUUID(),
      vendorSessionId: null,
      status: 'working',
      transcript: [],
      pending: null,
      stoppedReason: null,
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

  apply(id: string, e: AdapterEvent): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    // A stopped session is terminal until an explicit resume replaces it.
    if (s.status === 'stopped' && e.type !== 'vendor-session-id') return;

    switch (e.type) {
      case 'status':
        this.#setStatus(s, e.status);
        break;
      case 'msg':
        s.transcript.push(e.msg);
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
        if (msg && msg.kind === 'tool') msg.status = e.ok ? 'ok' : 'error';
        break;
      }
      case 'stopped':
        s.pending = null;
        s.stoppedReason = e.reason;
        this.#setStatus(s, 'stopped');
        break;
      case 'usage':
        break; // handled by the caller, which owns the Usage instance
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
    this.#setStatus(s, 'working');
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
    await writeFile(tmpPath, JSON.stringify(this.all(), null, 2));
    await rename(tmpPath, this.#path);
  }

  static async load(path: string): Promise<Registry> {
    const reg = new Registry(path);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
      for (const s of JSON.parse(raw) as Session[]) {
        // Agents are children of this process; nothing survived the restart.
        reg.#sessions.set(s.id, {
          ...s,
          status: 'stopped',
          statusSince: Date.now(),
          stoppedReason: s.stoppedReason ?? 'switchboard restarted',
          pending: null,
        });
      }
    } catch {
      return reg;
    }
    return reg;
  }
}
