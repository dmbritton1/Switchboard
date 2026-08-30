import { AppServerClient, type AppServerClientOptions } from './codex-app-server-client.ts';
import {
  DENIED_SERVER_METHODS, PRIVATE_NOTIFICATIONS, TURN_CLIENT_METHODS, TURN_NOTIFICATIONS,
  appServerArgs, verifyAppServerContract, type CodexAppServerMode,
} from './codex-app-server-contract.ts';
import {
  CODEX_TELEMETRY_REASONS, normalizeCodexAccountRead, normalizeCodexAuthUpdate,
  normalizeCodexRateLimits, type CodexTelemetryAuth,
} from './codex-limits.ts';
import { redactValues, type PreparedCodexRuntime } from './codex-runtime.ts';
import type { AccountLimitSnapshot, CodexFailureCode } from '../types.ts';

const PUBLIC_UNAVAILABLE = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const PUBLIC_TRANSPORT_CRASH = 'Codex app-server transport crashed. Retry the session manually.';
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const MAX_RESTART_DELAY_MS = 30_000;

type TimerHandle = unknown;
type SupervisorClient = Pick<AppServerClient, 'request' | 'notify' | 'respondError' | 'close'>;
type UnsupportedCodexTelemetryAuth = Extract<CodexTelemetryAuth, { supported: false }>;
type ReadOutcome = { invalidated: true } | { invalidated: false; snapshot: AccountLimitSnapshot };
type ActiveRead = { revision: number; promise: Promise<ReadOutcome> };
type SessionState = { route: CodexSessionRoute; threadId: string | null; activeTurn: boolean };

export type CodexLimitListener = {
  onSnapshot(snapshot: AccountLimitSnapshot): void;
  onStale(reason: string): void;
};

export type CodexSessionRoute = {
  onNotification(method: string, params: unknown): void;
  onFatal(reason: string, code: CodexFailureCode): void;
};

