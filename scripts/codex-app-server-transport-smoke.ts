import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadAccounts, type Account } from '../src/accounts.ts';
import { CodexProviderPool } from '../src/agents/codex-provider.ts';
import type { CodexAppServerSupervisor } from '../src/agents/codex-app-server-supervisor.ts';
import type { AdapterEvent } from '../src/types.ts';
import { createWorktree } from '../src/worktree.ts';

export type CodexAppServerTransportSmokeEvidence = {
  version: '0.153.4';
  initialized: boolean;
  telemetryContinuity: boolean;
  newThread: boolean;
  firstTurn: boolean;
  followUp: boolean;
  cleanProcessRestart: boolean;
  resume: boolean;
  interrupt: boolean;
  multiSessionRouting?: boolean;
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
  createWorkspace?: (mode: 'fake' | 'real') => Promise<CodexTransportSmokeWorkspace>;
  onTelemetryEvent?: (event: TelemetryEvent) => void;
  onWorkspaceReady?: (repository: string, worktrees: string[]) => Promise<void>;
};

const PAID_GUARD = 'SWITCHBOARD_ALLOW_PAID_CODEX_SMOKE=1';
const FAKE_OBSERVATION_DEADLINE_MS = 8_000;
const LIVE_OBSERVATION_DEADLINE_MS = 120_000;
type EventLog = AdapterEvent[];
type TelemetryEvent = 'snapshot' | 'stale';
export type CodexTransportSmokeWorkspace = {
  repository: string;
  worktrees: string[];
  cleanup(): Promise<void>;
};
const run = promisify(execFile);

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

