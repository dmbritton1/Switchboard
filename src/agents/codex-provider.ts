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

  async limits(account: Account, listener: CodexLimitListener): Promise<CodexAppServerSupervisor> {
    const supervisor = await this.#supervisor(account);
    this.#assertOpen();
    this.#assertAccount(account);
    supervisor.subscribe(listener);
    return supervisor;
  }

  async prepare(
    account: Account,
    transport: CodexTransport,
    sessionId: string,
  ): Promise<{ adapter: Adapter; runtimeVersion: string }> {
    this.#assertOpen();
    this.#assertCodex(account);
    const entry = this.#entry(account);
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
    const entry = this.#entries.get(account.name);
    if (!entry || entry.account !== account) return;
    entry.retired = true;
    this.#entries.delete(account.name);
    const supervisor = await entry.supervisor?.catch(() => null);
    await supervisor?.close();
  }

  async #supervisor(account: Account): Promise<CodexAppServerSupervisor> {
    this.#assertOpen();
    this.#assertCodex(account);
    const entry = this.#entry(account);
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

  #entry(account: Account): ProviderEntry {
    this.#assertAccount(account);
    const existing = this.#entries.get(account.name);
    if (existing) return existing;
    const entry: ProviderEntry = {
      account,
      retired: false,
      runtime: Promise.resolve().then(() => {
        this.#assertEntry(entry);
        return this.#prepareRuntime(account);
      }),
      supervisor: null,
    };
    this.#entries.set(account.name, entry);
    void entry.runtime.catch(() => {
      if (this.#entries.get(account.name) === entry) this.#entries.delete(account.name);
    });
    return entry;
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
    const settled = await Promise.allSettled(
      [...this.#entries.values()].flatMap((entry) => entry.supervisor ? [entry.supervisor] : []),
    );
    const supervisors = new Set<CodexAppServerSupervisor>();
    for (const result of settled) {
      if (result.status === 'fulfilled') supervisors.add(result.value);
    }
    await Promise.allSettled([...supervisors].map((supervisor) => supervisor.close()));
  }
}
