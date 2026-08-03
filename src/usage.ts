import type { AccountLimits } from './types.ts';

const WINDOW_MS = 5 * 3600_000;

/** ponytail: calibration knob. `budget` in accounts.json is hand-tuned per
 *  account, so the threshold that reads pace() has to be tunable too. Lower it
 *  if queued work keeps re-hitting the limit; raise it if items sit too long. */
export const RESET_PACE = 0.8;

type Sample = { t: number; tokens: number };

export class Usage {
  #samples = new Map<string, Sample[]>();
  /** account -> epoch ms at which its window rolls. Only set while the account is
   *  actually rejected; an `allowed` event deletes the entry so a stale limit
   *  can't suppress the pace fallback forever. */
  #resets = new Map<string, number>();

  /** Real plan limits per account, or why there are none. Deliberately not in
   *  toJSON(): a utilization percentage is wrong the moment this process is not
   *  running, and it is re-fetched about two seconds after startup. */
  #limits = new Map<string, { limits: AccountLimits | null; error: string | null }>();

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
    // The SDK types resetsAt as a bare `number` with no documented unit. Values in
    // the plausible-seconds band [1e9, 1e11) represent times between ~2001 and ~5138;
    // anything outside it is either a real millisecond timestamp or a fake-clock test
    // value, and gets left exactly as given.
    this.#resets.set(account, resetsAt >= 1e9 && resetsAt < 1e11 ? resetsAt * 1000 : resetsAt);
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

  setLimits(account: string, limits: AccountLimits | null, error: string | null): void {
    this.#limits.set(account, { limits, error });
  }

  getLimits(account: string): { limits: AccountLimits | null; error: string | null } {
    return this.#limits.get(account) ?? { limits: null, error: null };
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

  /**
   * `load` is the caller's already-resolved fraction (real plan utilization);
   * `pace` is the local estimate. Taking the override here rather than letting
   * callers rank for themselves is what keeps this from disagreeing with the
   * account picker in web/app.js, which ranks on the same server-computed number.
   */
  freestAccount(
    accounts: { name: string; budget: number; load?: number }[],
    now = Date.now(),
  ): string {
    if (accounts.length === 0) throw new Error('no accounts configured');
    const load = (a: { name: string; budget: number; load?: number }) =>
      a.load ?? this.pace(a.name, a.budget, now);
    let best = accounts[0];
    let bestLoad = load(best);
    for (const a of accounts.slice(1)) {
      const l = load(a);
      if (l < bestLoad) { best = a; bestLoad = l; }
    }
    return best.name;
  }
}
