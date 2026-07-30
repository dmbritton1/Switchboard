const WINDOW_MS = 5 * 3600_000;

type Sample = { t: number; tokens: number };

export class Usage {
  #samples = new Map<string, Sample[]>();

  record(account: string, inputTokens: number, outputTokens: number, now = Date.now()): void {
    // Prune on write: samples outside the trailing window can never affect pace()
    // again, and this list is now persisted to state.json — unpruned it would be a
    // file that only grows for the lifetime of the install.
    const list = (this.#samples.get(account) ?? []).filter((s) => s.t > now - WINDOW_MS);
    list.push({ t: now, tokens: inputTokens + outputTokens });
    this.#samples.set(account, list);
  }

  /** Serialized into state.json alongside sessions so pace survives a restart. */
  toJSON(): Record<string, Sample[]> {
    return Object.fromEntries(this.#samples);
  }

  /** Inverse of toJSON(). Tolerates anything: state.json is user-editable and may
   *  predate usage persistence entirely, so bad input is dropped, not thrown on. */
  restore(data: unknown, now = Date.now()): void {
    if (!data || typeof data !== 'object') return;
    const cutoff = now - WINDOW_MS;
    for (const [account, list] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept = (list as Sample[]).filter(
        (s) => s && typeof s.t === 'number' && typeof s.tokens === 'number' && s.t > cutoff,
      );
      if (kept.length) this.#samples.set(account, kept);
    }
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

  freestAccount(accounts: { name: string; budget: number }[], now = Date.now()): string {
    if (accounts.length === 0) throw new Error('no accounts configured');
    let best = accounts[0];
    let bestPace = this.pace(best.name, best.budget, now);
    for (const a of accounts.slice(1)) {
      const p = this.pace(a.name, a.budget, now);
      if (p < bestPace) { best = a; bestPace = p; }
    }
    return best.name;
  }
}
