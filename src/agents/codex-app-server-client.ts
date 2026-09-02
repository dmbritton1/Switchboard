import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 250;
const SIGKILL_WAIT_MS = 1_000;

export type AppServerClientOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  requestTimeoutMs?: number;
  redact: (text: string) => string;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (id: string | number, method: string, params: unknown) => void;
  onExit: (error: Error) => void;
};

type Message = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onDispatched?: () => void;
  dispatched: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}

export class AppServerClient {
  readonly #options: AppServerClientOptions;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: readline.Interface;
  readonly #pending = new Map<number, Pending>();
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #nextId = 1;
  #closing = false;
  #exited = false;
  #settled = false;
  #terminalError: Error | null = null;
  #termination: Promise<void> | null = null;
  #close: Promise<void> | null = null;

  constructor(options: AppServerClientOptions) {
    this.#options = options;
    this.#child = spawn(options.command, options.args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stderr.on('data', () => {
      // stderr can include credentials, account metadata, or absolute paths.
    });
    this.#child.stdin.on('error', () => {
      if (!this.#closing) this.#fail('Codex app-server input closed unexpectedly.');
    });
    this.#lines = readline.createInterface({ input: this.#child.stdout });
    this.#lines.on('line', (line) => this.#receive(line));
    this.#exit = new Promise((resolve) => {
      this.#child.once('error', () => this.#fail('Codex app-server could not be started.'));
      this.#child.once('close', (code, signal) => {
        this.#exited = true;
        if (!this.#closing && !this.#terminalError) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
          this.#fail(`Codex app-server exited unexpectedly (${detail}).`);
        }
        resolve({ code, signal });
      });
    });
  }

  request<T>(method: string, params?: unknown, onDispatched?: () => void): Promise<T> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#fail(`Codex app-server request ${method} timed out after ${this.#timeout()}ms.`, true);
      }, this.#timeout());
      const pending: Pending = { resolve, reject, timer, onDispatched, dispatched: false };
      this.#pending.set(id, pending);
      this.#send(
        params === undefined ? { method, id } : { method, id, params },
        () => this.#ackDispatch(pending),
      );
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#terminalError) throw this.#terminalError;
    this.#send(params === undefined ? { method } : { method, params });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (this.#terminalError) throw this.#terminalError;
    this.#send({ id, error: { code, message: this.#redact(message) } });
  }

  async close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.#closeNow();
    return this.#close;
  }

  async #closeNow(): Promise<void> {
    if (this.#terminalError) {
      await this.#termination?.catch(() => {});
      this.#lines.close();
      return;
    }
    this.#closing = true;
    this.#settlePendingForClose();
    this.#child.stdin.end();
    try {
      const outcome = await Promise.race([
        this.#exit.then((exit) => ({ type: 'exit' as const, exit })),
        delay(this.#timeout()).then(() => ({ type: 'timeout' as const })),
      ]);
      if (outcome.type === 'timeout') {
        const error = this.#error(`Codex app-server shutdown timed out after ${this.#timeout()}ms.`);
        this.#fail(error.message, true);
        await this.#termination?.catch(() => {});
        throw error;
      }
      if (outcome.exit.code !== 0 || outcome.exit.signal !== null) {
        const detail = outcome.exit.signal ? `signal ${outcome.exit.signal}` : `code ${outcome.exit.code ?? 1}`;
        const error = this.#error(`Codex app-server exited unexpectedly (${detail}).`);
        this.#fail(error.message);
        throw error;
      }
    } finally {
      this.#lines.close();
    }
  }

  #timeout(): number {
    return this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  #send(message: Record<string, unknown>, onDispatched?: () => void): void {
    if (this.#child.stdin.destroyed) {
      this.#fail('Codex app-server input closed unexpectedly.');
      return;
    }
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.#fail('Codex app-server input closed unexpectedly.');
        else onDispatched?.();
      });
    } catch {
      this.#fail('Codex app-server input closed unexpectedly.');
    }
  }

  #receive(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.#fail('Codex app-server returned invalid JSON.');
      return;
    }
    if (!isObject(message)) {
      this.#fail('Codex app-server returned an invalid message.');
      return;
    }
    if (typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')) {
      this.#reportServerRequest(message.id, message.method, message.params);
      return;
    }
    if ((typeof message.id === 'string' || typeof message.id === 'number') && message.method === undefined) {
      if (typeof message.id !== 'number') {
        this.#fail('Codex app-server returned an unknown response id.');
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fail('Codex app-server returned an unknown response id.');
        return;
      }
      this.#ackDispatch(pending);
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(this.#error('Codex app-server request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      try {
        this.#options.onNotification(message.method, message.params);
      } catch {
        this.#fail('Codex app-server notification handling failed.');
      }
      return;
    }
    this.#fail('Codex app-server returned an invalid message.');
  }

  #ackDispatch(pending: Pending): void {
    if (pending.dispatched) return;
    pending.dispatched = true;
    pending.onDispatched?.();
  }

  #reportServerRequest(id: string | number, method: string, params: unknown): void {
    try {
      this.#options.onServerRequest(id, method, params);
    } catch {
      this.#fail('Codex app-server server-request handling failed.');
    }
  }

  #fail(message: string, waitForTermination = false): void {
    if (this.#terminalError) return;
    this.#terminalError = this.#error(message);
    if (waitForTermination) {
      void this.#terminateBounded().then(
        () => this.#settleTerminal(),
        () => this.#settleTerminal(),
      );
      return;
    }
    this.#settleTerminal();
    void this.#terminateBounded().catch(() => {});
  }

  #settlePendingForClose(): void {
    if (this.#pending.size === 0 || this.#terminalError) return;
    this.#terminalError = this.#error('Codex app-server closed while requests were pending.');
    this.#settleTerminal();
  }

  #settleTerminal(): void {
    if (this.#settled || !this.#terminalError) return;
    this.#settled = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#terminalError);
    }
    this.#pending.clear();
    try {
      this.#options.onExit(this.#terminalError);
    } catch {
      // Callbacks are observer-only and cannot replace the terminal reason.
    }
  }

  #terminateBounded(): Promise<void> {
    if (this.#termination) return this.#termination;
    this.#termination = (async () => {
      if (this.#exited) return;
      this.#child.kill('SIGTERM');
      const exitedAfterTerm = await Promise.race([
        this.#exit.then(() => true),
        delay(TERMINATION_GRACE_MS).then(() => false),
      ]);
      if (exitedAfterTerm || this.#exited) return;
      this.#child.kill('SIGKILL');
      const exitedAfterKill = await Promise.race([
        this.#exit.then(() => true),
        delay(SIGKILL_WAIT_MS).then(() => false),
      ]);
      if (!exitedAfterKill && !this.#exited) throw this.#error('Codex app-server child could not be reaped.');
    })();
    return this.#termination;
  }

  #error(message: string): Error {
    return new Error(this.#redact(message));
  }

  #redact(text: string): string {
    try {
      return this.#options.redact(text);
    } catch {
      return 'Codex app-server failed.';
    }
  }
}
