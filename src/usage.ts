const WINDOW_MS = 5 * 3600_000;

type Sample = { t: number; tokens: number };

export class Usage {
  #samples = new Map<string, Sample[]>();

  record(account: string, inputTokens: number, outputTokens: number, now = Date.now()): void {
    const list = this.#samples.get(account) ?? [];
    list.push({ t: now, tokens: inputTokens + outputTokens });
    this.#samples.set(account, list);
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
