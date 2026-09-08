import { createCodexAdapter } from './codex.ts';
import { createCodexAppServerAdapter } from './codex-app-server.ts';
import {
  CodexAppServerSupervisor,
  type CodexAppServerSupervisorOptions,
  type CodexLimitListener,
} from './codex-app-server-supervisor.ts';
import { prepareCodexRuntime, type PreparedCodexRuntime } from './codex-runtime.ts';
import type { Account } from '../accounts.ts';
import type { Adapter } from '../types.ts';

export type CodexTransport = 'sdk' | 'app-server';

export type CodexProviderPoolOptions = {
  prepareRuntime?: (account: Account) => Promise<PreparedCodexRuntime>;
  createSupervisor?: (options: CodexAppServerSupervisorOptions) => CodexAppServerSupervisor;
  createSdkAdapter?: (runtime: PreparedCodexRuntime) => Adapter;
  /** Task 3 installs the production implementation at this narrow boundary. */
  createAppServerAdapter?: (
    supervisor: CodexAppServerSupervisor,
    sessionId: string,
    runtimeVersion: string,
  ) => Adapter;
};

type ProviderEntry = {
  account: Account;
  retired: boolean;
  runtime: Promise<PreparedCodexRuntime>;
  supervisor: Promise<CodexAppServerSupervisor> | null;
  preparations: Set<Promise<unknown>>;
};

const POOL_CLOSED = 'Codex provider pool is closed.';
const ADAPTER_UNAVAILABLE = 'Codex app-server session transport is unavailable in this Switchboard phase.';

export class CodexProviderPool {
  readonly #prepareRuntime: (account: Account) => Promise<PreparedCodexRuntime>;
  readonly #createSupervisor: (options: CodexAppServerSupervisorOptions) => CodexAppServerSupervisor;
  readonly #createSdkAdapter: (runtime: PreparedCodexRuntime) => Adapter;
  readonly #createAppServerAdapter: CodexProviderPoolOptions['createAppServerAdapter'];
  readonly #entries = new Map<string, ProviderEntry>();
  readonly #retired = new WeakSet<Account>();
  readonly #identityRetirements = new WeakMap<Account, Promise<void>>();
  readonly #nameRetirements = new Map<string, Promise<void>>();
  readonly #preparations = new Set<Promise<unknown>>();
  #closed = false;
  #close: Promise<void> | null = null;

