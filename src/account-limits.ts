import { probeLimits } from './agents/claude.ts';
import { CodexAppServerSupervisor } from './agents/codex-app-server-supervisor.ts';
import type { CodexLimitListener } from './agents/codex-app-server-supervisor.ts';
import { CodexProviderPool } from './agents/codex-provider.ts';
import { CODEX_TELEMETRY_REASONS } from './agents/codex-limits.ts';
import { prepareCodexRuntime, redactValues, type PreparedCodexRuntime } from './agents/codex-runtime.ts';
import type { Account } from './accounts.ts';
import type { AccountLimitSnapshot } from './types.ts';
import { Usage } from './usage.ts';

const CLAUDE_FAILURE = 'Unable to refresh account limits. Check that this account is signed in.';
const CODEX_FAILURE = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const BOUNDARY_TIMEOUT = 'Timed out waiting for a fresh Codex limit read.';
const STABLE_CODEX_AUTH_FAILURES = new Set<string>(Object.values(CODEX_TELEMETRY_REASONS));

export type ResetRelease = { ready: boolean; reason: string };

export type CodexLimitSupervisor = Pick<
  CodexAppServerSupervisor,
  'subscribe' | 'reconcile' | 'readAtResetBoundary'
>;

type FactoryCodexSupervisor = Pick<
  CodexAppServerSupervisor,
  'reconcile' | 'readAtResetBoundary' | 'close'
> & Partial<Pick<CodexAppServerSupervisor, 'subscribe'>>;

export type CodexLimitPool = {
  limits(account: Account, listener: CodexLimitListener): Promise<CodexLimitSupervisor>;
  retire(account: Account): Promise<void>;
  close(): Promise<void>;
};

export type CodexSupervisorFactory = (options: {
  account: Account;
  runtime: PreparedCodexRuntime;
  onSnapshot: (snapshot: AccountLimitSnapshot) => void;
  onStale: (reason: string) => void;
}) => FactoryCodexSupervisor;

export interface AccountLimitCoordinator {
  forget(account: Account): Promise<void>;
  start(): Promise<void>;
  reconcile(): Promise<void>;
  codexResetEligibility(
    account: string,
    now?: number,
  ): ReturnType<Usage['authoritativeResetEligibility']>;
  refreshCodexForRecovery(account: string, now?: number): Promise<ReturnType<Usage['authoritativeResetEligibility']>>;
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
  codexPool?: CodexLimitPool;
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

class FactoryCodexPool implements CodexLimitPool {
  readonly #prepare: typeof prepareCodexRuntime;
  readonly #factory: CodexSupervisorFactory;
  readonly #entries = new Map<string, Promise<{
    supervisor: FactoryCodexSupervisor;
    surface: CodexLimitSupervisor;
  }>>();
  #closed = false;
  readonly #retired = new WeakSet<Account>();
  readonly #identities = new Map<string, Account>();
  #close: Promise<void> | null = null;

  constructor(prepare: typeof prepareCodexRuntime, factory: CodexSupervisorFactory) {
    this.#prepare = prepare;
    this.#factory = factory;
  }

