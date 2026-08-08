import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { prepareCodexRuntime } from '../src/agents/codex-runtime.ts';

const REQUEST_TIMEOUT_MS = 5_000;
const SCHEMA_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 250;
const SIGKILL_WAIT_MS = 1_000;

export type AppServerEvidence = {
  version: string;
  schemaGenerated: boolean;
  initialized: boolean;
  authStateReadable: boolean;
  lifecycleRoundTrip: boolean;
  followUpRoundTrip: boolean;
  resumeRoundTrip: boolean;
  cancellationRoundTrip: boolean;
  commandApprovalRoundTrip: boolean;
  fileApprovalRoundTrip: boolean;
  mcpElicitationObserved: boolean;
  processCrashHandled: boolean;
  vendorThreadMigration: 'verified' | 'not-proven';
  cleanShutdown: boolean;
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
};

type NotificationWaiter = {
  method: string;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function idKey(id: unknown): string {
  return `${typeof id}:${String(id)}`;
}

function parseVersion(userAgent: unknown): string {
  if (typeof userAgent !== 'string') return 'unknown';
  return userAgent.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/)?.[1]
    ?? 'unknown';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}

class AppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: readline.Interface;
  readonly #pending = new Map<number, Pending>();
  readonly #notifications: Array<{ method: string; params: unknown }> = [];
  readonly #waiters = new Set<NotificationWaiter>();
  readonly #serverMethods = new Map<string, string>();
  readonly #resolvedServerRequests = new Set<string>();
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #nextId = 1;
  #closing = false;
  #failed = false;
  #exited = false;
  #terminalError: Error | null = null;
  #termination: Promise<void> | null = null;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.#child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child.stderr.on('data', () => {
      // Deliberately consume and discard stderr. It may contain paths, account
      // identifiers, or credentials, none of which are evaluation evidence.
    });
    this.#child.stdin.on('error', () => {
      this.#fail(new Error('Codex app-server input closed unexpectedly.'));
    });
    this.#lines = readline.createInterface({ input: this.#child.stdout });
    this.#lines.on('line', (line) => this.#receive(line));
    this.#exit = new Promise((resolve) => {
      this.#child.once('error', () => {
        this.#fail(new Error('Codex app-server could not be started.'));
      });
      this.#child.once('close', (code, signal) => {
        this.#exited = true;
        if (!this.#closing) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
          this.#fail(new Error(`Codex app-server exited unexpectedly (${detail}).`));
        }
        resolve({ code, signal });
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const timeout = new Error(
          `Codex app-server request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        );
        void this.#terminateBounded().then(
          () => reject(timeout),
          () => reject(new Error('Codex app-server could not be terminated after request timeout.')),
        );
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#terminalError) throw this.#terminalError;
    this.#send(params === undefined ? { method } : { method, params });
  }

  waitFor(method: string, predicate: (params: unknown) => boolean): Promise<unknown> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const previous = this.#notifications.find(
      (notification) => notification.method === method && predicate(notification.params),
    );
    if (previous) return Promise.resolve(previous.params);

    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          const timeout = new Error(
            `Codex app-server notification ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          );
          void this.#terminateBounded().then(
            () => reject(timeout),
            () => reject(new Error('Codex app-server could not be terminated after notification timeout.')),
          );
        }, REQUEST_TIMEOUT_MS),
      };
      this.#waiters.add(waiter);
    });
  }

  sawNotification(method: string, predicate: (params: unknown) => boolean): boolean {
    return this.#notifications.some(
      (notification) => notification.method === method && predicate(notification.params),
    );
  }

  serverRequestRoundTrip(method: string): boolean {
    for (const [requestId, observedMethod] of this.#serverMethods) {
      if (observedMethod === method && this.#resolvedServerRequests.has(requestId)) return true;
    }
    return false;
  }

  async shutdown(): Promise<boolean> {
    if (this.#terminalError) throw this.#terminalError;
    this.#closing = true;
    this.#child.stdin.end();
    try {
      const outcome = await Promise.race([
        this.#exit.then((exit) => ({ type: 'exit' as const, exit })),
        delay(REQUEST_TIMEOUT_MS).then(() => ({ type: 'timeout' as const })),
      ]);
      if (outcome.type === 'timeout') {
        await this.#terminateBounded();
        throw new Error(`Codex app-server shutdown timed out after ${REQUEST_TIMEOUT_MS}ms.`);
      }
      const { code, signal } = outcome.exit;
      return code === 0 && signal === null;
    } finally {
      this.#lines.close();
    }
  }

  async dispose(): Promise<void> {
    this.#closing = true;
    await this.#terminateBounded();
    this.#lines.close();
  }

  #send(message: Record<string, unknown>): void {
    if (this.#child.stdin.destroyed) {
      throw new Error('Codex app-server input closed unexpectedly.');
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#fail(new Error('Codex app-server input closed unexpectedly.'));
    });
  }

  #receive(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.#fail(new Error('Codex app-server returned invalid JSON.'));
      return;
    }
    if (!object(message)) {
      this.#fail(new Error('Codex app-server returned an invalid message.'));
      return;
    }

    if (typeof message.method === 'string' && message.id !== undefined) {
      this.#handleServerRequest(message);
      return;
    }
    if (typeof message.id === 'number' && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fail(new Error('Codex app-server returned an unknown response id.'));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error('Codex app-server request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      this.#recordNotification(message.method, message.params);
      return;
    }
    this.#fail(new Error('Codex app-server returned an invalid message.'));
  }

  #handleServerRequest(message: Message): void {
    const method = message.method as string;
    const requestId = idKey(message.id);
    this.#serverMethods.set(requestId, method);
    let result: Record<string, unknown>;
    switch (method) {
      case 'item/commandExecution/requestApproval':
        result = { decision: 'acceptForSession' };
        break;
      case 'item/fileChange/requestApproval':
        result = { decision: 'accept' };
        break;
      case 'mcpServer/elicitation/request':
        result = { action: 'decline', content: null, _meta: null };
        break;
      default:
        this.#fail(new Error('Codex app-server requested an unsupported or experimental client action.'));
        return;
    }
    this.#send({ id: message.id, result });
  }

  #recordNotification(method: string, params: unknown): void {
    this.#notifications.push({ method, params });
    if (method === 'serverRequest/resolved') {
      const requestId = object(params)?.requestId;
      if (requestId !== undefined) this.#resolvedServerRequests.add(idKey(requestId));
    }
    for (const waiter of this.#waiters) {
      if (waiter.method !== method || !waiter.predicate(params)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(params);
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
      if (!exitedAfterKill && !this.#exited) {
        throw new Error('Codex app-server child could not be reaped.');
      }
    })();
    return this.#termination;
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#terminalError = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    void this.#terminateBounded().catch(() => {});
  }
}

