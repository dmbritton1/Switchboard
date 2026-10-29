import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CHROME } from './browser-capture.ts';
import { screenshotConfig } from './codex-mcp-config.ts';
import { CodexCapabilityCatalog, CAPABILITY_METHODS, CAPABILITY_NOTIFICATIONS } from './codex-capabilities.ts';
import type { CodexInteractionResult } from './codex-questions.ts';
import { AppServerClient, AppServerRequestError, type AppServerClientOptions } from './codex-app-server-client.ts';
import {
  DENIED_SERVER_METHODS, PRIVATE_NOTIFICATIONS, TURN_CLIENT_METHODS, TURN_NOTIFICATIONS,
  appServerArgs, verifyAppServerContract, type CodexAppServerMode,
} from './codex-app-server-contract.ts';
import {
  CODEX_TELEMETRY_REASONS, normalizeCodexAccountRead, normalizeCodexAuthUpdate,
  normalizeCodexRateLimits, type CodexTelemetryAuth,
} from './codex-limits.ts';
import { CodexRuntimeError, redactCodexText, redactValues, unsafeCodexProviderIdentifier, type PreparedCodexRuntime } from './codex-runtime.ts';
import type { AccountLimitSnapshot, CodexFailureCode } from '../types.ts';

const PUBLIC_UNAVAILABLE = 'Codex account telemetry is temporarily unavailable. Using the local estimate.';
const PUBLIC_TRANSPORT_CRASH = 'Codex app-server transport crashed. Retry the session manually.';
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const MAX_RESTART_DELAY_MS = 30_000;
const TERMINAL_TURN_HISTORY = 32;

type TimerHandle = unknown;
type SupervisorClient = Pick<AppServerClient, 'request' | 'notify' | 'respondError' | 'close'> & Partial<Pick<AppServerClient, 'respond'>>;
type UnsupportedCodexTelemetryAuth = Extract<CodexTelemetryAuth, { supported: false }>;
type ReadOutcome = { invalidated: true } | { invalidated: false; snapshot: AccountLimitSnapshot };
type ActiveRead = { revision: number; promise: Promise<ReadOutcome> };
type ActiveRetirement = { client: SupervisorClient; generation: number | undefined; promise: Promise<void> };
type SessionState = {
  route: CodexSessionRoute;
  threadId: string | null;
  generation: number | null;
  activeTurnId: string | null;
  compactPending: boolean;
  pendingTurn: symbol | null;
  pendingStartTurnId: string | null;
  pendingTerminalTurnIds: Set<string>;
  terminalTurnIds: Set<string>;
};

export type CodexSessionFailure = { reason: string; code: CodexFailureCode };

export type CodexLimitListener = {
  onSnapshot(snapshot: AccountLimitSnapshot): void;
  onStale(reason: string): void;
};