export type CodexAppServerSupervisorOptions = {
  runtime: PreparedCodexRuntime;
  now?: () => number;
  requestTimeoutMs?: number;
  verifyContract?: typeof verifyAppServerContract;
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

function threadIdFrom(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const threadId = (params as Record<string, unknown>).threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

class UnsupportedTelemetryError extends Error {}

export class CodexAppServerSupervisor {
  readonly #options: CodexAppServerSupervisorOptions;
  readonly #verifyContract: typeof verifyAppServerContract;
  readonly #clientFactory: (options: AppServerClientOptions) => SupervisorClient;
  readonly #setTimer: (callback: () => void, delay: number) => TimerHandle;
  readonly #clearTimer: (timer: TimerHandle) => void;
  readonly #listeners = new Set<CodexLimitListener>();
  readonly #listenerRemovers = new WeakMap<CodexLimitListener, () => void>();
  readonly #sessions = new Map<string, SessionState>();
  readonly #threadOwners = new Map<string, string>();
  #mode: CodexAppServerMode = 'telemetry';
  #client: SupervisorClient | null = null;
  #readyClient: SupervisorClient | null = null;
  #launch: Promise<void> | null = null;
  #promotion: Promise<void> | null = null;
  #read: ActiveRead | null = null;
  #limitRevision = 0;
  #auth: CodexTelemetryAuth | null = null;
  #unsupportedAuthLatch: UnsupportedCodexTelemetryAuth | null = null;
  #authRevision = 0;
  #staleReason: string | null = null;
  #restartTimer: TimerHandle | null = null;
  #restartAttempt = 0;
  #closed = false;
  #close: Promise<void> | null = null;

  constructor(options: CodexAppServerSupervisorOptions) {
    this.#options = options;
    this.#verifyContract = options.verifyContract ?? verifyAppServerContract;
    this.#clientFactory = options.clientFactory ?? ((clientOptions) => new AppServerClient(clientOptions));
    this.#setTimer = options.setTimer ?? defaultSetTimer;
    this.#clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  subscribe(listener: CodexLimitListener): () => void {
    const existing = this.#listenerRemovers.get(listener);
    if (existing) return existing;
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
      this.#listenerRemovers.delete(listener);
    };
    this.#listenerRemovers.set(listener, remove);
    return remove;
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailableError());
    if (this.#promotion) return this.#promotion;
    if (this.#launch) return this.#launch;
    if (this.#client) return Promise.resolve();
    if (this.#restartTimer !== null) return Promise.reject(unavailableError());
    return this.#beginLaunch();
  }

  ensureTurnTransport(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailableError());
    if (this.#promotion) return this.#promotion;
    if (this.#mode === 'turns') return this.start();
    if ([...this.#sessions.values()].some((session) => session.activeTurn)) {
      return Promise.reject(new Error('Cannot promote Codex transport while a session turn is active.'));
    }
    const promotion = Promise.resolve().then(() => this.#promoteNow());
    this.#promotion = promotion;
    void promotion.finally(() => {
      if (this.#promotion === promotion) this.#promotion = null;
    }).catch(() => {});
    return promotion;
  }

  registerSession(sessionId: string, route: CodexSessionRoute): () => void {
    if (this.#closed) throw new Error('Codex app-server supervisor is closed.');
    if (this.#mode !== 'turns') throw new Error('Codex turn transport must be prepared before registration.');
    if (this.#sessions.has(sessionId)) throw new Error('Codex session is already registered.');
    const state: SessionState = { route, threadId: null, activeTurn: false };
    this.#sessions.set(sessionId, state);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#sessions.get(sessionId) !== state) return;
      this.#sessions.delete(sessionId);
      if (state.threadId !== null && this.#threadOwners.get(state.threadId) === sessionId) {
        this.#threadOwners.delete(state.threadId);
      }
    };
  }

  bindThread(sessionId: string, threadId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error('Codex session is not registered.');
    if (typeof threadId !== 'string' || threadId.length === 0) throw new Error('Codex thread id is invalid.');
    if (state.threadId !== null || this.#threadOwners.has(threadId)) throw new Error('Codex thread is already bound.');
    state.threadId = threadId;
    this.#threadOwners.set(threadId, sessionId);
  }

  async requestForSession<T>(
    sessionId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/interrupt',
    params: unknown,
  ): Promise<T> {
    if (!(TURN_CLIENT_METHODS as readonly string[]).includes(method)) {
      throw new Error('Unsupported Codex session request.');
    }
    if (this.#mode !== 'turns') throw new Error('Codex turn transport is unavailable.');
    if (this.#promotion) await this.#promotion;
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error('Codex session is not registered.');
    const client = this.#readyClient;
    if (!client || client !== this.#client) throw unavailableError();
    if (method === 'turn/start') state.activeTurn = true;
    try {
      return await client.request<T>(method, params);
    } catch (error) {
      if (method === 'turn/start' && this.#client === client) state.activeTurn = false;
      throw error;
    }
  }

  async reconcile(): Promise<AccountLimitSnapshot> {
    await this.start();
    if (this.#promotion) await this.#promotion;
    return this.#readCurrent(this.#now());
  }

  async readAtResetBoundary(now = this.#now()): Promise<AccountLimitSnapshot> {
    await this.start();
    if (this.#promotion) await this.#promotion;
    return this.#readCurrent(now);
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async #promoteNow(): Promise<void> {
    const existingLaunch = this.#launch;
    if (existingLaunch) await existingLaunch.catch(() => {});
    if (this.#launch === existingLaunch) this.#launch = null;
    if (this.#closed) throw unavailableError();
    if (this.#mode === 'turns') return this.start();
    this.#mode = 'turns';
    if (this.#restartTimer !== null) {
      this.#clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#limitRevision += 1;
    this.#read = null;
    this.#markStale(PUBLIC_UNAVAILABLE);
    const client = this.#client;
    this.#client = null;
    this.#readyClient = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // Promotion still owns the replacement after bounded forced shutdown.
      }
    }
    if (this.#closed) throw unavailableError();
    await this.#beginLaunch();
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
    const mode = this.#mode;
    try {
      await this.#verifyContract(this.#options.runtime, mode);
      if (this.#closed) return;
      client = this.#createClient(mode);
      this.#client = client;
      await client.request('initialize', {
        clientInfo: { name: 'switchboard_telemetry', title: 'Switchboard telemetry', version: '0.1.0' },
        capabilities: null,
      });
      this.#assertActive(client);
      client.notify('initialized');
      this.#readyClient = client;
      const authRevision = this.#authRevision;
      const accountInput = await client.request('account/read', { refreshToken: false });
      this.#assertActive(client);
      if (this.#unsupportedAuthLatch) {
        this.#auth = this.#unsupportedAuthLatch;
        this.#markStale(this.#unsupportedAuthLatch.reason);
        return;
      }
      if (this.#authRevision !== authRevision) return;
      const account = normalizeCodexAccountRead(accountInput);
      this.#auth = account;
      if (!account.supported) {
        this.#markStale(account.reason);
        return;
      }
      await this.#readFrom(client, this.#now());
    } catch {
      if (client !== null) await this.#retire(client, true);
      else this.#handleFailure(false);
      throw unavailableError();
    }
  }

  #createClient(mode: CodexAppServerMode): SupervisorClient {
    let client: SupervisorClient;
    client = this.#clientFactory({
      command: this.#options.runtime.commandPath,
      args: appServerArgs(mode),
      env: this.#options.runtime.env,
      ...(this.#options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.#options.requestTimeoutMs }),
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
      this.#limitRevision += 1;
      this.#unsupportedAuthLatch = auth.supported ? null : auth;
      this.#auth = auth;
      if (!auth.supported) {
        this.#markStale(auth.reason);
        return;
      }
      void this.#readFrom(client, this.#now()).catch(() => {});
      return;
    }
    if (method === 'account/rateLimits/updated' && this.#auth?.supported) {
      this.#limitRevision += 1;
      void this.#readFrom(client, this.#now()).catch(() => {});
      return;
    }
    if (this.#mode !== 'turns' || !(TURN_NOTIFICATIONS as readonly string[]).includes(method)) return;
    const threadId = threadIdFrom(params);
    if (threadId === null) return;
    const sessionId = this.#threadOwners.get(threadId);
    const state = sessionId === undefined ? undefined : this.#sessions.get(sessionId);
    if (!state || state.threadId !== threadId) return;
    try {
      state.route.onNotification(method, params);
    } catch {
      // Session observers cannot desynchronize shared process ownership.
    }
    if (method === 'turn/started') state.activeTurn = true;
    if (method === 'turn/completed') state.activeTurn = false;
  }

  #serverRequest(client: SupervisorClient, id: string | number, method: string): void {
    if (client !== this.#client || this.#closed) return;
    const pinnedDenied = (DENIED_SERVER_METHODS as readonly string[]).includes(method);
    client.respondError(
      id,
      -32601,
      pinnedDenied
        ? 'This interaction is unavailable in the current Switchboard phase.'
        : 'This method is unavailable in the current Switchboard phase.',
    );
    if (method === 'account/chatgptAuthTokens/refresh') {
      const auth: UnsupportedCodexTelemetryAuth = {
        supported: false, plan: null, reason: CODEX_TELEMETRY_REASONS.externalTokens,
      };
      this.#authRevision += 1;
      this.#limitRevision += 1;
      this.#unsupportedAuthLatch = auth;
      this.#auth = auth;
      this.#markStale(auth.reason);
    }
  }

  #clientExit(client: SupervisorClient): void {
    if (client !== this.#client || this.#closed) return;
    this.#client = null;
    this.#readyClient = null;
    this.#handleFailure(true);
  }

  async #readCurrent(now: number): Promise<AccountLimitSnapshot> {
    if (!this.#auth?.supported) throw new Error(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
    const client = this.#client;
    if (!client) throw unavailableError();
    return this.#readFrom(client, now);
  }

  async #readFrom(client: SupervisorClient, now: number): Promise<AccountLimitSnapshot> {
    let readNow = now;
    while (true) {
      this.#assertActive(client);
      if (!this.#auth?.supported) throw new UnsupportedTelemetryError(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
      const read = this.#read ?? this.#beginRead(client, readNow);
      const outcome = await read.promise;
      if (outcome.invalidated || read.revision !== this.#limitRevision) {
        readNow = this.#now();
        continue;
      }
      return outcome.snapshot;
    }
  }

  #beginRead(client: SupervisorClient, now: number): ActiveRead {
    const revision = this.#limitRevision;
    const read: ActiveRead = { revision, promise: this.#performRead(client, now, revision) };
    this.#read = read;
    void read.promise.finally(() => {
      if (this.#read === read) this.#read = null;
    }).catch(() => {});
    return read;
  }

  async #performRead(client: SupervisorClient, now: number, revision: number): Promise<ReadOutcome> {
    try {
      this.#assertActive(client);
      const input = await client.request('account/rateLimits/read');
      this.#assertActive(client);
      if (revision !== this.#limitRevision) return { invalidated: true };
      if (!this.#auth?.supported) throw new UnsupportedTelemetryError(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
      const snapshot = normalizeCodexRateLimits(input, this.#auth.plan, now);
      this.#staleReason = null;
      this.#restartAttempt = 0;
      this.#emitSnapshot(snapshot);
      return { invalidated: false, snapshot };
    } catch (error) {
      if (error instanceof UnsupportedTelemetryError) throw error;
      await this.#retire(client, true);
      throw unavailableError();
    }
  }

  async #retire(client: SupervisorClient, fatalRoutes: boolean): Promise<void> {
    if (client !== this.#client) return;
    this.#client = null;
    this.#readyClient = null;
    try {
      await client.close();
    } catch {
      // AppServerClient already bounded and sanitized shutdown.
    }
    this.#handleFailure(fatalRoutes);
  }

  #handleFailure(fatalRoutes: boolean): void {
    if (this.#closed) return;
    this.#markStale(PUBLIC_UNAVAILABLE);
    if (fatalRoutes && this.#mode === 'turns') this.#fatalRoutes();
    this.#scheduleRestart();
  }

  #fatalRoutes(): void {
    for (const state of [...this.#sessions.values()]) {
      if (!state.activeTurn) continue;
      state.activeTurn = false;
      try {
        state.route.onFatal(PUBLIC_TRANSPORT_CRASH, 'codex_transport_crashed');
      } catch {
        // One route observer cannot hide the crash from sibling sessions.
      }
    }
  }

  #emitSnapshot(snapshot: AccountLimitSnapshot): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener.onSnapshot(snapshot);
      } catch {
        // Snapshot observers cannot affect process supervision.
      }
    }
  }

  #markStale(reason: string): void {
    if (this.#staleReason === reason) return;
    this.#staleReason = reason;
    for (const listener of [...this.#listeners]) {
      try {
        listener.onStale(reason);
      } catch {
        // Stale observers cannot affect process supervision.
      }
    }
  }

  #scheduleRestart(): void {
    if (this.#closed || this.#restartTimer !== null) return;
    const delay = RESTART_DELAYS_MS[this.#restartAttempt] ?? MAX_RESTART_DELAY_MS;
    this.#restartAttempt += 1;
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      if (this.#closed || this.#client || this.#launch || this.#promotion) return;
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
    this.#sessions.clear();
    this.#threadOwners.clear();
    this.#listeners.clear();
    if (client) {
      try {
        await client.close();
      } catch {
        // Closing stays idempotent after bounded forced termination.
      }
    }
    await this.#launch?.catch(() => {});
    await this.#promotion?.catch(() => {});
  }
}