function threadIdFrom(result: unknown): string | null {
  const thread = object(object(result)?.thread);
  return typeof thread?.id === 'string' ? thread.id : null;
}

function turnFrom(result: unknown): Record<string, unknown> | null {
  return object(object(result)?.turn);
}

function completedTurn(params: unknown, threadId: string, turnId: string, status: string): boolean {
  const value = object(params);
  const turn = object(value?.turn);
  return value?.threadId === threadId && turn?.id === turnId && turn.status === status;
}

function itemForTurn(params: unknown, turnId: string): boolean {
  return object(params)?.turnId === turnId;
}

async function controlledCrashHandled(
  command: string,
  env: Record<string, string>,
): Promise<boolean> {
  const secret = 'fixture-controlled-crash-secret';
  const client = new AppServerClient(command, [], {
    ...env,
    FAKE_APP_SERVER_MODE: 'crash',
    PROBE_TOKEN: secret,
  });
  try {
    await client.request('initialize', {
      clientInfo: { name: 'switchboard_probe', title: 'Switchboard probe', version: '0.1.0' },
      capabilities: null,
    });
    return false;
  } catch (error) {
    return error instanceof Error
      && /exited unexpectedly/i.test(error.message)
      && !error.message.includes(secret);
  } finally {
    await client.dispose();
  }
}

