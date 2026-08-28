import {
  AppServerClient,
  type AppServerClientOptions,
} from './codex-app-server-client.ts';
import {
  DENIED_SERVER_METHODS,
  PRIVATE_NOTIFICATIONS,
  telemetryAppServerArgs,
  verifyTelemetryContract,
} from './codex-app-server-contract.ts';
import {
  CODEX_TELEMETRY_REASONS,
  normalizeCodexAccountRead,
  normalizeCodexAuthUpdate,
  normalizeCodexRateLimits,
  type CodexTelemetryAuth,
} from './codex-limits.ts';
import { redactValues, type PreparedCodexRuntime } from './codex-runtime.ts';
import type { AccountLimitSnapshot } from '../types.ts';

const PUBLIC_UNAVAILABLE = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const MAX_RESTART_DELAY_MS = 30_000;

type TimerHandle = unknown;
type SupervisorClient = Pick<AppServerClient, 'request' | 'notify' | 'respondError' | 'close'>;

export type CodexAppServerSupervisorOptions = {
  runtime: PreparedCodexRuntime;
  onSnapshot: (snapshot: AccountLimitSnapshot) => void;
  onStale: (reason: string) => void;
  now?: () => number;
  requestTimeoutMs?: number;
  verifyContract?: typeof verifyTelemetryContract;
  clientFactory?: (options: AppServerClientOptions) => SupervisorClient;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

function defaultSetTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return timer;
}

function defaultClearTimer(timer: TimerHandle): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function unavailableError(): Error {
  return new Error(PUBLIC_UNAVAILABLE);
}

class UnsupportedTelemetryError extends Error {}

export class CodexAppServerSupervisor {
  readonly #options: CodexAppServerSupervisorOptions;
  readonly #verifyContract: typeof verifyTelemetryContract;
  readonly #clientFactory: (options: AppServerClientOptions) => SupervisorClient;
  readonly #setTimer: (callback: () => void, delay: number) => TimerHandle;
  readonly #clearTimer: (timer: TimerHandle) => void;
  #client: SupervisorClient | null = null;
  #readyClient: SupervisorClient | null = null;
  #launch: Promise<void> | null = null;
  #read: Promise<AccountLimitSnapshot> | null = null;
  #auth: CodexTelemetryAuth | null = null;
  #authRevision = 0;
  #staleReason: string | null = null;
  #restartTimer: TimerHandle | null = null;
  #restartAttempt = 0;
  #closed = false;
  #close: Promise<void> | null = null;

