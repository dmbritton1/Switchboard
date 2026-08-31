import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, type Account } from '../src/accounts.ts';
import { CodexProviderPool } from '../src/agents/codex-provider.ts';
import type { AdapterEvent } from '../src/types.ts';

export type CodexAppServerTransportSmokeEvidence = {
  version: '0.145.0';
  initialized: boolean;
  telemetryContinuity: boolean;
  newThread: boolean;
  firstTurn: boolean;
  followUp: boolean;
  cleanProcessRestart: boolean;
  resume: boolean;
  interrupt: boolean;
  multiSessionRouting: boolean;
  noReplay: boolean;
  cleanShutdown: boolean;
  fixtureIds: string[];
};

export type CodexAppServerTransportSmokeOptions = {
  mode: 'fake' | 'real';
  account?: Account;
  accountName?: string;
  accounts?: Account[];
  accountsPath?: string;
  env?: Record<string, string | undefined>;
  createPool?: () => CodexProviderPool;
  createWorktree?: () => Promise<string>;
};

const PAID_GUARD = 'SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1';
type EventLog = AdapterEvent[];

function fail(message: string): Error {
  return new Error(message);
}

async function accountFor(options: CodexAppServerTransportSmokeOptions): Promise<Account> {
  if (options.mode === 'fake') {
    if (!options.account || options.account.provider !== 'codex') throw fail('Fake Codex transport smoke requires a Codex fixture account.');
    return options.account;
  }
  if (options.env?.SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE !== '1') {
    throw fail(`Refusing to consume Codex turns. Set ${PAID_GUARD} before running the real smoke.`);
  }
  if (!options.accountName) throw fail('Real Codex transport smoke requires --account for a configured Codex account.');
  const accounts = options.accounts ?? await loadAccounts(options.accountsPath ?? join(process.cwd(), 'accounts.json'));
  const account = accounts.find((entry) => entry.name === options.accountName && entry.provider === 'codex');
  if (!account) throw fail('Real Codex transport smoke requires a configured Codex account.');
  return account;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw fail(`Codex transport smoke did not observe ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function message(text: string) {
  return { text, attachments: [] };
}

function hasDelivery(events: EventLog, id: string, delivery: 'sent' | 'unsent'): boolean {
  return events.some((event) => event.type === 'prompt-delivery' && event.id === id && event.delivery === delivery);
}

function countDone(events: EventLog): number {
  return events.filter((event) => event.type === 'status' && event.status === 'done').length;
}

function stopped(events: EventLog, code: string): boolean {
  return events.some((event) => event.type === 'stopped' && event.code === code);
}

function vendorThread(events: EventLog): string | null {
  const event = events.find((entry) => entry.type === 'vendor-session-id');
  return event?.type === 'vendor-session-id' ? event.id : null;
}

function textSeen(events: EventLog, text: string): boolean {
  return events.some((event) => event.type === 'msg' && event.msg.kind === 'text' && event.msg.text === text);
}

async function fakeSmoke(account: Account, createPool: () => CodexProviderPool, root: string): Promise<CodexAppServerTransportSmokeEvidence> {
  const pool = createPool();
  let restarted: CodexProviderPool | null = null;
  try {
    const snapshots: unknown[] = [];
    const supervisor = await pool.limits(account, { onSnapshot: (snapshot) => snapshots.push(snapshot), onStale: () => {} });
    await supervisor.start();
    const preparedA = await pool.prepare(account, 'app-server', 'fixture-a');
    const preparedB = await pool.prepare(account, 'app-server', 'fixture-b');
    const eventsA: EventLog = [];
    const eventsB: EventLog = [];
    const handleA = preparedA.adapter.start({ cwd: join(root, 'a'), prompt: message('session-a-first'), promptId: 'first-a', env: account.env }, (event) => { eventsA.push(event); });
    preparedB.adapter.start({ cwd: join(root, 'b'), prompt: message('session-b-first'), promptId: 'first-b', env: account.env }, (event) => { eventsB.push(event); });
    await waitFor(() => countDone(eventsA) === 1 && countDone(eventsB) === 1, 'first turns');
    handleA.send(message('session-a-follow'), 'follow-a');
    await waitFor(() => countDone(eventsA) === 2, 'follow-up turn');

    const crashing = await pool.prepare(account, 'app-server', 'fixture-crash');
    const crashEvents: EventLog = [];
    crashing.adapter.start({ cwd: join(root, 'c'), prompt: message('crash-session-c'), promptId: 'crash-c', env: account.env }, (event) => { crashEvents.push(event); }).send(message('session-c-queued'), 'queued-c');
    await waitFor(() => stopped(crashEvents, 'codex_transport_crashed'), 'crash handling');
    const noReplay = hasDelivery(crashEvents, 'crash-c', 'sent') && hasDelivery(crashEvents, 'queued-c', 'unsent');

    const originalThread = vendorThread(eventsA);
    if (!originalThread) throw fail('Codex transport smoke did not receive a fixture thread id.');
    await pool.close();
    restarted = createPool();
    const resumed = await restarted.prepare(account, 'app-server', 'fixture-resume');
    const resumedEvents: EventLog = [];
    const resumedHandle = resumed.adapter.start({
      cwd: join(root, 'resume'), prompt: message('session-a-resume'), promptId: 'resume-a', env: account.env, resumeId: originalThread,
    }, (event) => { resumedEvents.push(event); });
    await waitFor(() => countDone(resumedEvents) === 1, 'resumed turn');
    resumedHandle.send(message('hold-session-a-interrupt'), 'interrupt-a');
    await waitFor(() => hasDelivery(resumedEvents, 'interrupt-a', 'sent'), 'interruptible turn');
    resumedHandle.stop();
    await waitFor(() => stopped(resumedEvents, 'codex_user_stopped'), 'interrupt');
    await restarted.close();

    return {
      version: '0.145.0', initialized: snapshots.length > 0, telemetryContinuity: snapshots.length > 1,
      newThread: vendorThread(eventsA) !== null && vendorThread(eventsB) !== null,
      firstTurn: hasDelivery(eventsA, 'first-a', 'sent') && hasDelivery(eventsB, 'first-b', 'sent'),
      followUp: hasDelivery(eventsA, 'follow-a', 'sent'), cleanProcessRestart: true,
      resume: hasDelivery(resumedEvents, 'resume-a', 'sent'), interrupt: stopped(resumedEvents, 'codex_user_stopped'),
      multiSessionRouting: textSeen(eventsA, 'reply:session-a') && textSeen(eventsB, 'reply:session-b') && !textSeen(eventsA, 'reply:session-b'),
      noReplay, cleanShutdown: true, fixtureIds: ['fixture-a', 'fixture-b', 'fixture-resume'],
    };
  } finally {
    await Promise.allSettled([pool.close(), ...(restarted ? [restarted.close()] : [])]);
  }
}

async function realSmoke(account: Account, createPool: () => CodexProviderPool, root: string): Promise<CodexAppServerTransportSmokeEvidence> {
  const pool = createPool();
  let restarted: CodexProviderPool | null = null;
  try {
    const snapshots: unknown[] = [];
    const supervisor = await pool.limits(account, { onSnapshot: (snapshot) => snapshots.push(snapshot), onStale: () => {} });
    await supervisor.start();
    const first = await pool.prepare(account, 'app-server', 'fixture-a');
    const events: EventLog = [];
    const handle = first.adapter.start({ cwd: root, prompt: message('Reply only READY. Do not use files or tools.'), promptId: 'first-a', env: account.env }, (event) => { events.push(event); });
    await waitFor(() => countDone(events) === 1, 'first turn');
    handle.send(message('Reply only READY. Do not use files or tools.'), 'follow-a');
    await waitFor(() => countDone(events) === 2, 'follow-up turn');
    const thread = vendorThread(events);
    if (!thread) throw fail('Codex transport smoke did not receive a thread id.');
    await pool.close();
    restarted = createPool();
    const resumed = await restarted.prepare(account, 'app-server', 'fixture-resume');
    const resumedEvents: EventLog = [];
    resumed.adapter.start({ cwd: root, prompt: message('Reply only READY. Do not use files or tools.'), promptId: 'resume-a', env: account.env, resumeId: thread }, (event) => { resumedEvents.push(event); });
    await waitFor(() => countDone(resumedEvents) === 1, 'resumed turn');
    const interruptible = await restarted.prepare(account, 'app-server', 'fixture-interrupt');
    const interruptEvents: EventLog = [];
    const interruptHandle = interruptible.adapter.start({
      cwd: root,
      prompt: message('Write a long neutral essay. Do not use files or tools.'),
      promptId: 'interrupt-a', env: account.env,
    }, (event) => { interruptEvents.push(event); });
    interruptHandle.send(message('Reply only READY. Do not use files or tools.'), 'queued-a');
    await waitFor(() => hasDelivery(interruptEvents, 'interrupt-a', 'sent'), 'interruptible turn');
    interruptHandle.stop();
    await waitFor(() => stopped(interruptEvents, 'codex_user_stopped'), 'interrupt');
    await restarted.close();
    return {
      version: '0.145.0', initialized: snapshots.length > 0, telemetryContinuity: snapshots.length > 1,
      newThread: vendorThread(events) !== null, firstTurn: hasDelivery(events, 'first-a', 'sent'), followUp: hasDelivery(events, 'follow-a', 'sent'),
      cleanProcessRestart: true, resume: hasDelivery(resumedEvents, 'resume-a', 'sent'), interrupt: stopped(interruptEvents, 'codex_user_stopped'),
      multiSessionRouting: false,
      noReplay: hasDelivery(interruptEvents, 'interrupt-a', 'sent') && hasDelivery(interruptEvents, 'queued-a', 'unsent'),
      cleanShutdown: true, fixtureIds: ['fixture-a', 'fixture-resume'],
    };
  } finally {
    await Promise.allSettled([pool.close(), ...(restarted ? [restarted.close()] : [])]);
  }
}

export async function runCodexAppServerTransportSmoke(options: CodexAppServerTransportSmokeOptions): Promise<CodexAppServerTransportSmokeEvidence> {
  const account = await accountFor(options);
  const root = await (options.createWorktree ?? (() => mkdtemp(join(tmpdir(), 'switchboard-codex-transport-smoke-'))))();
  try {
    await Promise.all(['a', 'b', 'c', 'resume'].map((name) => mkdir(join(root, name))));
    const createPool = options.createPool ?? (() => new CodexProviderPool());
    return options.mode === 'fake'
      ? await fakeSmoke(account, createPool, root)
      : await realSmoke(account, createPool, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function accountName(argv: string[]): string | undefined {
  const index = argv.indexOf('--account');
  return index === -1 ? undefined : argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCodexAppServerTransportSmoke({ mode: 'real', accountName: accountName(process.argv.slice(2)), env: process.env })
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`))
    .catch(() => {
      process.stderr.write('Codex app-server transport smoke did not run.\n');
      process.exitCode = 1;
    });
}