async function probeFixture(
  command: string,
  env: Record<string, string>,
): Promise<AppServerEvidence> {
  const client = new AppServerClient(command, [], env);
  try {
    const initialized = object(await client.request('initialize', {
      clientInfo: { name: 'switchboard_probe', title: 'Switchboard probe', version: '0.1.0' },
      capabilities: null,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    client.notify('initialized');

    const accountPromise = client.request('account/read', { refreshToken: false });
    const threadPromise = client.request('thread/start', {});
    const [accountResult, threadResult] = await Promise.all([accountPromise, threadPromise]);
    const account = object(accountResult);
    const authStateReadable = account !== null
      && 'account' in account
      && typeof account.requiresOpenaiAuth === 'boolean';
    const threadId = threadIdFrom(threadResult);
    if (!threadId) throw new Error('Codex app-server returned no fixture thread id.');

    const first = turnFrom(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fixture lifecycle' }],
    }));
    const firstTurnId = typeof first?.id === 'string' ? first.id : null;
    if (!firstTurnId) throw new Error('Codex app-server returned no fixture turn id.');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await client.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, firstTurnId, 'completed'),
    );

    const followUp = turnFrom(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fixture follow-up' }],
    }));
    const followUpId = typeof followUp?.id === 'string' ? followUp.id : null;
    if (!followUpId) throw new Error('Codex app-server returned no follow-up turn id.');
    await client.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, followUpId, 'completed'),
    );

    const resumedThreadId = threadIdFrom(await client.request('thread/resume', { threadId }));

    const cancellable = turnFrom(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fixture interrupt' }],
    }));
    const cancellableId = typeof cancellable?.id === 'string' ? cancellable.id : null;
    if (!cancellableId) throw new Error('Codex app-server returned no cancellable turn id.');
    await client.request('turn/interrupt', { threadId, turnId: cancellableId });
    await client.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, cancellableId, 'interrupted'),
    );

    const lifecycleRoundTrip = first.status === 'inProgress'
      && client.sawNotification('item/started', (params) => itemForTurn(params, firstTurnId))
      && client.sawNotification('item/completed', (params) => itemForTurn(params, firstTurnId));
    const followUpRoundTrip = followUp.status === 'inProgress';
    const cancellationRoundTrip = cancellable.status === 'inProgress';
    const cleanShutdown = await client.shutdown();
    const processCrashHandled = await controlledCrashHandled(command, env);

    return {
      version: parseVersion(initialized?.userAgent),
      schemaGenerated: false,
      initialized: initialized !== null,
      authStateReadable,
      lifecycleRoundTrip,
      followUpRoundTrip,
      resumeRoundTrip: resumedThreadId === threadId,
      cancellationRoundTrip,
      commandApprovalRoundTrip: client.serverRequestRoundTrip('item/commandExecution/requestApproval'),
      fileApprovalRoundTrip: client.serverRequestRoundTrip('item/fileChange/requestApproval'),
      mcpElicitationObserved: client.serverRequestRoundTrip('mcpServer/elicitation/request'),
      processCrashHandled,
      vendorThreadMigration: 'not-proven',
      cleanShutdown,
    };
  } finally {
    await client.dispose();
  }
}