  async limits(account: Account, listener: CodexLimitListener): Promise<CodexLimitSupervisor> {
    if (this.#closed || this.#retired.has(account)) throw new Error(CODEX_FAILURE);
    let entry = this.#entries.get(account.name);
    if (!entry) {
      entry = this.#create(account);
      this.#identities.set(account.name, account);
      this.#entries.set(account.name, entry);
      const created = entry;
      void created.catch(() => {
        if (this.#entries.get(account.name) === created) this.#entries.delete(account.name);
      });
    }
    const { surface } = await entry;
    if (this.#closed || this.#retired.has(account)) throw new Error(CODEX_FAILURE);
    surface.subscribe(listener);
    return surface;
  }

  async retire(account: Account): Promise<void> {
    this.#retired.add(account);
    if (this.#identities.get(account.name) !== account) return;
    const entry = this.#entries.get(account.name);
    this.#entries.delete(account.name);
    this.#identities.delete(account.name);
    const prepared = await entry?.catch(() => null);
    await prepared?.supervisor.close();
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async #create(account: Account): Promise<{
    supervisor: FactoryCodexSupervisor;
    surface: CodexLimitSupervisor;
  }> {
    const listeners = new Set<CodexLimitListener>();
    const removers = new WeakMap<CodexLimitListener, () => void>();
    const publishSnapshot = (snapshot: AccountLimitSnapshot) => {
      for (const listener of [...listeners]) {
        try { listener.onSnapshot(snapshot); } catch { /* observer isolation */ }
      }
    };
    const publishStale = (reason: string) => {
      for (const listener of [...listeners]) {
        try { listener.onStale(reason); } catch { /* observer isolation */ }
      }
    };
    const runtime = await this.#prepare({ bin: account.bin, env: account.env });
    if (this.#closed || this.#retired.has(account)) throw new Error(CODEX_FAILURE);
    const supervisor = this.#factory({
      account,
      runtime,
      onSnapshot: publishSnapshot,
      onStale: publishStale,
    });
    const surface: CodexLimitSupervisor = {
      subscribe(listener) {
        const existing = removers.get(listener);
        if (existing) return existing;
        listeners.add(listener);
        let active = true;
        const remove = () => {
          if (!active) return;
          active = false;
          listeners.delete(listener);
          removers.delete(listener);
        };
        removers.set(listener, remove);
        return remove;
      },
      reconcile: () => supervisor.reconcile(),
      readAtResetBoundary: (now) => supervisor.readAtResetBoundary(now),
    };
    return { supervisor, surface };
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    const entries = await Promise.allSettled(this.#entries.values());
    const supervisors = entries.flatMap((entry) => entry.status === 'fulfilled' ? [entry.value.supervisor] : []);
    await Promise.allSettled(supervisors.map((supervisor) => supervisor.close()));
  }
}

class Coordinator implements AccountLimitCoordinator {
  readonly #accounts: Account[];
  readonly #usage: Usage;
  readonly #onChange: () => void;
  readonly #probeClaude: typeof probeLimits;
  readonly #codexPool: CodexLimitPool;
  readonly #ownsCodexPool: boolean;
  readonly #now: () => number;
  readonly #boundaryTimeoutMs: number;
  readonly #subscriptions = new Map<string, {
    account: Account;
    listener: CodexLimitListener;
    unsubscribe: (() => void) | null;
  }>();
  readonly #poolAccesses = new Set<Promise<CodexLimitSupervisor>>();
  readonly #boundaryReads = new Map<string, Promise<ResetRelease>>();
  #reconciliation: Promise<void> | null = null;
  #reconciliationActive = false;
  #reconciliationChanged = false;
  #close: Promise<void> | null = null;
  #closed = false;
  readonly #retired = new WeakSet<Account>();

  constructor(options: AccountLimitCoordinatorOptions) {
    this.#accounts = options.accounts;
    this.#usage = options.usage;
    this.#onChange = options.onChange;
    this.#probeClaude = options.probeClaude ?? probeLimits;
    if (options.codexPool) {
      this.#codexPool = options.codexPool;
      this.#ownsCodexPool = false;
    } else if (options.prepareCodex || options.supervisorFactory) {
      const factory = options.supervisorFactory ?? ((supervisorOptions) => {
        const supervisor = new CodexAppServerSupervisor({ runtime: supervisorOptions.runtime });
        supervisor.subscribe({
          onSnapshot: supervisorOptions.onSnapshot,
          onStale: supervisorOptions.onStale,
        });
        return supervisor;
      });
      this.#codexPool = new FactoryCodexPool(options.prepareCodex ?? prepareCodexRuntime, factory);
      this.#ownsCodexPool = true;
    } else {
      this.#codexPool = new CodexProviderPool();
      this.#ownsCodexPool = true;
    }
    this.#now = options.now ?? Date.now;
    this.#boundaryTimeoutMs = options.boundaryTimeoutMs ?? 5_000;
  }

  start(): Promise<void> {
    return this.reconcile();
  }

  async forget(account: Account): Promise<void> {
    this.#retired.add(account);
    const subscription = this.#subscriptions.get(account.name);
    if (subscription?.account === account) {
      subscription.unsubscribe?.();
      this.#subscriptions.delete(account.name);
    }
    this.#boundaryReads.delete(account.name);
    this.#usage.forgetLimitSnapshot(account.name);
    await this.#codexPool.retire(account);
  }

  #current(account: Account): boolean {
    return !this.#closed && !this.#retired.has(account) && this.#accounts.includes(account);
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

  /** A failed turn needs a new read even when the previous reset is in the future. */
  async refreshCodexForRecovery(accountName: string, now = this.#now()): Promise<ReturnType<Usage['authoritativeResetEligibility']>> {
    const account = this.#codexAccount(accountName);
    try {
      const supervisor = await this.#supervisor(account);
      const result = await this.#withBoundaryTimeout(supervisor.readAtResetBoundary(now));
      if (!this.#current(account)) return {eligible:false,reason:CODEX_FAILURE};
      if (result.timedOut || !isCleanSnapshot(result.snapshot)) throw new Error(CODEX_FAILURE);
      this.#storeSnapshot(account.name,result.snapshot);
      return this.#usage.authoritativeResetEligibility(account.name,now);
    } catch (error) {
      this.#fail(account,error,CODEX_FAILURE);
      return {eligible:false,reason:CODEX_FAILURE};
    }
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
        const snapshot = await this.#probeClaude(account.env);
        if (this.#current(account)) this.#storeSnapshot(account.name, snapshot);
      } catch (error) {
        this.#fail(account, error, CLAUDE_FAILURE);
      }
      return;
    }
    try {
      const supervisor = await this.#supervisor(account);
      const snapshot = await supervisor.reconcile();
      if (this.#current(account)) this.#storeSnapshot(account.name, snapshot);
    } catch (error) {
      this.#fail(account, error, CODEX_FAILURE);
    }
  }

  async #readBoundary(accountName: string, now: number): Promise<ResetRelease> {
    const account = this.#codexAccount(accountName);
    try {
      const supervisor = await this.#supervisor(account);
      const result = await this.#withBoundaryTimeout(supervisor.readAtResetBoundary(now));
      if (!this.#current(account)) return { ready: false, reason: CODEX_FAILURE };
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
    if (!this.#current(account)) return Promise.reject(new Error(CODEX_FAILURE));
    let subscription = this.#subscriptions.get(account.name);
    if (!subscription) {
      subscription = {
        account,
        listener: {
          onSnapshot: (snapshot) => {
            if (this.#current(account)) this.#storeSnapshot(account.name, snapshot);
          },
          onStale: (reason) => this.#fail(account, reason, CODEX_FAILURE),
        },
        unsubscribe: null,
      };
      this.#subscriptions.set(account.name, subscription);
    }
    const current = subscription;
    const access = this.#codexPool.limits(account, current.listener).then((supervisor) => {
      const unsubscribe = supervisor.subscribe(current.listener);
      if (current.unsubscribe === null) current.unsubscribe = unsubscribe;
      if (!this.#current(account) || this.#subscriptions.get(account.name) !== current) {
        unsubscribe();
        throw new Error(CODEX_FAILURE);
      }
      return supervisor;
    });
    this.#poolAccesses.add(access);
    void access.finally(() => this.#poolAccesses.delete(access)).catch(() => {});
    return access;
  }

  #fail(account: Account, error: unknown, fallback: string): void {
    if (!this.#current(account)) return;
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
    await Promise.allSettled([...this.#poolAccesses]);
    for (const subscription of this.#subscriptions.values()) subscription.unsubscribe?.();
    if (this.#ownsCodexPool) await this.#codexPool.close();
  }
}

export function createAccountLimitCoordinator(options: AccountLimitCoordinatorOptions): AccountLimitCoordinator {
  return new Coordinator(options);
}
