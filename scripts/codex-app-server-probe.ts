import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/agents/codex-app-server-client.ts';
import { DENIED_SERVER_METHODS } from '../src/agents/codex-app-server-contract.ts';
import { prepareCodexRuntime, redactValues } from '../src/agents/codex-runtime.ts';

const REQUEST_TIMEOUT_MS = 5_000;
const SCHEMA_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 250;
const SIGKILL_WAIT_MS = 1_000;
const DENIED_SERVER_METHOD_SET = new Set<string>(DENIED_SERVER_METHODS);

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

class ProbeObserver {
  readonly #notifications: Array<{ method: string; params: unknown }> = [];
  readonly #waiters = new Set<NotificationWaiter>();
  readonly #serverMethods = new Map<string, string>();
  readonly #resolvedServerRequests = new Set<string>();
  #terminalError: Error | null = null;

  onNotification(method: string, params: unknown): void {
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

  onServerRequest(id: string | number, method: string): void {
    this.#serverMethods.set(idKey(id), method);
  }

  onExit(error: Error): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
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
          reject(new Error(`Codex app-server notification ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
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
}

function createProbeClient(
  command: string,
  args: string[],
  env: Record<string, string>,
  observer: ProbeObserver,
): AppServerClient {
  let client: AppServerClient;
  client = new AppServerClient({
    command,
    args,
    env,
    redact: (text) => redactValues(text, Object.values(env)),
    onNotification: (method, params) => observer.onNotification(method, params),
    onServerRequest: (id, method) => {
      observer.onServerRequest(id, method);
      const message = DENIED_SERVER_METHOD_SET.has(method)
        ? 'Unsupported by the Phase 1 probe.'
        : 'Unsupported server request.';
      client.respondError(id, -32601, message);
    },
    onExit: (error) => observer.onExit(error),
  });
  return client;
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
  const observer = new ProbeObserver();
  const client = createProbeClient(command, [], {
    ...env,
    FAKE_APP_SERVER_MODE: 'crash',
    PROBE_TOKEN: secret,
  }, observer);
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
    await client.close();
  }
}

async function probeFixture(
  command: string,
  env: Record<string, string>,
): Promise<AppServerEvidence> {
  const observer = new ProbeObserver();
  const client = createProbeClient(command, [], env, observer);
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
      input: [{ type: 'text', text: 'fixture lifecycle', text_elements: [] }],
    }));
    const firstTurnId = typeof first?.id === 'string' ? first.id : null;
    if (!firstTurnId) throw new Error('Codex app-server returned no fixture turn id.');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await observer.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, firstTurnId, 'completed'),
    );

    const followUp = turnFrom(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fixture follow-up', text_elements: [] }],
    }));
    const followUpId = typeof followUp?.id === 'string' ? followUp.id : null;
    if (!followUpId) throw new Error('Codex app-server returned no follow-up turn id.');
    await observer.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, followUpId, 'completed'),
    );

    const resumedThreadId = threadIdFrom(await client.request('thread/resume', { threadId }));

    const cancellable = turnFrom(await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'fixture interrupt', text_elements: [] }],
    }));
    const cancellableId = typeof cancellable?.id === 'string' ? cancellable.id : null;
    if (!cancellableId) throw new Error('Codex app-server returned no cancellable turn id.');
    await client.request('turn/interrupt', { threadId, turnId: cancellableId });
    await observer.waitFor(
      'turn/completed',
      (params) => completedTurn(params, threadId, cancellableId, 'interrupted'),
    );

    const lifecycleRoundTrip = first.status === 'inProgress'
      && observer.sawNotification('item/started', (params) => itemForTurn(params, firstTurnId))
      && observer.sawNotification('item/completed', (params) => itemForTurn(params, firstTurnId));
    const followUpRoundTrip = followUp.status === 'inProgress';
    const cancellationRoundTrip = cancellable.status === 'inProgress';
    await client.close();
    const cleanShutdown = true;
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
      commandApprovalRoundTrip: observer.serverRequestRoundTrip('item/commandExecution/requestApproval'),
      fileApprovalRoundTrip: observer.serverRequestRoundTrip('item/fileChange/requestApproval'),
      mcpElicitationObserved: observer.serverRequestRoundTrip('mcpServer/elicitation/request'),
      processCrashHandled,
      vendorThreadMigration: 'not-proven',
      cleanShutdown,
    };
  } finally {
    await client.close();
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
    && DENIED_SERVER_METHODS.every((method) => serverRequests.includes(`"method": "${method}"`))
    && [
      '"method": "thread/started"',
      '"method": "turn/started"',
      '"method": "item/started"',
      '"method": "item/completed"',
      '"method": "turn/completed"',
      '"method": "serverRequest/resolved"',
    ].every((method) => notifications.includes(method));
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
    client = createProbeClient(command, ['app-server', '--listen', 'stdio://'], env, new ProbeObserver());
    const initialized = object(await client.request('initialize', {
      clientInfo: { name: 'switchboard_probe', title: 'Switchboard probe', version: '0.1.0' },
      capabilities: null,
    }));
    client.notify('initialized');
    const account = object(await client.request('account/read', { refreshToken: false }));
    const authStateReadable = account !== null
      && 'account' in account
      && typeof account.requiresOpenaiAuth === 'boolean';
    await client.close();
    const cleanShutdown = true;
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
    if (client) await client.close();
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