async function generateSchema(
  command: string,
  env: Record<string, string>,
  out: string,
): Promise<void> {
  const child = spawn(command, ['app-server', 'generate-ts', '--out', out], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {
    // Generated-schema warnings are not evidence and may contain private paths.
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => reject(new Error('Codex app-server schema generation could not start.')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const outcome = await Promise.race([
    exit.then((result) => ({ type: 'exit' as const, result })),
    delay(SCHEMA_TIMEOUT_MS).then(() => ({ type: 'timeout' as const })),
  ]);
  if (outcome.type === 'timeout') {
    child.kill('SIGTERM');
    const exitedAfterTerm = await Promise.race([
      exit.then(() => true),
      delay(TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (!exitedAfterTerm) {
      child.kill('SIGKILL');
      const exitedAfterKill = await Promise.race([
        exit.then(() => true),
        delay(SIGKILL_WAIT_MS).then(() => false),
      ]);
      if (!exitedAfterKill) throw new Error('Codex app-server schema generator could not be reaped.');
    }
    throw new Error(`Codex app-server schema generation timed out after ${SCHEMA_TIMEOUT_MS}ms.`);
  }
  const { code, signal } = outcome.result;
  if (code !== 0 || signal !== null) throw new Error('Codex app-server schema generation failed.');
}

async function schemaHasStableSurface(directory: string): Promise<boolean> {
  const [clientRequests, serverRequests, notifications] = await Promise.all([
    readFile(join(directory, 'ClientRequest.ts'), 'utf8'),
    readFile(join(directory, 'ServerRequest.ts'), 'utf8'),
    readFile(join(directory, 'ServerNotification.ts'), 'utf8'),
  ]);
  return [
    '"method": "thread/start"',
    '"method": "turn/start"',
    '"method": "thread/resume"',
    '"method": "turn/interrupt"',
  ].every((method) => clientRequests.includes(method))
    && [
      '"method": "item/commandExecution/requestApproval"',
      '"method": "item/fileChange/requestApproval"',
      '"method": "mcpServer/elicitation/request"',
    ].every((method) => serverRequests.includes(method))
    && notifications.includes('"method": "serverRequest/resolved"');
}

async function probeNoTurn(
  command: string,
  env: Record<string, string>,
): Promise<AppServerEvidence> {
  const schemaDirectory = await mkdtemp(join(tmpdir(), 'switchboard-codex-app-schema-'));
  let client: AppServerClient | undefined;
  try {
    await generateSchema(command, env, schemaDirectory);
    const schemaGenerated = await schemaHasStableSurface(schemaDirectory);
    client = new AppServerClient(command, ['app-server', '--listen', 'stdio://'], env);
    const initialized = object(await client.request('initialize', {
      clientInfo: { name: 'switchboard_probe', title: 'Switchboard probe', version: '0.1.0' },
      capabilities: null,
    }));
    client.notify('initialized');
    const account = object(await client.request('account/read', { refreshToken: false }));
    const authStateReadable = account !== null
      && 'account' in account
      && typeof account.requiresOpenaiAuth === 'boolean';
    const cleanShutdown = await client.shutdown();
    return {
      version: parseVersion(initialized?.userAgent),
      schemaGenerated,
      initialized: initialized !== null,
      authStateReadable,
      lifecycleRoundTrip: false,
      followUpRoundTrip: false,
      resumeRoundTrip: false,
      cancellationRoundTrip: false,
      commandApprovalRoundTrip: false,
      fileApprovalRoundTrip: false,
      mcpElicitationObserved: false,
      processCrashHandled: false,
      vendorThreadMigration: 'not-proven',
      cleanShutdown,
    };
  } finally {
    if (client) await client.dispose();
    await rm(schemaDirectory, { recursive: true, force: true });
  }
}

export async function probeAppServer(options: {
  command: string;
  env: Record<string, string>;
  fixtureMode: boolean;
}): Promise<AppServerEvidence> {
  return options.fixtureMode
    ? probeFixture(options.command, options.env)
    : probeNoTurn(options.command, options.env);
}

type Account = {
  provider?: unknown;
  bin?: unknown;
  env?: unknown;
};

async function evaluate(): Promise<void> {
  let accounts: Account[];
  try {
    const parsed = JSON.parse(await readFile(new URL('../accounts.json', import.meta.url), 'utf8')) as unknown;
    accounts = Array.isArray(parsed) ? parsed as Account[] : [];
  } catch {
    throw new Error('No Codex account configured.');
  }
  const account = accounts.find((candidate) => candidate.provider === 'codex');
  if (!account) throw new Error('No Codex account configured.');
  const runtime = await prepareCodexRuntime({
    ...(typeof account.bin === 'string' ? { bin: account.bin } : {}),
    env: object(account.env) as Record<string, string>,
  });
  const evidence = await probeAppServer({
    command: runtime.commandPath,
    env: runtime.env,
    fixtureMode: false,
  });
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await evaluate();
  } catch (error) {
    console.error(error instanceof Error && error.message === 'No Codex account configured.'
      ? error.message
      : 'Codex app-server evaluation failed.');
    process.exitCode = 1;
  }
}
