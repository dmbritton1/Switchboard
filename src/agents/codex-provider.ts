import { createCodexAdapter } from './codex.ts';
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
    this.#createAppServerAdapter = options.createAppServerAdapter;
  }

  async limits(account: Account, listener: CodexLimitListener): Promise<CodexAppServerSupervisor> {
    const supervisor = await this.#supervisor(account);
    this.#assertOpen();
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
    this.#assertOpen();
    if (transport === 'sdk') {
      return { adapter: this.#createSdkAdapter(runtime), runtimeVersion: runtime.version };
    }
    if (transport !== 'app-server') throw new Error('Unsupported Codex transport.');
    const adapterFactory = this.#createAppServerAdapter;
    if (!adapterFactory) throw new Error(ADAPTER_UNAVAILABLE);
    const supervisor = await this.#supervisorForEntry(entry, runtime);
    await supervisor.ensureTurnTransport();
    this.#assertOpen();
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

  async #supervisor(account: Account): Promise<CodexAppServerSupervisor> {
    this.#assertOpen();
    this.#assertCodex(account);
    const entry = this.#entry(account);
    const runtime = await entry.runtime;
    this.#assertOpen();
    return this.#supervisorForEntry(entry, runtime);
  }

  #supervisorForEntry(
    entry: ProviderEntry,
    runtime: PreparedCodexRuntime,
  ): Promise<CodexAppServerSupervisor> {
    if (entry.supervisor) return entry.supervisor;
    const supervisor = Promise.resolve().then(() => {
      this.#assertOpen();
      return this.#createSupervisor({ runtime });
    });
    entry.supervisor = supervisor;
    return supervisor;
  }

  #entry(account: Account): ProviderEntry {
    const existing = this.#entries.get(account.name);
    if (existing) return existing;
    const entry: ProviderEntry = {
      runtime: Promise.resolve().then(() => this.#prepareRuntime(account)),
      supervisor: null,
    };
    this.#entries.set(account.name, entry);
    return entry;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(POOL_CLOSED);
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
