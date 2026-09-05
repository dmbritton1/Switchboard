import type { AccountLimitSnapshot } from './types.ts';

const WINDOW_MS = 5 * 3600_000;

/** ponytail: calibration knob. `budget` in accounts.json is hand-tuned per
 *  account, so the threshold that reads pace() has to be tunable too. Lower it
 *  if queued work keeps re-hitting the limit; raise it if items sit too long. */
export const RESET_PACE = 0.8;

type Sample = { t: number; tokens: number };

/**
 * Provider timestamp fields are inconsistently documented. Values in the
 * plausible epoch-seconds range are seconds; millisecond timestamps and the
 * small fake-clock values used by tests keep their original unit.
 */
export function providerTimestampMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value >= 1e9 && value < 1e11 ? value * 1000 : value;
}

export class Usage {
  #samples = new Map<string, Sample[]>();
  /** account -> epoch ms at which its window rolls. Only set while the account is
   *  actually rejected; an `allowed` event deletes the entry so a stale limit
   *  can't suppress the pace fallback forever. */
  #resets = new Map<string, number>();

  /** Provider reads are display/ranking data, never persisted across a restart. */
  #limitSnapshots = new Map<string, { snapshot: AccountLimitSnapshot | null; error: string | null }>();

  record(account: string, inputTokens: number, outputTokens: number, now = Date.now()): void {
    // Prune on write: samples outside the trailing window can never affect pace()
    // again, and this list is now persisted to state.json — unpruned it would be a
    // file that only grows for the lifetime of the install.
    const list = (this.#samples.get(account) ?? []).filter((s) => s.t > now - WINDOW_MS);
    list.push({ t: now, tokens: inputTokens + outputTokens });
    this.#samples.set(account, list);
  }

  /** Records what the provider said about this account's rate limit. Only a
   *  `rejected` status stores a reset time: `allowed_warning` means there is
   *  still room, so storing its resetsAt would block work that is allowed. */
  noteLimit(
    account: string,
    status: 'allowed' | 'allowed_warning' | 'rejected',
    resetsAt: number | null,
  ): void {
    if (status !== 'rejected' || resetsAt === null || !Number.isFinite(resetsAt)) {
      this.#resets.delete(account);
      return;
    }
    this.#resets.set(account, providerTimestampMs(resetsAt)!);
  }

  resetAt(account: string): number | null {
    return this.#resets.get(account) ?? null;
  }

  /** Is there room to start work on this account right now? A known reset time
   *  is authoritative — the provider told us. Only when we have none (a Codex
   *  account, whose SDK reports no rate limits at all, or a Claude account that
   *  has never been rejected) do we fall back to the local estimate. */
  free(account: string, budget: number, now = Date.now()): boolean {
    const reset = this.#resets.get(account);
    if (reset !== undefined) return now >= reset;
    return this.pace(account, budget, now) < RESET_PACE;
  }

  /** Serialized into state.json alongside sessions so pace and known limits
   *  survive a restart. */
  toJSON(): { samples: Record<string, Sample[]>; resets: Record<string, number> } {
    return {
      samples: Object.fromEntries(this.#samples),
      resets: Object.fromEntries(this.#resets),
    };
  }

  /** Inverse of toJSON(). Tolerates anything: state.json is user-editable and may
   *  predate usage persistence entirely, so bad input is dropped, not thrown on. */
  restore(data: unknown, now = Date.now()): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    // Two shapes to read. The old one is a bare account -> Sample[] map; the new
    // one is { samples, resets }. An account can't be mistaken for the new shape
    // because its value is an array, and `samples` never is.
    const isNew = !!d.samples && typeof d.samples === 'object' && !Array.isArray(d.samples);
    const samples = (isNew ? d.samples : d) as Record<string, unknown>;

    const cutoff = now - WINDOW_MS;
    for (const [account, list] of Object.entries(samples)) {
      if (!Array.isArray(list)) continue;
      const kept = (list as Sample[]).filter(
        (s) => s && typeof s.t === 'number' && typeof s.tokens === 'number' && s.t > cutoff,
      );
      if (kept.length) this.#samples.set(account, kept);
    }

    if (isNew && d.resets && typeof d.resets === 'object') {
      for (const [account, t] of Object.entries(d.resets as Record<string, unknown>)) {
        if (typeof t === 'number' && Number.isFinite(t)) this.#resets.set(account, t);
      }
    }
  }

  setLimitSnapshot(account: string, snapshot: AccountLimitSnapshot): void {
    this.#limitSnapshots.set(account, { snapshot, error: null });
  }

  forgetLimitSnapshot(account: string): void {
    this.#limitSnapshots.delete(account);
  }

  failLimitSnapshot(account: string, error: string): void {
    const previous = this.#limitSnapshots.get(account)?.snapshot ?? null;
    this.#limitSnapshots.set(account, {
      snapshot: previous ? { ...previous, fresh: false } : null,
      error,
    });
  }

  getLimitSnapshot(account: string): { snapshot: AccountLimitSnapshot | null; error: string | null } {
    return this.#limitSnapshots.get(account) ?? { snapshot: null, error: null };
  }

  authoritativeResetEligibility(account: string, now = Date.now()):
    | { eligible: true; resetsAt: number }
    | { eligible: false; reason: string } {
    const snapshot = this.#limitSnapshots.get(account)?.snapshot;
    if (!snapshot || !snapshot.authoritative || !snapshot.fresh) {
      return { eligible: false, reason: 'no fresh authoritative limit snapshot' };
    }
    if (snapshot.blocks.some((block) => block.reason !== 'rate_limit_reached' || !block.resettable)) {
      return { eligible: false, reason: 'a provider block cannot be reset automatically' };
    }
    const reached = snapshot.windows.filter((window) => window.reached);
    if (reached.length === 0) return { eligible: false, reason: 'no reached limit window' };
    if (reached.some((window) => window.resetsAt === null || window.resetsAt <= now)) {
      return { eligible: false, reason: 'a reached limit window has no future reset' };
    }
    return { eligible: true, resetsAt: Math.max(...reached.map((window) => window.resetsAt!)) };
  }

  /** Fraction of `budget` spent in the trailing five hours. Can exceed 1. */
  pace(account: string, budget: number, now = Date.now()): number {
    const list = this.#samples.get(account);
    if (!list || budget <= 0) return 0;
    const cutoff = now - WINDOW_MS;
    let total = 0;
    for (const s of list) if (s.t > cutoff) total += s.tokens;
    return total / budget;
  }
}
