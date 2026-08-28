import { probeLimits } from './agents/claude.ts';
import { CodexAppServerSupervisor } from './agents/codex-app-server-supervisor.ts';
import { CODEX_TELEMETRY_REASONS } from './agents/codex-limits.ts';
import { prepareCodexRuntime, redactValues, type PreparedCodexRuntime } from './agents/codex-runtime.ts';
import type { Account } from './server.ts';
import type { AccountLimitSnapshot } from './types.ts';
import { Usage } from './usage.ts';

const CLAUDE_FAILURE = 'Unable to refresh account limits. Check that this account is signed in.';
const CODEX_FAILURE = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const BOUNDARY_TIMEOUT = 'Timed out waiting for a fresh Codex limit read.';
const STABLE_CODEX_AUTH_FAILURES = new Set<string>([
  CODEX_TELEMETRY_REASONS.apiKey,
  CODEX_TELEMETRY_REASONS.signedOut,
  CODEX_TELEMETRY_REASONS.bedrock,
  CODEX_TELEMETRY_REASONS.externalTokens,
]);

export type ResetRelease = { ready: boolean; reason: string };

export type CodexLimitSupervisor = Pick<
  CodexAppServerSupervisor,
  'reconcile' | 'readAtResetBoundary' | 'close'
>;

export type CodexSupervisorFactory = (options: {
  account: Account;
  runtime: PreparedCodexRuntime;
  onSnapshot: (snapshot: AccountLimitSnapshot) => void;
  onStale: (reason: string) => void;
}) => CodexLimitSupervisor;

export interface AccountLimitCoordinator {
  start(): Promise<void>;
  reconcile(): Promise<void>;
  codexResetEligibility(
    account: string,
    now?: number,
  ): ReturnType<Usage['authoritativeResetEligibility']>;
  releaseCodexAfterFreshRead(account: string, now?: number): Promise<ResetRelease>;
  close(): Promise<void>;
}

export type AccountLimitCoordinatorOptions = {
  accounts: Account[];
  usage: Usage;
  onChange: () => void;
  prepareCodex?: typeof prepareCodexRuntime;
  probeClaude?: typeof probeLimits;
  supervisorFactory?: CodexSupervisorFactory;
  now?: () => number;
  boundaryTimeoutMs?: number;
};

function isCleanSnapshot(value: unknown): value is AccountLimitSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<AccountLimitSnapshot>;
  if (snapshot.authoritative !== true
    || snapshot.fresh !== true
    || !Number.isFinite(snapshot.fetchedAt)
    || (snapshot.plan !== null && (typeof snapshot.plan !== 'string' || snapshot.plan.length === 0))
    || !Array.isArray(snapshot.windows)
    || snapshot.windows.length === 0
    || !Array.isArray(snapshot.blocks)) return false;
  const ids = new Set<string>();
  const validWindows = snapshot.windows.every((window) => {
    const valid = !!window
      && typeof window.id === 'string'
      && window.id.length > 0
      && typeof window.label === 'string'
      && window.label.length > 0
      && typeof window.usedPercent === 'number'
      && Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0
      && (window.windowDurationMins === null
        || (typeof window.windowDurationMins === 'number'
          && Number.isFinite(window.windowDurationMins)
          && window.windowDurationMins >= 0))
      && (window.resetsAt === null
        || (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)))
      && typeof window.reached === 'boolean'
      && window.reached === (window.usedPercent >= 100)
      && !ids.has(window.id);
    if (valid) ids.add(window.id);
    return valid;
  });
  return validWindows
    && snapshot.blocks.every((block) => !!block
      && typeof block.id === 'string'
      && block.id.length > 0
      && typeof block.reason === 'string'
      && block.reason.length > 0
      && typeof block.resettable === 'boolean');
}