  constructor(options: CodexAppServerSupervisorOptions) {
    this.#options = options;
    this.#verifyContract = options.verifyContract ?? verifyTelemetryContract;
    this.#clientFactory = options.clientFactory ?? ((clientOptions) => new AppServerClient(clientOptions));
    this.#setTimer = options.setTimer ?? defaultSetTimer;
    this.#clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailableError());
    if (this.#launch) return this.#launch;
    if (this.#client) return Promise.resolve();
    if (this.#restartTimer !== null) return Promise.reject(unavailableError());
    return this.#beginLaunch();
  }

  async reconcile(): Promise<AccountLimitSnapshot> {
    await this.start();
    return this.#readCurrent(this.#now());
  }

  async readAtResetBoundary(now = this.#now()): Promise<AccountLimitSnapshot> {
    await this.start();
    return this.#readCurrent(now);
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  #beginLaunch(): Promise<void> {
    const launch = this.#launchNow();
    this.#launch = launch;
    void launch.finally(() => {
      if (this.#launch === launch) this.#launch = null;
    }).catch(() => {});
    return launch;
  }

  async #launchNow(): Promise<void> {
    let client: SupervisorClient | null = null;
    try {
      await this.#verifyContract(this.#options.runtime);
      if (this.#closed) return;
      client = this.#createClient();
      this.#client = client;
      await client.request('initialize', {
        clientInfo: {
          name: 'switchboard_telemetry',
          title: 'Switchboard telemetry',
          version: '0.1.0',
        },
        capabilities: null,
      });
      this.#assertActive(client);
      client.notify('initialized');
      this.#readyClient = client;
      const authRevision = this.#authRevision;
      const accountInput = await client.request('account/read', { refreshToken: false });
      this.#assertActive(client);
      if (this.#authRevision !== authRevision) return;
      const account = normalizeCodexAccountRead(accountInput);
      this.#auth = account;
      if (!account.supported) {
        this.#restartAttempt = 0;
        this.#markStale(account.reason);
        return;
      }
      await this.#readFrom(client, this.#now());
    } catch {
      if (client !== null) await this.#retire(client);
      else this.#handleFailure();
      throw unavailableError();
    }
  }

  #createClient(): SupervisorClient {
    let client: SupervisorClient;
    client = this.#clientFactory({
      command: this.#options.runtime.commandPath,
      args: telemetryAppServerArgs(),
      env: this.#options.runtime.env,
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      redact: (text) => redactValues(text, Object.values(this.#options.runtime.env)),
      onNotification: (method, params) => this.#notification(client, method, params),
      onServerRequest: (id, method, _params) => this.#serverRequest(client, id, method),
      onExit: () => this.#clientExit(client),
    });
    return client;
  }

  #notification(client: SupervisorClient, method: string, params: unknown): void {
    if (client !== this.#client || this.#closed) return;
    if ((PRIVATE_NOTIFICATIONS as readonly string[]).includes(method)) return;
    if (client !== this.#readyClient) return;
    if (method === 'account/updated') {
      const auth = normalizeCodexAuthUpdate(params);
      this.#authRevision += 1;
      this.#auth = auth;
      if (!auth.supported) {
        this.#markStale(auth.reason);
        return;
      }
      void this.#readFrom(client, this.#now()).catch(() => {});
      return;
    }
    if (method === 'account/rateLimits/updated' && this.#auth?.supported) {
      void this.#readFrom(client, this.#now()).catch(() => {});
    }
  }

  #serverRequest(client: SupervisorClient, id: string | number, method: string): void {
    if (client !== this.#client || this.#closed) return;
    const pinnedDenied = (DENIED_SERVER_METHODS as readonly string[]).includes(method);
    client.respondError(
      id,
      -32601,
      pinnedDenied
        ? 'Unsupported by the Switchboard telemetry client.'
        : 'Unknown to the Switchboard telemetry client.',
    );
    if (method === 'account/chatgptAuthTokens/refresh') {
      this.#authRevision += 1;
      this.#auth = {
        supported: false,
        plan: null,
        reason: CODEX_TELEMETRY_REASONS.externalTokens,
      };
      this.#markStale(CODEX_TELEMETRY_REASONS.externalTokens);
      return;
    }
  }

  #clientExit(client: SupervisorClient): void {
    if (client !== this.#client || this.#closed) return;
    this.#client = null;
    this.#readyClient = null;
    this.#handleFailure();
  }

  async #readCurrent(now: number): Promise<AccountLimitSnapshot> {
    if (!this.#auth?.supported) {
      throw new Error(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
    }
    const client = this.#client;
    if (!client) throw unavailableError();
    return this.#readFrom(client, now);
  }

  #readFrom(client: SupervisorClient, now: number): Promise<AccountLimitSnapshot> {
    if (this.#read) return this.#read;
    const read = this.#performRead(client, now);
    this.#read = read;
    void read.finally(() => {
      if (this.#read === read) this.#read = null;
    }).catch(() => {});
    return read;
  }

  async #performRead(client: SupervisorClient, now: number): Promise<AccountLimitSnapshot> {
    try {
      this.#assertActive(client);
      const input = await client.request('account/rateLimits/read');
      this.#assertActive(client);
      if (!this.#auth?.supported) {
        throw new UnsupportedTelemetryError(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
      }
      const snapshot = normalizeCodexRateLimits(input, this.#auth?.supported ? this.#auth.plan : null, now);
      this.#staleReason = null;
      this.#restartAttempt = 0;
      try {
        this.#options.onSnapshot(snapshot);
      } catch {
        // Snapshot observers cannot affect process supervision.
      }
      return snapshot;
    } catch (error) {
      if (error instanceof UnsupportedTelemetryError) throw error;
      await this.#retire(client);
      throw unavailableError();
    }
  }

  async #retire(client: SupervisorClient): Promise<void> {
    if (client !== this.#client) {
      this.#handleFailure();
      return;
    }
    this.#client = null;
    this.#readyClient = null;
    try {
      await client.close();
    } catch {
      // AppServerClient already bounded and sanitized shutdown.
    }
    this.#handleFailure();
  }

  #handleFailure(): void {
    if (this.#closed) return;
    this.#markStale(PUBLIC_UNAVAILABLE);
    this.#scheduleRestart();
  }

  #markStale(reason: string): void {
    if (this.#staleReason === reason) return;
    this.#staleReason = reason;
    try {
      this.#options.onStale(reason);
    } catch {
      // Stale observers cannot affect process supervision.
    }
  }

  #scheduleRestart(): void {
    if (this.#closed || this.#restartTimer !== null) return;
    const delay = RESTART_DELAYS_MS[this.#restartAttempt] ?? MAX_RESTART_DELAY_MS;
    this.#restartAttempt += 1;
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      if (this.#closed || this.#client || this.#launch) return;
      void this.#beginLaunch().catch(() => {});
    }, delay);
  }

  #assertActive(client: SupervisorClient): void {
    if (this.#closed || client !== this.#client) throw unavailableError();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async #closeNow(): Promise<void> {
    this.#closed = true;
    if (this.#restartTimer !== null) {
      this.#clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    const client = this.#client;
    this.#client = null;
    this.#readyClient = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // Closing the supervisor is idempotent even after bounded forced termination.
      }
    }
    await this.#launch?.catch(() => {});
  }
}