export async function waitForSmokeObservation(mode: 'fake' | 'real', predicate: () => boolean, description: string, failed: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + (mode === 'fake' ? FAKE_OBSERVATION_DEADLINE_MS : LIVE_OBSERVATION_DEADLINE_MS);
  while (true) {
    if (failed()) throw fail(`Codex transport smoke failed before ${description}.`);
    if (predicate()) return;
    if (Date.now() >= deadline) throw fail(`Codex transport smoke did not observe ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Observe the real RPC boundary: user-stopped can also mean forced retirement.
function observeInterrupt(supervisor: CodexAppServerSupervisor): () => boolean {
  const request = supervisor.requestForSession.bind(supervisor);
  let acknowledged = false;
  supervisor.requestForSession = async <T>(...args: Parameters<CodexAppServerSupervisor['requestForSession']>): Promise<T> => {
    const response = await request<T>(...args);
    if (args[1] === 'turn/interrupt') acknowledged = true;
    return response;
  };
  return () => acknowledged;
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

function telemetryContinuous(timeline: TelemetryEvent[]): boolean {
  const initialSnapshot = timeline.indexOf('snapshot');
  const stale = timeline.indexOf('stale', initialSnapshot + 1);
  return initialSnapshot >= 0 && stale > initialSnapshot && timeline.indexOf('snapshot', stale + 1) > stale;
}

async function cleanupWorkspace(repository: string, worktrees: string[], root: string): Promise<void> {
  for (const worktree of [...worktrees].reverse()) {
    await run('git', ['worktree', 'remove', '--force', worktree], { cwd: repository })
      .catch(() => rm(worktree, { recursive: true, force: true }));
  }
  await rm(root, { recursive: true, force: true });
}

export async function createSmokeWorkspace(mode: 'fake' | 'real'): Promise<CodexTransportSmokeWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-codex-transport-smoke-'));
  const repository = join(root, 'repository');
  const worktrees: string[] = [];
  try {
    await mkdir(repository, { recursive: true });
    await run('git', ['init', '-b', 'main'], { cwd: repository });
    await writeFile(
      join(repository, 'AGENTS.md'),
      mode === 'fake' ? 'Smoke fixture instructions.\n' : 'Do not use files or tools during this smoke.\n',
    );
    if (mode === 'fake') {
      await mkdir(join(repository, '.codex'));
      await writeFile(join(repository, '.codex', 'config.toml'), 'model = "fixture-model"\n');
    }
    await run('git', ['add', '.'], { cwd: repository });
    await run('git', [
      '-c', 'user.name=Switchboard Smoke',
      '-c', 'user.email=smoke@switchboard.invalid',
      'commit', '-m', 'Initialize smoke fixture',
    ], { cwd: repository });
    const labels = mode === 'fake' ? ['a', 'b', 'crash', 'resume'] : ['real', 'interrupt'];
    for (const label of labels) {
      worktrees.push(await createWorktree(repository, `switchboard-smoke-${label}`));
    }
    return {
      repository,
      worktrees,
      cleanup: () => cleanupWorkspace(repository, worktrees, root),
    };
  } catch (error) {
    await cleanupWorkspace(repository, worktrees, root);
    throw error;
  }
}

async function fakeSmoke(
  account: Account,
  createPool: () => CodexProviderPool,
  worktrees: string[],
  onTelemetryEvent?: (event: TelemetryEvent) => void,
): Promise<CodexAppServerTransportSmokeEvidence> {
  const waitFor = (predicate: () => boolean, description: string) => waitForSmokeObservation('fake', predicate, description);
  const [worktreeA, worktreeB, crashWorktree, resumeWorktree] = worktrees;
  if (!worktreeA || !worktreeB || !crashWorktree || !resumeWorktree) throw fail('Fake Codex transport smoke requires four worktrees.');
  const pool = createPool();
  let restarted: CodexProviderPool | null = null;
  try {
    const telemetry: TelemetryEvent[] = [];
    const recordTelemetry = (event: TelemetryEvent) => {
      telemetry.push(event);
      onTelemetryEvent?.(event);
    };
    const supervisor = await pool.limits(account, {
      onSnapshot: () => recordTelemetry('snapshot'),
      onStale: () => recordTelemetry('stale'),
    });
    await supervisor.start();
    const preparedA = await pool.prepare(account, 'app-server', 'fixture-a');
    const preparedB = await pool.prepare(account, 'app-server', 'fixture-b');
    const eventsA: EventLog = [];
    const eventsB: EventLog = [];
    const handleA = preparedA.adapter.start({ cwd: worktreeA, prompt: message('session-a-first'), promptId: 'first-a', env: account.env }, (event) => { eventsA.push(event); });
    preparedB.adapter.start({ cwd: worktreeB, prompt: message('session-b-first'), promptId: 'first-b', env: account.env }, (event) => { eventsB.push(event); });
    await waitFor(() => countDone(eventsA) === 1 && countDone(eventsB) === 1, 'first turns');
    handleA.send(message('session-a-follow'), 'follow-a');
    await waitFor(() => countDone(eventsA) === 2, 'follow-up turn');

    const crashing = await pool.prepare(account, 'app-server', 'fixture-crash');
    const crashEvents: EventLog = [];
    crashing.adapter.start({ cwd: crashWorktree, prompt: message('crash-session-c'), promptId: 'crash-c', env: account.env }, (event) => { crashEvents.push(event); }).send(message('session-c-queued'), 'queued-c');
    await waitFor(() => stopped(crashEvents, 'codex_transport_crashed'), 'crash handling');
    const noReplay = hasDelivery(crashEvents, 'crash-c', 'sent') && hasDelivery(crashEvents, 'queued-c', 'unsent');

    const originalThread = vendorThread(eventsA);
    if (!originalThread) throw fail('Codex transport smoke did not receive a fixture thread id.');
    await pool.close();
    restarted = createPool();
    const restartedSupervisor = await restarted.limits(account, { onSnapshot() {}, onStale() {} });
    const interruptAcknowledged = observeInterrupt(restartedSupervisor);
    const resumed = await restarted.prepare(account, 'app-server', 'fixture-resume');
    const resumedEvents: EventLog = [];
    const resumedHandle = resumed.adapter.start({
      cwd: resumeWorktree, prompt: message('session-a-resume'), promptId: 'resume-a', env: account.env, resumeId: originalThread,
    }, (event) => { resumedEvents.push(event); });
    await waitFor(() => countDone(resumedEvents) === 1, 'resumed turn');
    resumedHandle.send(message('hold-session-a-interrupt'), 'interrupt-a');
    await waitFor(() => hasDelivery(resumedEvents, 'interrupt-a', 'sent'), 'interruptible turn');
    resumedHandle.stop();
    await waitFor(() => stopped(resumedEvents, 'codex_user_stopped'), 'interrupt');
    if (!interruptAcknowledged()) throw fail('Codex transport smoke did not observe a graceful interrupt.');
    await restarted.close();

    return {
      version: '0.153.4', initialized: telemetry.includes('snapshot'), telemetryContinuity: telemetryContinuous(telemetry),
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

async function realSmoke(
  account: Account,
  createPool: () => CodexProviderPool,
  worktrees: string[],
  onTelemetryEvent?: (event: TelemetryEvent) => void,
): Promise<CodexAppServerTransportSmokeEvidence> {
  const [worktree, interruptWorktree] = worktrees;
  if (!worktree || !interruptWorktree) throw fail('Real Codex transport smoke requires two worktrees.');
  const logs: EventLog[] = [];
  const waitFor = (predicate: () => boolean, description: string) => waitForSmokeObservation('real', predicate, description,
    () => logs.some((events) => events.some((event) => event.type === 'stopped' && event.code !== 'codex_user_stopped')));
  const pool = createPool();
  let restarted: CodexProviderPool | null = null;
  try {
    const telemetry: TelemetryEvent[] = [];
    const recordTelemetry = (event: TelemetryEvent) => {
      telemetry.push(event);
      onTelemetryEvent?.(event);
    };
    const supervisor = await pool.limits(account, {
      onSnapshot: () => recordTelemetry('snapshot'),
      onStale: () => recordTelemetry('stale'),
    });
    await supervisor.start();
    const first = await pool.prepare(account, 'app-server', 'fixture-a');
    const events: EventLog = [];
    logs.push(events);
    const handle = first.adapter.start({ cwd: worktree, prompt: message('Reply only READY. Do not use files or tools.'), promptId: 'first-a', env: account.env }, (event) => { events.push(event); });
    await waitFor(() => countDone(events) === 1, 'first turn');
    handle.send(message('Reply only READY. Do not use files or tools.'), 'follow-a');
    await waitFor(() => countDone(events) === 2, 'follow-up turn');
    const thread = vendorThread(events);
    if (!thread) throw fail('Codex transport smoke did not receive a thread id.');
    await pool.close();
    restarted = createPool();
    const restartedSupervisor = await restarted.limits(account, { onSnapshot() {}, onStale() {} });
    const interruptAcknowledged = observeInterrupt(restartedSupervisor);
    const resumed = await restarted.prepare(account, 'app-server', 'fixture-resume');
    const resumedEvents: EventLog = [];
    logs.push(resumedEvents);
    const resumedHandle = resumed.adapter.start({ cwd: worktree, prompt: message('Reply only READY. Do not use files or tools.'), promptId: 'resume-a', env: account.env, resumeId: thread }, (event) => { resumedEvents.push(event); });
    await waitFor(() => countDone(resumedEvents) === 1, 'resumed turn');
    const interruptible = await restarted.prepare(account, 'app-server', 'fixture-interrupt');
    const interruptEvents: EventLog = [];
    logs.push(interruptEvents);
    const interruptHandle = interruptible.adapter.start({
      cwd: interruptWorktree,
      prompt: message('Write a long neutral essay. Do not use files or tools.'),
      promptId: 'interrupt-a', env: account.env,
    }, (event) => { interruptEvents.push(event); });
    interruptHandle.send(message('Reply only READY. Do not use files or tools.'), 'queued-a');
    await waitFor(() => hasDelivery(interruptEvents, 'interrupt-a', 'sent'), 'interruptible turn');
    interruptHandle.stop();
    await waitFor(() => stopped(interruptEvents, 'codex_user_stopped'), 'interrupt');
    if (!interruptAcknowledged()) throw fail('Codex transport smoke did not observe a graceful interrupt.');
    resumedHandle.send(message('Reply only READY. Do not use files or tools.'), 'after-interrupt');
    await waitFor(() => countDone(resumedEvents) === 2, 'sibling continuity after interrupt');
    await restarted.close();
    return {
      version: '0.153.4', initialized: telemetry.includes('snapshot'), telemetryContinuity: telemetryContinuous(telemetry),
      newThread: vendorThread(events) !== null, firstTurn: hasDelivery(events, 'first-a', 'sent'), followUp: hasDelivery(events, 'follow-a', 'sent'),
      cleanProcessRestart: true, resume: hasDelivery(resumedEvents, 'resume-a', 'sent'), interrupt: stopped(interruptEvents, 'codex_user_stopped'),
      noReplay: hasDelivery(interruptEvents, 'interrupt-a', 'sent') && hasDelivery(interruptEvents, 'queued-a', 'unsent'),
      cleanShutdown: true, fixtureIds: ['fixture-a', 'fixture-resume'],
    };
  } finally {
    await Promise.allSettled([pool.close(), ...(restarted ? [restarted.close()] : [])]);
  }
}

export async function runCodexAppServerTransportSmoke(options: CodexAppServerTransportSmokeOptions): Promise<CodexAppServerTransportSmokeEvidence> {
  const account = await accountFor(options);
  const workspace = await (options.createWorkspace ?? createSmokeWorkspace)(options.mode);
  try {
    await options.onWorkspaceReady?.(workspace.repository, [...workspace.worktrees]);
    const createPool = options.createPool ?? (() => new CodexProviderPool());
    return options.mode === 'fake'
      ? await fakeSmoke(account, createPool, workspace.worktrees, options.onTelemetryEvent)
      : await realSmoke(account, createPool, workspace.worktrees, options.onTelemetryEvent);
  } finally {
    await workspace.cleanup();
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