  constructor(options: CodexProviderPoolOptions = {}) {
    this.#prepareRuntime = options.prepareRuntime ?? ((account) => prepareCodexRuntime({
      bin: account.bin,
      env: account.env,
    }));
    this.#createSupervisor = options.createSupervisor ?? ((supervisorOptions) => (
      new CodexAppServerSupervisor(supervisorOptions)
    ));
    this.#createSdkAdapter = options.createSdkAdapter ?? createCodexAdapter;
    this.#createAppServerAdapter = options.createAppServerAdapter ?? createCodexAppServerAdapter;
  }

  limits(account: Account, listener: CodexLimitListener): Promise<CodexAppServerSupervisor> {
    return this.#trackPreparation(this.#limitsNow(account, listener));
  }

  async #limitsNow(account: Account, listener: CodexLimitListener): Promise<CodexAppServerSupervisor> {
    const supervisor = await this.#supervisor(account);
    this.#assertOpen();
    this.#assertAccount(account);
    supervisor.subscribe(listener);
    return supervisor;
  }

  prepare(
    account: Account,
    transport: CodexTransport,
    sessionId: string,
  ): Promise<{ adapter: Adapter; runtimeVersion: string }> {
    return this.#trackPreparation(this.#prepareNow(account, transport, sessionId));
  }

  async #prepareNow(
    account: Account,
    transport: CodexTransport,
    sessionId: string,
  ): Promise<{ adapter: Adapter; runtimeVersion: string }> {
    this.#assertOpen();
    this.#assertCodex(account);
    const entry = await this.#entry(account);
    return this.#trackEntryPreparation(entry, this.#prepareEntry(entry, transport, sessionId));
  }

  async #prepareEntry(
    entry: ProviderEntry,
    transport: CodexTransport,
    sessionId: string,
  ): Promise<{ adapter: Adapter; runtimeVersion: string }> {
    const runtime = await entry.runtime;
    this.#assertEntry(entry);
    if (transport === 'sdk') {
      return { adapter: this.#createSdkAdapter(runtime), runtimeVersion: runtime.version };
    }
    if (transport !== 'app-server') throw new Error('Unsupported Codex transport.');
    const adapterFactory = this.#createAppServerAdapter;
    if (!adapterFactory) throw new Error(ADAPTER_UNAVAILABLE);
    const supervisor = await this.#supervisorForEntry(entry, runtime);
    await supervisor.ensureTurnTransport();
    this.#assertEntry(entry);
    return {
      adapter: adapterFactory(supervisor, sessionId, runtime.version),
      runtimeVersion: runtime.version,
    };
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async retire(account: Account): Promise<void> {
    this.#retired.add(account);
    const retirement = this.#identityRetirements.get(account);
    if (retirement) return retirement;
    const entry = this.#entries.get(account.name);
    if (!entry || entry.account !== account) return;
    return this.#retireEntry(entry);
  }

  async #supervisor(account: Account): Promise<CodexAppServerSupervisor> {
    this.#assertOpen();
    this.#assertCodex(account);
    const entry = await this.#entry(account);
    return this.#trackEntryPreparation(entry, this.#prepareSupervisor(entry));
  }

  async #prepareSupervisor(entry: ProviderEntry): Promise<CodexAppServerSupervisor> {
    const runtime = await entry.runtime;
    this.#assertEntry(entry);
    return this.#supervisorForEntry(entry, runtime);
  }

  #supervisorForEntry(
    entry: ProviderEntry,
    runtime: PreparedCodexRuntime,
  ): Promise<CodexAppServerSupervisor> {
    if (entry.supervisor) return entry.supervisor;
    const supervisor = Promise.resolve().then(() => {
      this.#assertEntry(entry);
      return this.#createSupervisor({ runtime });
    });
    entry.supervisor = supervisor;
    return supervisor;
  }

  async #entry(account: Account): Promise<ProviderEntry> {
    this.#assertOpen();
    this.#assertAccount(account);
    while (true) {
      const existing = this.#entries.get(account.name);
      if (existing) return existing;
      const retirement = this.#nameRetirements.get(account.name);
      if (retirement) {
        await retirement;
        if (this.#nameRetirements.get(account.name) === retirement) {
          this.#nameRetirements.delete(account.name);
        }
        this.#assertOpen();
        this.#assertAccount(account);
        continue;
      }
      const entry: ProviderEntry = {
        account,
        retired: false,
        runtime: Promise.resolve().then(() => {
          this.#assertEntry(entry);
          return this.#prepareRuntime(account);
        }),
        supervisor: null,
        preparations: new Set(),
      };
      this.#entries.set(account.name, entry);
      void entry.runtime.catch(() => {
        if (this.#entries.get(account.name) === entry) this.#entries.delete(account.name);
      });
      return entry;
    }
  }

  #retireEntry(entry: ProviderEntry): Promise<void> {
    const existing = this.#identityRetirements.get(entry.account);
    if (existing) return existing;
    entry.retired = true;
    const retirement = Promise.resolve().then(async () => {
      await Promise.allSettled([entry.runtime]);
      const supervisor = await entry.supervisor?.catch(() => null);
      await supervisor?.close();
      const joined = new Set<Promise<unknown>>();
      while (true) {
        const pending = [...entry.preparations].filter((operation) => !joined.has(operation));
        if (pending.length === 0) return;
        for (const operation of pending) joined.add(operation);
        await Promise.allSettled(pending);
      }
    });
    this.#identityRetirements.set(entry.account, retirement);
    this.#nameRetirements.set(entry.account.name, retirement);
    if (this.#entries.get(entry.account.name) === entry) {
      this.#entries.delete(entry.account.name);
    }
    void retirement.then(() => {
      if (this.#nameRetirements.get(entry.account.name) === retirement) {
        this.#nameRetirements.delete(entry.account.name);
      }
    }, () => {});
    return retirement;
  }

  #trackPreparation<T>(preparation: Promise<T>): Promise<T> {
    this.#preparations.add(preparation);
    void preparation.finally(() => this.#preparations.delete(preparation)).catch(() => {});
    return preparation;
  }

  #trackEntryPreparation<T>(entry: ProviderEntry, preparation: Promise<T>): Promise<T> {
    entry.preparations.add(preparation);
    void preparation.finally(() => entry.preparations.delete(preparation)).catch(() => {});
    return preparation;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(POOL_CLOSED);
  }

  #assertAccount(account: Account): void {
    if (this.#retired.has(account)) throw new Error('Codex account identity was retired.');
  }

  #assertEntry(entry: ProviderEntry): void {
    this.#assertOpen();
    if (entry.retired) throw new Error('Codex account identity was retired.');
  }

  #assertCodex(account: Account): void {
    if (account.provider !== 'codex') throw new Error('Codex account is required.');
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    const joined = new Set<Promise<unknown>>();
    while (true) {
      for (const entry of [...this.#entries.values()]) this.#retireEntry(entry);
      const pending = [
        ...this.#preparations,
        ...this.#nameRetirements.values(),
      ].filter((operation) => !joined.has(operation));
      if (pending.length === 0) return;
      for (const operation of pending) joined.add(operation);
      await Promise.allSettled(pending);
    }
  }
}
