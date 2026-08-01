import { randomUUID } from 'node:crypto';
import type { Action, Queued, Trigger } from './types.ts';

/**
 * How late a timed item may still fire. The server kills every agent when it
 * stops, so a scheduled time routinely passes while Switchboard is down or the
 * laptop is asleep; firing on the next start is almost always what "run this"
 * meant. Past this window it isn't — a week-old item firing on boot is noise.
 *
 * ponytail: one constant, no per-item override. Add one if you start scheduling
 * things further out than this.
 */
export const GRACE_MS = 12 * 3600_000;

/** What `due()` needs to know about the world, passed in rather than reached
 *  for — this is what keeps the Scheduler testable with a fake clock. */
export type Ctx = {
  /** Is there room to start work on this account right now? */
  free(account: string): boolean;
  /** Does this account have a session in `working` or `needs-you`? */
  busy(account: string): boolean;
};

/**
 * The queue of one-shot scheduled chats.
 *
 * It decides, it does not act: `due()` returns the items that should fire and
 * the caller runs them (through the server's existing `command()`), then calls
 * `remove()` on success or `fail()` on error. The only state this class touches
 * is its own list.
 */
export class Scheduler {
  #items = new Map<string, Queued>();

  add(trigger: Trigger, action: Action, now = Date.now()): Queued {
    const item: Queued = {
      id: randomUUID(), trigger, action, createdAt: now, state: 'waiting', error: null,
    };
    this.#items.set(item.id, item);
    return item;
  }

  remove(id: string): void {
    this.#items.delete(id);
  }

  fail(id: string, error: string): void {
    const item = this.#items.get(id);
    if (!item) return;
    item.state = 'failed';
    item.error = error;
  }

  all(): Queued[] {
    return [...this.#items.values()];
  }

  /**
   * The items that should fire now. Marks overdue timed items `missed` as it
   * scans — the one piece of state it mutates.
   *
   * Map iteration is insertion order, so a per-account drain is FIFO: the oldest
   * queued item on an account goes first.
   */
  due(now: number, ctx: Ctx): Queued[] {
    const out: Queued[] = [];
    // Accounts already claimed in this same pass. Without it, two reset-items on
    // one account both fire before either has had a chance to reach `working`,
    // and a freshly reset window is spent in seconds.
    const claimed = new Set<string>();

    for (const item of this.#items.values()) {
      if (item.state !== 'waiting') continue;

      if (item.trigger.kind === 'at') {
        if (now < item.trigger.time) continue;
        if (now - item.trigger.time > GRACE_MS) {
          item.state = 'missed';
          item.error = `overdue by more than ${GRACE_MS / 3600_000}h`;
          continue;
        }
        // Deliberately no free/busy check: the user named a time.
        out.push(item);
        continue;
      }

      const account = item.trigger.account;
      if (claimed.has(account)) continue;
      if (!ctx.free(account) || ctx.busy(account)) continue;
      claimed.add(account);
      out.push(item);
    }
    return out;
  }

  toJSON(): Queued[] {
    return this.all();
  }

  /** Inverse of toJSON(). state.json is hand-editable, so anything that isn't a
   *  usable item is dropped rather than thrown on. Validates shape and domain
   *  constraints (state, trigger kind, trigger fields) to prevent silent failures
   *  or eager fires from corrupted input. */
  restore(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const raw of data as Queued[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (!raw.trigger || typeof raw.trigger !== 'object') continue;
      if (!raw.action || typeof raw.action !== 'object') continue;
      // Validate state to prevent items stuck waiting forever on an unrecognized state.
      if (raw.state !== 'waiting' && raw.state !== 'missed' && raw.state !== 'failed') continue;
      // Validate trigger kind and its fields.
      if (raw.trigger.kind === 'at') {
        if (!Number.isFinite(raw.trigger.time)) continue;
      } else if (raw.trigger.kind === 'reset') {
        if (typeof raw.trigger.account !== 'string') continue;
      } else {
        // Unrecognized trigger kind; drop it.
        continue;
      }
      this.#items.set(raw.id, raw);
    }
  }
}