class Coordinator implements AccountLimitCoordinator {
  readonly #accounts: Account[];
  readonly #usage: Usage;
  readonly #onChange: () => void;
  readonly #prepareCodex: typeof prepareCodexRuntime;
  readonly #probeClaude: typeof probeLimits;
  readonly #supervisorFactory: CodexSupervisorFactory;
  readonly #now: () => number;
  readonly #boundaryTimeoutMs: number;
  readonly #supervisors = new Map<string, CodexLimitSupervisor>();
  readonly #starting = new Map<string, Promise<CodexLimitSupervisor>>();
  readonly #boundaryReads = new Map<string, Promise<ResetRelease>>();
  #reconciliation: Promise<void> | null = null;
  #reconciliationActive = false;
  #reconciliationChanged = false;
  #close: Promise<void> | null = null;
  #closed = false;

  constructor(options: AccountLimitCoordinatorOptions) {
    this.#accounts = options.accounts;
    this.#usage = options.usage;
    this.#onChange = options.onChange;
    this.#prepareCodex = options.prepareCodex ?? prepareCodexRuntime;
    this.#probeClaude = options.probeClaude ?? probeLimits;
    this.#supervisorFactory = options.supervisorFactory ?? ((supervisorOptions) => new CodexAppServerSupervisor({
      runtime: supervisorOptions.runtime,
      onSnapshot: supervisorOptions.onSnapshot,
      onStale: supervisorOptions.onStale,
    }));
    this.#now = options.now ?? Date.now;
    this.#boundaryTimeoutMs = options.boundaryTimeoutMs ?? 5_000;
  }

  start(): Promise<void> {
    return this.reconcile();
  }

  reconcile(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#reconciliation) return this.#reconciliation;
    const pass = this.#runReconciliation();
    this.#reconciliation = pass;
    void pass.finally(() => {
      if (this.#reconciliation === pass) this.#reconciliation = null;
    }).catch(() => {});
    return pass;
  }

  codexResetEligibility(account: string, now = this.#now()): ReturnType<Usage['authoritativeResetEligibility']> {
    this.#codexAccount(account);
    return this.#usage.authoritativeResetEligibility(account, now);
  }

  async releaseCodexAfterFreshRead(account: string, now = this.#now()): Promise<ResetRelease> {
    this.#codexAccount(account);
    const current = this.#usage.authoritativeResetEligibility(account, now);
    if (current.eligible && now < current.resetsAt) {
      return { ready: false, reason: 'Codex reset boundary has not arrived.' };
    }
    const existing = this.#boundaryReads.get(account);
    if (existing) return existing;
    const read = this.#readBoundary(account, now);
    this.#boundaryReads.set(account, read);
    void read.finally(() => {
      if (this.#boundaryReads.get(account) === read) this.#boundaryReads.delete(account);
    }).catch(() => {});
    return read;
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async #runReconciliation(): Promise<void> {
    this.#reconciliationActive = true;
    this.#reconciliationChanged = false;
    try {
      await Promise.allSettled(this.#accounts.map((account) => this.#reconcileAccount(account)));
    } finally {
      this.#reconciliationActive = false;
      const changed = this.#reconciliationChanged;
      this.#reconciliationChanged = false;
      if (changed) this.#notifyChanged();
    }
  }

  async #reconcileAccount(account: Account): Promise<void> {
    if (account.provider === 'claude') {
      try {
        this.#storeSnapshot(account.name, await this.#probeClaude(account.env));
      } catch (error) {
        this.#fail(account, error, CLAUDE_FAILURE);
      }
      return;
    }
    try {
      const supervisor = await this.#supervisor(account);
      this.#storeSnapshot(account.name, await supervisor.reconcile());
    } catch (error) {
      this.#fail(account, error, CODEX_FAILURE);
    }
  }

  async #readBoundary(accountName: string, now: number): Promise<ResetRelease> {
    const account = this.#codexAccount(accountName);
    try {
      const supervisor = await this.#supervisor(account);
      const result = await this.#withBoundaryTimeout(supervisor.readAtResetBoundary(now));
      if (result.timedOut) return { ready: false, reason: BOUNDARY_TIMEOUT };
      if (!isCleanSnapshot(result.snapshot)) {
        this.#fail(account, new Error(CODEX_FAILURE), CODEX_FAILURE);
        return { ready: false, reason: CODEX_FAILURE };
      }
      this.#storeSnapshot(account.name, result.snapshot);
      return this.#releaseFromSnapshot(result.snapshot);
    } catch (error) {
      this.#fail(account, error, CODEX_FAILURE);
      return { ready: false, reason: CODEX_FAILURE };
    }
  }

  async #withBoundaryTimeout(read: Promise<AccountLimitSnapshot>): Promise<
    { timedOut: true } | { timedOut: false; snapshot: unknown }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = read.then(
      (snapshot) => ({ kind: 'snapshot' as const, snapshot }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    );
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.#boundaryTimeoutMs);
    });
    try {
      const result = await Promise.race([settled, timeout]);
      if (result.kind === 'snapshot') return { timedOut: false, snapshot: result.snapshot };
      if (result.kind === 'timeout') return { timedOut: true };
      throw result.error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #releaseFromSnapshot(snapshot: AccountLimitSnapshot): ResetRelease {
    if (!isCleanSnapshot(snapshot)) return { ready: false, reason: CODEX_FAILURE };
    if (snapshot.blocks.length > 0) return { ready: false, reason: 'Codex account is blocked by provider limits.' };
    if (snapshot.windows.some((window) => window.reached)) {
      return { ready: false, reason: 'A Codex limit window remains reached.' };
    }
    return { ready: true, reason: 'Codex account limits are available.' };
  }

  #codexAccount(name: string): Account {
    const account = this.#accounts.find((candidate) => candidate.name === name);
    if (!account || account.provider !== 'codex') throw new Error('Codex account is required.');
    return account;
  }

  #supervisor(account: Account): Promise<CodexLimitSupervisor> {
    const existing = this.#supervisors.get(account.name);
    if (existing) return Promise.resolve(existing);
    const starting = this.#starting.get(account.name);
    if (starting) return starting;
    const create = this.#createSupervisor(account);
    this.#starting.set(account.name, create);
    void create.finally(() => {
      if (this.#starting.get(account.name) === create) this.#starting.delete(account.name);
    }).catch(() => {});
    return create;
  }

  async #createSupervisor(account: Account): Promise<CodexLimitSupervisor> {
    const runtime = await this.#prepareCodex({ bin: account.bin, env: account.env });
    if (this.#closed) throw new Error(CODEX_FAILURE);
    const supervisor = this.#supervisorFactory({
      account,
      runtime,
      onSnapshot: (snapshot) => this.#storeSnapshot(account.name, snapshot),
      onStale: (reason) => this.#fail(account, reason, CODEX_FAILURE),
    });
    this.#supervisors.set(account.name, supervisor);
    return supervisor;
  }

  #fail(account: Account, error: unknown, fallback: string): void {
    // Always redact before this crosses the Usage/SSE boundary. The public value
    // remains a stable action rather than a provider diagnostic.
    const message = redactValues(error instanceof Error ? error.message : String(error), Object.values(account.env));
    const publicError = account.provider === 'codex' && STABLE_CODEX_AUTH_FAILURES.has(message)
      ? message
      : fallback;
    this.#usage.failLimitSnapshot(account.name, publicError);
    this.#notifyChanged();
  }

  #storeSnapshot(account: string, snapshot: AccountLimitSnapshot): void {
    const previous = this.#usage.getLimitSnapshot(account).snapshot;
    this.#usage.setLimitSnapshot(account, snapshot);
    if (previous !== snapshot) this.#notifyChanged();
  }

  #notifyChanged(): void {
    if (this.#closed) return;
    if (this.#reconciliationActive) {
      this.#reconciliationChanged = true;
      return;
    }
    try {
      this.#onChange();
    } catch {
      // Browser notification observers cannot affect telemetry ownership.
    }
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#supervisors.values()].map((supervisor) => supervisor.close()));
  }
}

export function createAccountLimitCoordinator(options: AccountLimitCoordinatorOptions): AccountLimitCoordinator {
  return new Coordinator(options);
}