export type CodexSessionRoute = {
  onNotification(method: string, params: unknown): void;
  onFatal(reason: string, code: CodexFailureCode): void;
  onServerRequest?(id: string | number, method: string, params: unknown, respond: (decision: CodexInteractionResult) => void): void;
  onServerResolved?(id: string | number): void;
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

function turnIdFrom(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  if (typeof value.turnId === 'string' && value.turnId.length > 0) return value.turnId;
  if (!value.turn || typeof value.turn !== 'object' || Array.isArray(value.turn)) return null;
  const turnId = (value.turn as Record<string, unknown>).id;
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
}

function rememberTerminalTurn(state: SessionState, turnId: string): void {
  state.terminalTurnIds.delete(turnId);
  state.terminalTurnIds.add(turnId);
  while (state.terminalTurnIds.size > TERMINAL_TURN_HISTORY) {
    const oldest = state.terminalTurnIds.values().next().value;
    if (oldest === undefined) break;
    state.terminalTurnIds.delete(oldest);
  }
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
  readonly #clientGenerations = new WeakMap<SupervisorClient, number>();
  readonly #approvals = new Map<string | number, { client: SupervisorClient; state: SessionState; answered: boolean }>();
  readonly #catalog: CodexCapabilityCatalog;
  readonly #screenshotWarnings = new Map<string,string[]>();
  #mode: CodexAppServerMode = 'telemetry';
  #client: SupervisorClient | null = null;
  #readyClient: SupervisorClient | null = null;
  #launch: Promise<void> | null = null;
  #promotion: Promise<void> | null = null;
  #retirement: ActiveRetirement | null = null;
  #read: ActiveRead | null = null;
  #boundaryRead: Promise<AccountLimitSnapshot> | null = null;
  #limitRevision = 0;
  #auth: CodexTelemetryAuth | null = null;
  #unsupportedAuthLatch: UnsupportedCodexTelemetryAuth | null = null;
  #authRevision = 0;
  #staleReason: string | null = null;
  #restartTimer: TimerHandle | null = null;
  #restartAttempt = 0;
  #nextGeneration = 1;
  #closed = false;
  #close: Promise<void> | null = null;

  constructor(options: CodexAppServerSupervisorOptions) {
    this.#options = options;
    this.#catalog = new CodexCapabilityCatalog(async (method, params) => {
      const client = this.#readyClient;
      if (this.#closed || this.#mode !== 'turns' || !client || client !== this.#client
          || !(CAPABILITY_METHODS as readonly string[]).includes(method)) throw unavailableError();
      const result = await client.request(method, params);
      if (this.#closed || client !== this.#readyClient || client !== this.#client) throw unavailableError();
      return result;
    }, value => redactCodexText(value, options.runtime.env)
      .replace(/(^|[^\p{L}\p{N}_./\\-])\/(?!\/)[^\s"'`<>{}\[\](),;:]+/gu, '$1[path omitted]')
      .replace(/(^|[^\p{L}\p{N}_./\\-])(?:[A-Za-z]:\\|\\\\)[^\s"'`<>{}\[\](),;:]+/gu, '$1[path omitted]'));


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
    if (this.#retirement) return Promise.reject(unavailableError());
    if (this.#promotion) return this.#promotion;
    if (this.#launch) return this.#launch;
    if (this.#client) return Promise.resolve();
    if (this.#restartTimer !== null) return Promise.reject(unavailableError());
    return this.#beginLaunch();
  }

  ensureTurnTransport(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailableError());
    if (this.#promotion) return this.#promotion;
    if (this.#retirement) return Promise.reject(unavailableError());
    if (this.#mode === 'turns') return this.start();
    if ([...this.#sessions.values()].some((session) => session.activeTurnId || session.pendingTurn || session.compactPending)) {
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
    const ready = this.#readyClient;
    const state: SessionState = {
      route,
      threadId: null,
      generation: !this.#promotion && ready && ready === this.#client
        ? this.#clientGenerations.get(ready) ?? null
        : null,
      activeTurnId: null,
      compactPending: false,
      pendingTurn: null,
      pendingStartTurnId: null,
      pendingTerminalTurnIds: new Set(),
      terminalTurnIds: new Set(),
    };
    this.#sessions.set(sessionId, state);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#sessions.get(sessionId) !== state) return;
      this.#sessions.delete(sessionId);
      this.#screenshotWarnings.delete(sessionId);
      for (const [id, pending] of this.#approvals) if (pending.state === state) this.#approvals.delete(id);
      if (state.threadId !== null && this.#threadOwners.get(state.threadId) === sessionId) {
        this.#threadOwners.delete(state.threadId);
      }
    };
  }

  bindThread(sessionId: string, threadId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error('Codex session is not registered.');
    if (typeof threadId !== 'string' || threadId.length === 0 || unsafeCodexProviderIdentifier(threadId)) {
      throw new CodexRuntimeError('codex_protocol_mismatch', 'Codex thread identifier is invalid.');
    }
    if (state.threadId !== null || this.#threadOwners.has(threadId)) throw new Error('Codex thread is already bound.');
    state.threadId = threadId;
    this.#threadOwners.set(threadId, sessionId);
  }

  async previewCapabilities(cwd: string, force = false) {
    await this.ensureTurnTransport();
    const client = this.#readyClient;
    if (!client || this.#closed) throw unavailableError();
    const result = await this.#catalog.list(cwd, undefined, force);
    if (this.#closed || client !== this.#readyClient) throw unavailableError();
    return result;
  }

  async capabilitiesForSession(sessionId: string, cwd: string, force = false, selection?: string) {
    const state = this.#sessions.get(sessionId);
    const client = this.#readyClient;
    if (!state?.threadId || !client || state.generation !== this.#clientGenerations.get(client)) throw unavailableError();
    const result = selection === undefined
      ? await this.#catalog.list(cwd, state.threadId, force)
      : await this.#catalog.expand(selection, cwd, state.threadId, force);
    if (this.#sessions.get(sessionId) !== state || client !== this.#readyClient) throw unavailableError();
    if (result && !Array.isArray(result)) result.warnings.push(...(this.#screenshotWarnings.get(sessionId) ?? []));
    return result;
  }

  async requestForSession<T>(
    sessionId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/interrupt' | 'thread/compact/start',
    params: unknown,
    onDispatched?: () => void,
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
    const generation = this.#clientGenerations.get(client);
    if (generation === undefined) throw unavailableError();
    if (state.generation === null) state.generation = generation;
    if (state.generation !== generation) {
      throw new Error('Codex session transport was retired; resume the session manually.');
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      const value = params as {cwd?:unknown;config?:Record<string,unknown>};
      let overrides:Record<string,unknown> = {};
      try {
        if (typeof value.cwd !== 'string') throw new Error();
        const read = await client.request<{config?:unknown}>('config/read', {cwd:value.cwd,includeLayers:false});
        if (!read.config || typeof read.config !== 'object' || Array.isArray(read.config)) throw new Error();
        const injected = screenshotConfig({nodePath:process.execPath,
          browserEntry:fileURLToPath(new URL('./mcp/browser-server.ts',import.meta.url)),
          simulatorEntry:fileURLToPath(new URL('./mcp/simulator-server.ts',import.meta.url)),
          platform:process.platform,chromePath:CHROME,home:homedir(),config:{...read.config as Record<string,unknown>,
            ...(value.config?.sandbox_workspace_write ? {sandbox_workspace_write:value.config.sandbox_workspace_write} : {})}});
        overrides = injected.overrides;
        this.#screenshotWarnings.set(sessionId,injected.warnings);
      } catch {
        this.#screenshotWarnings.set(sessionId,['Screenshot tools unavailable: worktree configuration could not be checked.']);
      }
      if (this.#closed || this.#sessions.get(sessionId) !== state || this.#readyClient !== client) throw unavailableError();
      params = {...value,config:{...value.config,...overrides}};
    }
    if (method === 'thread/compact/start') {
      if ((params as {threadId?:unknown})?.threadId !== state.threadId || !state.threadId) throw unavailableError();
      if (state.activeTurnId || state.pendingTurn || state.compactPending) throw new Error('Codex session already has an active turn.');
      state.compactPending = true;
      try { return await client.request<T>(method, params, onDispatched); }
      catch (error) { state.compactPending = false; throw error; }
    }
    if (method !== 'turn/start') return client.request<T>(method, params, onDispatched);
    if (state.activeTurnId || state.pendingTurn || state.compactPending) throw new Error('Codex session already has an active turn.');
    const pendingTurn = Symbol(sessionId);
    state.pendingTurn = pendingTurn;
    state.pendingStartTurnId = null;
    state.pendingTerminalTurnIds.clear();
    try {
      const response = await client.request<T>(method, params, onDispatched);
      if (this.#sessions.get(sessionId) === state
        && state.generation === generation
        && state.pendingTurn === pendingTurn) {
        const notifiedTurnId = state.pendingStartTurnId;
        const responseTurnId = turnIdFrom(response);
        if (unsafeCodexProviderIdentifier(responseTurnId)) {
          const error = new CodexRuntimeError('codex_protocol_mismatch', 'Codex turn identifier is invalid.');
          await this.#retire(client, true, { reason: error.message, code: error.code }, sessionId);
          throw error;
        }
        const responseWasTerminal = responseTurnId !== null
          && state.pendingTerminalTurnIds.has(responseTurnId);
        state.pendingTurn = null;
        state.pendingStartTurnId = null;
        state.pendingTerminalTurnIds.clear();
        if (notifiedTurnId !== null && responseTurnId !== notifiedTurnId) {
          if (state.activeTurnId === notifiedTurnId) state.activeTurnId = null;
          const error = new CodexRuntimeError(
            'codex_protocol_mismatch',
            'Codex app-server protocol mismatch between turn response and start notification.',
          );
          await this.#retire(client, true, { reason: error.message, code: error.code }, sessionId);
          throw error;
        }
        if (responseWasTerminal && responseTurnId !== null) rememberTerminalTurn(state, responseTurnId);
        state.activeTurnId = responseWasTerminal ? null : responseTurnId;
      }
      return response;
    } catch (error) {
      if (this.#sessions.get(sessionId) === state
        && state.generation === generation
        && state.pendingTurn === pendingTurn) {
        const notifiedTurnId = state.pendingStartTurnId;
        state.pendingTurn = null;
        state.pendingStartTurnId = null;
        state.pendingTerminalTurnIds.clear();
        if (state.activeTurnId === notifiedTurnId) state.activeTurnId = null;
      }
      throw error;
    }
  }

  async retireSessionGeneration(sessionId: string, failure?: CodexSessionFailure): Promise<void> {
    const state = this.#sessions.get(sessionId);
    if (!state || state.generation === null) return;
    const retirement = this.#retirement;
    if (retirement && retirement.generation === state.generation) {
      await retirement.promise;
      return;
    }
    const client = this.#client;
    if (!client) return;
    const generation = this.#clientGenerations.get(client);
    if (generation === undefined || state.generation !== generation) return;
    await this.#retire(client, true, failure, failure ? sessionId : undefined);
  }

  async reconcile(): Promise<AccountLimitSnapshot> {
    await this.start();
    if (this.#promotion) await this.#promotion;
    return this.#readCurrent(this.#now());
  }

  readAtResetBoundary(now = this.#now()): Promise<AccountLimitSnapshot> {
    if (this.#boundaryRead) return this.#boundaryRead;
    // A reconciliation already dispatched before this call cannot establish
    // post-failure/post-boundary capacity. Join it only to drain it; concurrent
    // boundary callers share the subsequent authoritative read.
    const older = this.#read;
    const boundary = (async () => {
      await this.start();
      if (this.#promotion) await this.#promotion;
      if (older) await older.promise.catch(() => {});
      return this.#readCurrent(now);
    })();
    this.#boundaryRead = boundary;
    void boundary.finally(() => {
      if (this.#boundaryRead === boundary) this.#boundaryRead = null;
    }).catch(() => {});
    return boundary;
  }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async #promoteNow(): Promise<void> {
    const queuedRetirement = this.#retirement;
    if (queuedRetirement) await queuedRetirement.promise;
    const existingLaunch = this.#launch;
    if (existingLaunch) await existingLaunch.catch(() => {});
    if (this.#launch === existingLaunch) this.#launch = null;
    const launchRetirement = this.#retirement;
    if (launchRetirement) await launchRetirement.promise;
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
    } catch {
      this.#handleFailure(false);
      if (mode === 'turns') {
        throw new CodexRuntimeError('codex_protocol_mismatch', 'Codex app-server protocol mismatch.');
      }
      throw unavailableError();
    }
    if (this.#closed) return;
    try {
      client = this.#createClient(mode);
      this.#client = client;
      await client.request('initialize', {
        clientInfo: { name: 'switchboard_telemetry', title: 'Switchboard telemetry', version: '0.1.0' },
        capabilities: mode === 'turns' ? { experimentalApi: true, requestAttestation: false } : null,
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
      try {
        await this.#readFrom(client, this.#now());
      } catch (error) {
        // Only the optional limit read may fail after successful initialization.
        if (!(error instanceof AppServerRequestError)) throw error;
      }
    } catch {
      if (client !== null) await this.#retire(client, true);
      else this.#handleFailure(false);
      if (mode === 'turns') {
        throw new CodexRuntimeError(
          'codex_app_server_initialization_failed',
          'Codex app-server initialization failed.',
        );
      }
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
      onServerRequest: (id, method, params) => this.#serverRequest(client, id, method, params),
      onExit: (error) => this.#clientExit(client, error),
    });
    this.#catalog.invalidate();
    this.#clientGenerations.set(client, this.#nextGeneration++);
    return client;
  }

  #notification(client: SupervisorClient, method: string, params: unknown): void {
    if (client !== this.#client || this.#closed) return;
    if ((PRIVATE_NOTIFICATIONS as readonly string[]).includes(method)) return;
    if (client !== this.#readyClient) return;
    if ((CAPABILITY_NOTIFICATIONS as readonly string[]).includes(method)) {
      this.#catalog.invalidate();
      return;
    }
    if (method === 'account/updated') this.#catalog.invalidate();
    if (method === 'serverRequest/resolved') {
      const value = params as {threadId?: unknown; requestId?: unknown} | null;
      if (!value || (typeof value.requestId !== 'string' && typeof value.requestId !== 'number')) return;
      const pending = this.#approvals.get(value.requestId);
      if (!pending || pending.client !== client || pending.state.threadId !== value.threadId) return;
      this.#approvals.delete(value.requestId);
      pending.state.route.onServerResolved?.(value.requestId);
      return;
    }
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
    const generation = this.#clientGenerations.get(client);
    if (!state || state.threadId !== threadId || generation === undefined || state.generation !== generation) return;
    const turnId = turnIdFrom(params);
    if (unsafeCodexProviderIdentifier(turnId)) {
      void this.#retire(client, true, {
        reason: 'Codex turn identifier is invalid.', code: 'codex_protocol_mismatch',
      }, sessionId).catch(() => {});
      return;
    }
    if (method === 'turn/started' && turnId) {
      if (state.compactPending && !state.terminalTurnIds.has(turnId)) {
        state.compactPending = false;
        state.activeTurnId = turnId;
      }
      if (state.pendingTurn !== null) {
        if (state.terminalTurnIds.has(turnId)) return;
        if (state.pendingStartTurnId === null) {
          state.pendingStartTurnId = turnId;
          if (!state.pendingTerminalTurnIds.has(turnId)) state.activeTurnId = turnId;
        } else if (state.pendingStartTurnId !== turnId) {
          return;
        }
      } else if (state.activeTurnId !== turnId) return;
    }
    if (method === 'turn/completed' && turnId) {
      if (state.pendingTurn !== null
        && (state.pendingStartTurnId === null || state.pendingStartTurnId === turnId)) {
        state.pendingTerminalTurnIds.add(turnId);
      }
      if (turnId === state.activeTurnId) {
        state.activeTurnId = null;
        rememberTerminalTurn(state, turnId);
      }
    }
    try {
      state.route.onNotification(method, params);
    } catch {
      // Session observers cannot desynchronize shared process ownership.
    }
  }

  #serverRequest(client: SupervisorClient, id: string | number, method: string, params: unknown): void {
    if (client !== this.#client || this.#closed) return;
    if (this.#mode === 'turns' && client === this.#readyClient && client.respond
      && (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request')) {
      const value = params as {threadId?: unknown; turnId?: unknown; itemId?: unknown} | null;
      const sessionId = value && typeof value.threadId === 'string' ? this.#threadOwners.get(value.threadId) : undefined;
      const state = sessionId ? this.#sessions.get(sessionId) : undefined;
      const elicitation = method === 'mcpServer/elicitation/request';
      const activeTurn = state && value && (state.activeTurnId === value.turnId
        || (state.pendingTurn !== null && state.pendingStartTurnId === value.turnId));
      const validTurn = value && (typeof value.turnId === 'string' && !unsafeCodexProviderIdentifier(value.turnId)
        && activeTurn || elicitation && value.turnId === null && state?.activeTurnId != null);
      if (state?.route.onServerRequest && value && validTurn
        && (elicitation || typeof value.itemId === 'string' && !unsafeCodexProviderIdentifier(value.itemId))
        && state.generation === this.#clientGenerations.get(client)
        && !this.#approvals.has(id) && this.#approvals.size < 256) {
        const pending = {client,state,answered:false};
        this.#approvals.set(id,pending);
        const respond = (decision: CodexInteractionResult) => {
          if (this.#approvals.get(id) !== pending || pending.answered || client !== this.#readyClient) return;
          pending.answered = true;
          client.respond!(id, typeof decision === 'string' ? { decision } : decision);
        };
        try { state.route.onServerRequest(id,method,params,respond); }
        catch { respond(elicitation ? {action:'cancel',content:null,_meta:null} : method === 'item/tool/requestUserInput' ? { answers: {} } : 'decline'); }
        return;
      }
    }
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

  #clientExit(client: SupervisorClient, error: Error): void {
    if (client !== this.#client || this.#closed) return;
    const generation = this.#clientGenerations.get(client);
    this.#client = null;
    this.#readyClient = null;
    const reason = redactValues(error.message, Object.values(this.#options.runtime.env));
    const routeFailure = /^Codex app-server request .+ timed out after \d+ms\.$/.test(reason)
      ? { reason, code: 'codex_request_timed_out' as const }
      : undefined;
    this.#handleFailure(true, routeFailure, generation);
  }

  async #readCurrent(now: number): Promise<AccountLimitSnapshot> {
    if (!this.#auth?.supported) throw new Error(this.#auth?.reason ?? PUBLIC_UNAVAILABLE);
    const client = this.#client;
    if (!client) throw unavailableError();
    try {
      return await this.#readFrom(client, now);
    } catch (error) {
      if (error instanceof AppServerRequestError) throw unavailableError();
      throw error;
    }
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
      if (error instanceof AppServerRequestError) {
        this.#markStale(PUBLIC_UNAVAILABLE);
        throw error;
      }
      await this.#retire(client, true);
      throw unavailableError();
    }
  }

  #retire(
    client: SupervisorClient,
    fatalRoutes: boolean,
    routeFailure?: CodexSessionFailure,
    routeSessionId?: string,
  ): Promise<void> {
    const active = this.#retirement;
    if (active?.client === client) return active.promise;
    if (client !== this.#client) return Promise.resolve();
    const generation = this.#clientGenerations.get(client);
    this.#client = null;
    this.#readyClient = null;
    let resolveRetirement!: () => void;
    let rejectRetirement!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRetirement = resolve;
      rejectRetirement = reject;
    });
    const retirement: ActiveRetirement = { client, generation, promise };
    this.#retirement = retirement;
    void this.#retireNow(client, fatalRoutes, generation, routeFailure, routeSessionId).then(
      () => {
        if (this.#retirement === retirement) this.#retirement = null;
        resolveRetirement();
      },
      (error) => {
        if (this.#retirement === retirement) this.#retirement = null;
        rejectRetirement(error);
      },
    );
    return promise;
  }

  async #retireNow(
    client: SupervisorClient,
    fatalRoutes: boolean,
    generation: number | undefined,
    routeFailure?: CodexSessionFailure,
    routeSessionId?: string,
  ): Promise<void> {
    try {
      await client.close();
    } catch {
      // AppServerClient already bounded and sanitized shutdown.
    }
    this.#handleFailure(fatalRoutes, routeFailure, generation, routeSessionId);
  }

  #handleFailure(
    fatalRoutes: boolean,
    routeFailure?: CodexSessionFailure,
    generation?: number,
    routeSessionId?: string,
  ): void {
    if (this.#closed) return;
    this.#markStale(PUBLIC_UNAVAILABLE);
    if (fatalRoutes && this.#mode === 'turns' && generation !== undefined) {
      this.#fatalRoutes(generation, routeFailure, routeSessionId);
    }
    this.#scheduleRestart();
  }

  #fatalRoutes(
    generation: number,
    routeFailure?: CodexSessionFailure,
    routeSessionId?: string,
  ): void {
    const transportFailure: CodexSessionFailure = {
      reason: PUBLIC_TRANSPORT_CRASH, code: 'codex_transport_crashed',
    };
    const failed: Array<{ state: SessionState; failure: CodexSessionFailure }> = [];
    for (const [sessionId, state] of [...this.#sessions]) {
      if (state.generation !== generation) continue;
      this.#sessions.delete(sessionId);
      this.#screenshotWarnings.delete(sessionId);
      for (const [id, pending] of this.#approvals) if (pending.state === state) this.#approvals.delete(id);
      if (state.threadId !== null && this.#threadOwners.get(state.threadId) === sessionId) {
        this.#threadOwners.delete(state.threadId);
      }
      state.activeTurnId = null;
      state.pendingTurn = null;
      state.pendingStartTurnId = null;
      state.pendingTerminalTurnIds.clear();
      state.terminalTurnIds.clear();
      failed.push({
        state,
        failure: routeFailure && (routeSessionId === undefined || routeSessionId === sessionId)
          ? routeFailure
          : transportFailure,
      });
    }
    for (const failedRoute of failed) {
      try {
        failedRoute.state.route.onFatal(failedRoute.failure.reason, failedRoute.failure.code);
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
    const retirement = this.#retirement?.promise;
    this.#client = null;
    this.#readyClient = null;
    this.#sessions.clear();
    this.#approvals.clear();
    this.#threadOwners.clear();
    this.#listeners.clear();
    if (client) {
      try {
        await client.close();
      } catch {
        // Closing stays idempotent after bounded forced termination.
      }
    }
    await retirement?.catch(() => {});
    await this.#launch?.catch(() => {});
    await this.#promotion?.catch(() => {});
  }
}
