import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdir, readFile, readdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, extname, basename, resolve, dirname } from 'node:path';
import { Registry } from './sessions.ts';
import { Usage } from './usage.ts';
import { createAccountLimitCoordinator, type AccountLimitCoordinator } from './account-limits.ts';
import { Scheduler } from './schedule.ts';
import { changedPaths, commitGraph, createWorktree, worktreeDiff, worktreeStatus } from './worktree.ts';
import { commitOutstanding, currentBranch, mergeWorktrees, pushRepo } from './merge.ts';
import { dropPaths, MAX_LISTED_PATHS, overlaps, refreshPaths, type PathCache } from './overlap.ts';
import { HANDOFF_FILE, HANDOFF_PROMPT, renderHandoff } from './handoff.ts';
import { claudeAdapter, probeLimits } from './agents/claude.ts';
import { createCodexAdapter } from './agents/codex.ts';
import { CodexProviderPool, type CodexTransport } from './agents/codex-provider.ts';
import { validateCodexSettings } from './agents/codex-settings.ts';
import { safeCodexDetail } from './agents/codex-detail.ts';
import { resolveAgentPrompt } from './prompt-input.ts';
import {
  channelKey, channelOpen, dropChannels, dropSeen, relay, RELAY_CHECKPOINT, type Channels,
} from './relay.ts';
import { UploadChangedError, writeContainedUpload } from './upload.ts';
import {
  CodexRuntimeError, prepareCodexRuntime, redactCodexText, redactValues,
} from './agents/codex-runtime.ts';
import {
  createAccountStore, loadAccounts, ACCOUNT_NAME_RE, type Account, type AccountStore,
} from './accounts.ts';
import { Linker, CREDENTIAL_ENV, type PublicLink } from './link.ts';
import type {
  AccountLimitSnapshot, Action, Adapter, AdapterEvent, AgentHandle, AgentPrompt, CodexFailureCode,
  CodexThreadSettings, NotifyOn, Session, Settings, SortMode, Trigger,
} from './types.ts';

export type { Account } from './accounts.ts';

const run = promisify(execFile);

type LimitIntervalHandle = unknown;

export type AccountLimitLifecycleDeps = {
  intervalMs?: number;
  setInterval?: (callback: () => void, delay: number) => LimitIntervalHandle;
  clearInterval?: (handle: LimitIntervalHandle) => void;
};

function defaultLimitInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
  return setInterval(callback, delay).unref();
}

function defaultClearLimitInterval(handle: LimitIntervalHandle): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

/**
 * Attaches account telemetry only after the HTTP server is listening. The
 * coordinator owns subscriptions and cadence; the application owns the shared provider pool.
 */
export function attachAccountLimitLifecycle(
  server: Server,
  coordinator: AccountLimitCoordinator,
  deps: AccountLimitLifecycleDeps = {},
): void {
  const intervalMs = deps.intervalMs ?? 5 * 60_000;
  const setLimitInterval = deps.setInterval ?? defaultLimitInterval;
  const clearLimitInterval = deps.clearInterval ?? defaultClearLimitInterval;
  let timer: LimitIntervalHandle | null = null;
  let active = false;
  let began = false;
  let closed = false;

  const run = async (initial: boolean): Promise<void> => {
    if (closed || active) return;
    active = true;
    try {
      if (initial) await coordinator.start();
      else await coordinator.reconcile();
    } catch {
      // Account failures are displayed through Usage; HTTP startup remains live.
    } finally {
      active = false;
    }
  };

  const begin = () => {
    if (began || closed) return;
    began = true;
    queueMicrotask(() => {
      if (closed) return;
      void run(true);
      timer = setLimitInterval(() => { void run(false); }, intervalMs);
    });
  };

  if (server.listening) begin();
  else server.once('listening', begin);
  server.once('close', () => {
    closed = true;
    if (timer !== null) {
      clearLimitInterval(timer);
      timer = null;
    }
    void coordinator.close().catch(() => {});
  });
}

type PreparedProvider = {
  adapter: Adapter;
  runtimeVersion?: string;
};

type SessionPreparation = { sessionId: string; transport?: CodexTransport };
type SessionOwnership = Pick<Session, 'id' | 'provider' | 'codexTransport'>;
type ServerCodexPool = Pick<CodexProviderPool, 'close'> & Partial<Pick<CodexProviderPool, 'prepare' | 'retire' | 'capabilities'>>;

async function prepareProvider(account: Account, _session?: SessionPreparation): Promise<PreparedProvider> {
  if (account.provider === 'claude') return { adapter: claudeAdapter };
  const runtime = await prepareCodexRuntime({ bin: account.bin, env: account.env });
  return { adapter: createCodexAdapter(runtime), runtimeVersion: runtime.version };
}

/** Does this account have a live agent? `needs-you` counts: it is not
 *  computing, but it is a running child process parked on an approval prompt,
 *  so unlinking under it strands a real process rather than a record. */
export function accountBusy(registry: Registry, name: string): boolean {
  return registry.all().some(
    (s) => s.account === name && (s.status === 'working' || s.status === 'needs-you'),
  );
}

/**
 * Best-effort provider logout before a credential dir is deleted, so the
 * refresh token is revoked rather than orphaned. Callers must swallow any
 * rejection: the account may already be logged out, or offline, and neither
 * should block removing the account.
 *
 * Resolves the claude binary through `claudeBin` (Linker's own seam — tests
 * point it at a fake CLI, exactly like the link flow) rather than a bare
 * `'claude'` literal, so this never spawns a real binary under test. Codex
 * resolves through the same `prepareCodexRuntime` path the rest of the app
 * uses, with `requireAuth: false`: the account may already be logged out,
 * which would otherwise fail the preflight this runs before the logout call.
 */
async function revokeLogin(account: Account, claudeBin: string): Promise<void> {
  const env = { ...process.env, ...account.env } as NodeJS.ProcessEnv;
  if (account.provider === 'claude') {
    await run(claudeBin, ['auth', 'logout'], { env, timeout: 10_000 });
    return;
  }
  const runtime = await prepareCodexRuntime(
    { bin: account.bin, env: account.env },
    { requireAuth: false },
  );
  await run(runtime.commandPath, ['logout'], { env, timeout: 10_000 });
}

/**
 * Account values are launch-only configuration, so any of them — not just the
 * credential-shaped keys redactCodexText() singles out — is removed from text
 * the browser will see. Short values are left alone: see MIN_REDACTABLE, a
 * substring search for "1" redacts arithmetic, not a secret. One pass over
 * every value, not a credential pass then a general one: two passes reorder the
 * values between them and can strand the tail of an overlapping value.
 */
function redactAccountValue(text: string, account: Account): string {
  return redactValues(text, Object.values(account.env));
}

function sanitizeCodexEvent(event: AdapterEvent, account: Account): AdapterEvent {
  if (account.provider !== 'codex') return event;
  switch (event.type) {
    case 'msg': {
      const msg = event.msg;
      if (msg.kind === 'tool') {
        return {
          ...event,
          msg: { ...msg, name: redactAccountValue(msg.name, account), summary: redactAccountValue(msg.summary, account) },
        };
      }
      return { ...event, msg: { ...msg, text: redactAccountValue(msg.text, account) } };
    }
    case 'stopped':
      return { ...event, reason: redactAccountValue(event.reason, account) };
    case 'upsert-msg': {
      const msg = event.msg;
      if (msg.kind === 'reasoning') {
        return { ...event, msg: { ...msg, text: redactAccountValue(msg.text, account) } };
      }
      if (msg.kind === 'todo') {
        return { ...event, msg: { ...msg, items: msg.items.map((item) => ({
          ...item, text: redactAccountValue(item.text, account),
        })) } };
      }
      const redactedDetail = msg.detail === undefined
        ? null
        : safeCodexDetail(redactAccountValue(msg.detail, account), {});
      return {
        ...event,
        msg: {
          ...msg,
          name: redactAccountValue(msg.name, account),
          summary: redactAccountValue(msg.summary, account),
          ...(redactedDetail ? {
            detail: redactedDetail.text,
            detailTruncated: (msg.detailTruncated ?? false) || redactedDetail.truncated,
          } : {}),
        },
      };
    }
    // vendor-session-id is deliberately not redacted: it is an identifier the
    // server hands straight back to resumeThread(), never rendered as prose. A
    // value that happened to contain an account value would come back rewritten
    // to [REDACTED] and resume the wrong thread — or no thread at all — with
    // nothing on screen to explain it.
    default:
      return event;
  }
}

const WEB = new URL('../web/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * DNS-rebinding guard: the `Origin`-vs-`Host` check below only blocks a plain
 * cross-origin POST, where the two strings differ. In a rebinding attack the
 * victim's browser resolves an attacker-owned hostname to 127.0.0.1, so both
 * `Origin` and `Host` say `attacker-host:<port>` and agree with each other —
 * the same-string check passes while the request is in fact hitting this
 * server. The standard fix for a loopback server is to allowlist `Host`
 * itself: a rebound request can never present a `Host` of `127.0.0.1` or
 * `localhost`, because that string comes from the URL the browser actually
 * navigated to, not from DNS. Missing or unparseable `Host` fails closed.
 */
function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

const MAX_UPLOAD = 25 * 1024 * 1024;

/** How often the scheduler is checked. Coarse on purpose: the UI picker is
 *  minute-resolution, so a finer tick would buy nothing. */
const TICK_MS = 30_000;

/**
 * Origin guard: blocks plain cross-origin POST (Origin disagrees with
 * Host), which the hostOk() check above does not — that check only
 * catches a spoofed Host. Any page open in the user's browser can issue
 * a same-network POST to 127.0.0.1:4711; browsers don't preflight a
 * simple POST like the ones this UI sends, so the request reaches us
 * and its side effects (worktree creation, process launch, directory
 * deletion) run before any CORS check would block the attacker from
 * reading the response — and the attacker doesn't need to read the
 * response to do damage. Non-browser clients (curl, scripts, this
 * file's own tests) typically send no Origin header at all, so we only
 * reject a *mismatched* one — this blocks the drive-by case without
 * breaking local tooling.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

/**
 * Directory names under ~/.claude/projects are meant to decode back to repo
 * paths, but the encoding Claude Code uses is lossy: '/', '-', and ' ' in the
 * original cwd all collapse to '-' in the directory name (confirmed against
 * real project dirs — e.g. a repo at ".../Tshirt dashboard" and one at
 * ".../Tshirt-dashboard" would both encode to "...-Tshirt-dashboard"). A
 * naive `replaceAll('-', '/')` cannot be made reliably correct from the
 * encoded name alone for any repo whose own path contains a hyphen or space
 * — there's no way to tell "this hyphen was a '/'" from "this hyphen was
 * part of the name" after the fact.
 *
 * Rather than show a guessed path that may silently be wrong (and would only
 * surface as a confusing "not a git repository" error later, from a path the
 * user never typed), we only keep guesses that resolve to a real directory.
 * Repos whose name contains punctuation that collided with the encoding are
 * silently omitted from this list rather than shown with a wrong path; the
 * user can still type the path manually.
 */
export async function recentRepos(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(homedir(), '.claude', 'projects'));
  } catch {
    return [];
  }
  const repos = new Set<string>();
  for (const name of names) {
    // Worktree slugs contain the base repo path before the `--` separator.
    const base = name.split('--')[0];
    const guess = base.replace(/^-/, '/').replaceAll('-', '/');
    try {
      const st = await stat(guess);
      if (st.isDirectory()) repos.add(guess);
    } catch {
      // Guess didn't resolve to a real path — drop it rather than guess wrong.
    }
  }
  return [...repos].sort();
}

/** A queued action as the `command()` body that performs it. */
function toCommand(a: Action): Record<string, unknown> {
  if (a.kind === 'create') {
    return {
      cmd: 'create', repo: a.repo, branch: a.branch, account: a.account, prompt: a.prompt,
      ...(a.codexSettings ? { codexSettings: a.codexSettings } : {}),
    };
  }
  if (a.kind === 'send') return { cmd: 'send', id: a.sessionId, text: a.text };
  return { cmd: 'resume', id: a.sessionId, prompt: a.prompt };
}

/**
 * Should a `stopped` session be auto-queued for a resume once its account's
 * window rolls?
 *
 * `agentDied` is the `dead` local from launch()'s emit callback: truthy only
 * when the agent ended on its own, because both the stop and delete commands
 * remove the handle before calling stop(). `resetAt` is Usage's stored reset
 * time; a non-null value in the future is exactly "this account is past its
 * limit right now". `enabled` is the `autoRequeue` setting.
 *
 * ponytail: this will occasionally requeue a session that died of something
 * unrelated during a limit window. Accepted on purpose — the item is visible in
 * the queue strip and one click deletes it, whereas every tighter test means
 * matching on provider error text, which is the brittleness this avoids. The
 * `enabled` flag is the escape hatch for anyone who finds that trade wrong.
 */
export function shouldRequeue(
  agentDied: boolean, resetAt: number | null, now: number, enabled: boolean,
): boolean {
  return enabled && agentDied && resetAt !== null && resetAt > now;
}

const SORTS = ['blocked', 'newest', 'account'] as const;
const NOTIFY = ['needs-you', 'done', 'stopped'] as const;

/**
 * Validates a settings patch before it reaches the Registry.
 *
 * Strict where `coerceSettings` (sessions.ts) is tolerant, and deliberately so:
 * that one reads a file this app wrote, while this reads an unauthenticated
 * localhost POST that now changes how agents launch. An unknown key here is an
 * error rather than a silent drop, so a client sending `sandboxMode` learns it
 * was ignored instead of believing it took effect.
 */
export function parseSettingsPatch(body: unknown): { patch: Partial<Settings> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'patch must be an object' };
  }
  const patch: Partial<Settings> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    switch (key) {
      case 'autoApprove': case 'collapseDone': case 'autoRequeue':
        if (typeof value !== 'boolean') return { error: `${key} must be a boolean` };
        patch[key] = value;
        break;
      case 'branchPrefix':
        if (typeof value !== 'string') return { error: 'branchPrefix must be a string' };
        patch.branchPrefix = value;
        break;
      case 'account':
        // Not checked against the account list: an account can be removed from
        // accounts.json while a stale pin names it, and rejecting the patch
        // would make settings unsavable until the user noticed. The New dialog
        // falls back to freest when the pinned name is not in the list.
        if (value !== null && typeof value !== 'string') {
          return { error: 'account must be a string or null' };
        }
        patch.account = value;
        break;
      case 'sort':
        if (!SORTS.includes(value as SortMode)) {
          return { error: `sort must be one of: ${SORTS.join(', ')}` };
        }
        patch.sort = value as SortMode;
        break;
      case 'notifyOn':
        if (!Array.isArray(value) || value.some((v) => !NOTIFY.includes(v as NotifyOn))) {
          return { error: `notifyOn must contain only: ${NOTIFY.join(', ')}` };
        }
        patch.notifyOn = value as NotifyOn[];
        break;
      default:
        return { error: `unknown setting: ${key}` };
    }
  }
  return { patch };
}

/**
 * One fraction per account, so the meter and the New Session picker cannot
 * disagree. Fresh authoritative provider data wins; local pace is only an
 * estimate fallback when that read is unavailable or stale.
 */
export function accountLoad(usage: Usage, a: Account): number {
  const { snapshot } = usage.getLimitSnapshot(a.name);
  if (!snapshot || !snapshot.authoritative || !snapshot.fresh) return usage.pace(a.name, a.budget);
  if (snapshot.blocks.length > 0) return 1;
  const pct = Math.max(0, ...snapshot.windows.map((window) => window.usedPercent));
  return pct / 100;
}

/**
 * One refresh pass over every Claude account, concurrently.
 *
 * `probe` is a parameter so tests drive this with a fake and never spawn a CLI.
 * Every failure is swallowed into the normalized snapshot error: a probe that throws must leave
 * the account showing exactly the estimate UI it shows today, never block a
 * session, and never take its neighbours down with it — hence allSettled and
 * the per-account try.
 */
export async function refreshLimits(
  usage: Usage,
  accounts: Account[],
  probe: (env: Record<string, string>) => Promise<AccountLimitSnapshot> = probeLimits,
): Promise<void> {
  await Promise.allSettled(
    accounts
      .filter((a) => a.provider === 'claude')
      .map(async (a) => {
        try {
          usage.setLimitSnapshot(a.name, await probe(a.env));
        } catch {
          // Provider errors can include stderr, paths, and account metadata. This
          // value is sent over SSE, so preserve only a stable action for the user.
          usage.failLimitSnapshot(a.name, 'Unable to refresh account limits. Check that this account is signed in.');
        }
      }),
  );
}

export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  scheduler?: Scheduler;
  accounts: Account[];
  /** Provider preflight seam used by the offline server tests. */
  prepare?: (account: Account, session?: SessionPreparation) => Promise<PreparedProvider>;
  resolvePrompt?: typeof resolveAgentPrompt;
  /** Persistence for linked accounts. Absent disables linking entirely, which
   *  is what keeps every pre-existing server test unchanged. */
  accountStore?: AccountStore;
  linker?: Linker;
  // These hooks exist so tests can park a request inside a specific await and
  // drive a real interleaving, rather than racing two fetches and hoping.
  beforeUploadRootPin?: () => Promise<void>;
  beforeUploadWrite?: (target: string) => Promise<void>;
  beforeWorktreeRemoval?: (cwd: string) => Promise<void>;
  /** Entry-point owned telemetry lifecycle. Tests inject a fake, never a child process. */
  limitCoordinator?: AccountLimitCoordinator;
  /** One application-level close owner for the shared per-account Codex pool. */
  codexPool?: ServerCodexPool;
  /** Injectable interval seam for process-free lifecycle tests. */
  limitLifecycle?: AccountLimitLifecycleDeps;
}): Server & { tick: () => Promise<void> } {
  const {
    registry, usage, accounts, scheduler = new Scheduler(), prepare: injectedPrepare,
    resolvePrompt = resolveAgentPrompt, accountStore, linker,
    beforeUploadRootPin, beforeUploadWrite, beforeWorktreeRemoval, limitCoordinator, limitLifecycle,
    codexPool,
  } = opts;
  const prepare = injectedPrepare ?? prepareProvider;
  const handles = new Map<string, AgentHandle>();
  const launchOwners = new Map<string, symbol>();
  const recoveryCandidates = new Map<string, symbol>();
  function cancelRecovery(sessionId: string, removeQueued = true): void {
    recoveryCandidates.delete(sessionId);
    if (!removeQueued) return;
    const session = registry.get(sessionId);
    if (session?.provider !== 'codex' || session.codexTransport !== 'app-server') return;
    for (const item of scheduler.all()) {
      if (item.state === 'waiting' && item.trigger.kind === 'reset'
        && item.action.kind === 'resume' && item.action.sessionId === sessionId) scheduler.remove(item.id);
    }
  }
  const createReservations = new Map<string, symbol>();
  const deletingSessions = new Set<string>();
  // Process-local like the handle map, and for the same reason: a channel names
  // two live sessions, and Registry.load forces every session to `stopped` on
  // start, so none could survive a restart in a usable form.
  const channels: Channels = new Map();
  // Pairs that have talked before, so the card can say which question it is
  // asking. Never cleared on checkpoint, only when a session goes away.
  const seenChannels = new Set<string>();
  // Paths each session has changed, with the time they were collected. Process-
  // local like the channel maps, and for the same reason — this describes live
  // worktrees, and Registry.load forces every session to `stopped` on start.
  const paths: PathCache = new Map();
  // Pairs related by handoff — the successor's branch point is the source's own
  // branch, so they share every committed path and would otherwise land in the
  // silent (unwarned-collision) bucket and cry wolf on a pair that shares
  // history rather than colliding. Process-local, same lifecycle as the other
  // maps: a restart loses it and a handed-off pair can show a false warning
  // again until one side changes something. A `git merge-base --is-ancestor`
  // check would survive a restart and be correct instead of remembered, but it
  // is a git call per pair against an O(n^2) pairing — bookkeeping was chosen
  // over that cost, not missed.
  const lineage = new Set<string>();
  const resumeReservations = new Map<string, symbol>();
  const handoffReservations = new Map<string, { token: symbol; phase: 'preparing' | 'committing' }>();
  type WorktreeMutationKind = 'delete' | 'handoff' | 'merge' | 'upload' | 'stop';
  type WorktreeMutationReservation = { token: symbol; sessionIds: string[]; kind: WorktreeMutationKind };
  const worktreeMutations = new Map<string, { token: symbol; kind: WorktreeMutationKind }>();

  function acquireWorktreeMutation(
    sessionIds: string[], kind: WorktreeMutationKind,
  ): WorktreeMutationReservation | { busy: { sessionId: string; kind: WorktreeMutationKind } } {
    const uniqueIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueIds) {
      const owner = worktreeMutations.get(sessionId);
      if (owner) return { busy: { sessionId, kind: owner.kind } };
    }
    const token = Symbol(kind);
    for (const sessionId of uniqueIds) worktreeMutations.set(sessionId, { token, kind });
    return { token, sessionIds: uniqueIds, kind };
  }

  function releaseWorktreeMutation(reservation: WorktreeMutationReservation): void {
    for (const sessionId of reservation.sessionIds) {
      if (worktreeMutations.get(sessionId)?.token === reservation.token) {
        worktreeMutations.delete(sessionId);
      }
    }
  }

  function worktreeMutationError(kind: WorktreeMutationKind): string {
    return kind === 'delete' ? 'session deletion is in progress' : `session ${kind} is in progress`;
  }

  async function prepareForSession(account: Account, session: SessionOwnership): Promise<PreparedProvider> {
    if (account.provider === 'codex' && codexPool?.prepare) {
      if (session.codexTransport !== 'sdk' && session.codexTransport !== 'app-server') {
        throw new Error('This Codex session has an invalid stored transport. Delete it and create a new session.');
      }
      return codexPool.prepare(account, session.codexTransport, session.id);
    }
    if (account.provider === 'codex' && session.codexTransport === 'app-server' && !injectedPrepare) {
      throw new Error('Codex app-server session transport is unavailable. Check this account configuration and try again.');
    }
    return prepare(account, {
      sessionId: session.id,
      ...(session.provider === 'codex' ? { transport: session.codexTransport } : {}),
    });
  }

  function preparationError(
    session: SessionOwnership,
    account: Account,
    error: unknown,
    phase: 'create' | 'resume',
  ): { status: number; json: { error: string; code: CodexFailureCode } } {
    const code = error instanceof CodexRuntimeError
      ? error.code
      : session.codexTransport === 'app-server'
        ? 'codex_app_server_initialization_failed'
        : phase === 'resume' ? 'codex_resume_failed' : 'codex_start_failed';
    const reason = error instanceof CodexRuntimeError
      ? redactAccountValue(error.message, account)
      : session.codexTransport === 'app-server'
        ? 'Codex app-server session transport is unavailable. Check this account configuration and try again.'
        : 'Codex SDK session transport is unavailable. Check this account configuration and try again.';
    return { status: 400, json: { error: reason, code } };
  }

  function preparationFailure(
    session: Session,
    account: Account,
    error: unknown,
    phase: 'create' | 'resume',
  ): { status: number; json: { error: string; code: CodexFailureCode } } {
    const failure = preparationError(session, account, error, phase);
    registry.recordStoppedFailure(session.id, failure.json.error, failure.json.code);
    return failure;
  }

  /**
   * Slash commands the CLI reported, for the composer's autocomplete.
   *
   * Machine-wide rather than per-session: the same user plugins resolve for
   * every session, so one list is both correct and far cheaper than a copy in
   * each transcript — snapshot() serializes all of this on every agent message.
   *
   * ponytail: learned from whichever session starts first and held in memory, not
   * persisted. A restart forgets it until the next session sends its init, a
   * second or two later. Persist it in state.json if that gap ever annoys.
   */
  let slashCommands: string[] = [];

  function snapshot() {
    return {
      commands: slashCommands,
      sessions: registry.publicSessions(),
      queue: scheduler.all(),
      settings: registry.settings(),
      link: linker?.snapshot() ?? null,
      accounts: accounts.map((a) => {
        const { snapshot: limits, error: limitsError } = usage.getLimitSnapshot(a.name);
        const resetScheduling = a.provider === 'claude'
          ? { eligible: true, resetsAt: usage.resetAt(a.name), reason: '' }
          : (() => {
            const eligibility = limitCoordinator?.codexResetEligibility(a.name);
            return eligibility?.eligible
              ? { eligible: true, resetsAt: eligibility.resetsAt, reason: '' }
              : {
                eligible: false,
                resetsAt: null,
                reason: eligibility?.reason ?? 'no fresh Codex usage window',
              };
          })();
        return {
          name: a.name,
          provider: a.provider,
          budget: a.budget,
          pace: usage.pace(a.name, a.budget),
          limits,
          limitsError,
          load: accountLoad(usage, a),
          resetScheduling,
        };
      }),
    };
  }

  /**
   * Resolves `body.ids` to sessions and enforces the one rule that keeps a
   * merge or push from ever touching more than one base repo at once: every
   * selected worktree must share the same `repo`. This is the authoritative
   * check — the UI disables the buttons for a mixed selection too, but that's
   * a courtesy, not the guard; this is what a `/command` sent from anywhere
   * else (curl, a stale tab, a future client) actually has to pass.
   */
  function selectedRepo(body: Record<string, unknown>): { repo: string; sessions: Session[] } | { error: string } {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) return { error: 'select at least one worktree' };
    const sessions: Session[] = [];
    for (const id of ids) {
      const s = registry.get(id);
      if (!s) return { error: `no such session: ${id}` };
      sessions.push(s);
    }
    const repos = new Set(sessions.map((s) => s.repo));
    if (repos.size > 1) {
      return { error: `selected worktrees belong to different repos, not one folder: ${[...repos].join(', ')}` };
    }
    return { repo: sessions[0].repo, sessions };
  }

  function launch(
    sessionId: string, account: Account, adapter: Adapter, cwd: string, prompt: AgentPrompt, resumeId?: string,
    promptId?: string,
  ): { error: string; code?: CodexFailureCode } | null {
    const session = registry.get(sessionId);
    const auto = session?.auto ?? false;
    const codexSettings = session?.codexSettings;
    const owner = Symbol(sessionId);
    launchOwners.set(sessionId, owner);
    let handle: AgentHandle | null = null;
    // The tool schema and the @ mention both hand the model a branch, not an id
    // — but relay() and the channel map key on id. Resolve here, once, so the
    // gate and the send agree on the same canonical key: an exact id match
    // first (deterministic even if a branch name is ever ambiguous), then a
    // same-repo branch lookup, then the raw target unchanged so relay() can
    // still report unknown-session on genuine nonsense.
    const resolve = (target: string) => registry.all()
      .find((s) => s.id === target || (s.repo === session?.repo && s.branch === target))?.id ?? target;
    try {
      handle = adapter.start({
        cwd, prompt, promptId, env: account.env, resumeId, auto, codexSettings,
        relay: (target, text) => {
          const to = resolve(target);
          const result = relay({ registry, handles, channels }, sessionId, to, redactCodexText(text, account.env));
          if (result.ok) seenChannels.add(channelKey(sessionId, to));
          return result;
        },
        relayGate: (target) => {
          const to = resolve(target);
          if (channelOpen(channels, sessionId, to)) return { ask: false };
          return seenChannels.has(channelKey(sessionId, to))
            ? { ask: true, note: `${RELAY_CHECKPOINT} messages exchanged — continue?` }
            : { ask: true };
        },
        relaySessions: async () => {
          // `session` is read once at launch; without it there is no repo to scope
          // by and currentBranch would run against the server's own cwd.
          if (!session) return [];
          const siblings = registry.all().filter((s) => s.id !== sessionId && s.repo === session.repo);
          // Agents call this rarely, and a tool that reports no overlap because
          // nobody happened to open the card is a tool that quietly lies. Refresh
          // anything stale — refreshPaths skips whatever is already fresh.
          const base = await currentBranch(session.repo).catch(() => '');
          const now = Date.now();
          // In parallel, not a sequential loop: each refreshPaths is three git
          // invocations, so N sessions serialized is N round trips the agent
          // waits through for no benefit. refreshPaths is per-key and never
          // throws, so concurrent calls cannot interfere.
          await Promise.all(
            [...siblings, session].map((s) => refreshPaths(paths, s.id, () => changedPaths(s.cwd, base), now)),
          );
          const shared = new Map(
            overlaps(paths, sessionId, siblings.map((s) => ({ id: s.id, branch: s.branch })))
              .filter((o) => !lineage.has(channelKey(sessionId, o.id)))
              .map((o) => [o.id, o.files]),
          );
          return siblings.map((s) => ({
            id: s.id, branch: s.branch, account: s.account, status: s.status,
            files: shared.get(s.id) ?? [],
          }));
        },
      }, (e) => {
        if (launchOwners.get(sessionId) !== owner) return;
        const safeEvent = sanitizeCodexEvent(e, account);
        if (safeEvent.type === 'usage') {
          // Optional Codex breakdowns are informational subsets, not account pace.
          const { inputTokens, outputTokens } = safeEvent;
          usage.record(account.name, inputTokens, outputTokens);
        }
        // Claude rate events maintain its existing reset heuristic; app-server
        // recovery below uses a structured failure and authoritative read.
        if (safeEvent.type === 'rate-limit') {
          usage.noteLimit(account.name, safeEvent.status, safeEvent.resetsAt);
        }
        // Not a session fact, so it never reaches the registry — but the browser
        // only learns anything through a snapshot, so a change has to push one.
        if (safeEvent.type === 'slash-commands') {
          if (safeEvent.commands.join('\n') !== slashCommands.join('\n')) {
            slashCommands = safeEvent.commands;
            registry.touch();
          }
          return;
        }
        if (safeEvent.type !== 'stopped') { registry.apply(sessionId, safeEvent); return; }
      // A `stopped` session is terminal in the registry, so a handle left in the map
      // is a lie: `send` returned 200, the still-running subprocess burned tokens on
      // the prompt, and every event it produced was dropped by the terminal guard.
      // Drop the handle and shut the agent down for real.
      //
      // Ordering is load-bearing, because the Codex adapter's stop() emits its own
      // `stopped` and so re-enters this callback: delete first, so the re-entrant
      // pass finds no handle and cannot recurse; apply before stop(), so the real
      // reason is recorded and the re-entrant "stopped from switchboard" is the one
      // the terminal guard drops, not the other way round.
        const dead = handle !== null && handles.get(sessionId) === handle ? handle : undefined;
        launchOwners.delete(sessionId);
        if (dead) handles.delete(sessionId);
        registry.apply(sessionId, safeEvent);
        // Before stop(), for the same reason apply() is: stop() re-enters this
        // callback, and by then `dead` is gone and the requeue would be skipped.
        if (account.provider === 'claude' && shouldRequeue(
          Boolean(dead), usage.resetAt(account.name), Date.now(), registry.settings().autoRequeue,
        )) {
          scheduler.add(
            { kind: 'reset', account: account.name },
            { kind: 'resume', sessionId, prompt: 'continue' },
          );
        }
        if (dead && account.provider === 'codex' && session?.codexTransport === 'app-server'
          && safeEvent.code === 'codex_usage_limited' && registry.settings().autoRequeue
          && limitCoordinator && !scheduler.findResetResume(sessionId)) {
          const candidate = Symbol(sessionId);
          recoveryCandidates.set(sessionId,candidate);
          void (async () => {
            try {
              const eligibility = await limitCoordinator.refreshCodexForRecovery(account.name);
              await dead.quiescence;
              if (!eligibility.eligible || eligibility.resetsAt <= Date.now()
                || recoveryCandidates.get(sessionId) !== candidate
                || !registry.settings().autoRequeue || registry.get(sessionId) !== session
                || session.status !== 'stopped' || session.stoppedCode !== 'codex_usage_limited'
                || accounts.find(a=>a.name===account.name) !== account || handles.has(sessionId)
                || launchOwners.has(sessionId) || scheduler.findResetResume(sessionId)) return;
              scheduler.addResetResume(account.name,sessionId);
            } catch { /* A failed refresh leaves the stopped session manually resumable. */ }
            finally { if(recoveryCandidates.get(sessionId)===candidate) recoveryCandidates.delete(sessionId); }
          })();
        }
        dead?.stop();
      });
      if (launchOwners.get(sessionId) === owner) handles.set(sessionId, handle);
      return null;
    } catch (error) {
      if (launchOwners.get(sessionId) === owner) launchOwners.delete(sessionId);
      const reason = account.provider === 'codex'
        ? redactAccountValue(String((error as Error).message ?? error), account)
        : String((error as Error).message ?? error);
      const code = account.provider === 'codex'
        ? (resumeId ? 'codex_resume_failed' : 'codex_start_failed')
        : undefined;
      if (account.provider === 'codex' && promptId) {
        registry.apply(sessionId, { type: 'prompt-delivery', id: promptId, delivery: 'unsent' });
      }
      registry.apply(sessionId, { type: 'stopped', reason, ...(code ? { code } : {}) });
      return { error: reason, ...(code ? { code } : {}) };
    }
  }

  /**
   * Validates a `schedule` body into a (trigger, action) pair.
   *
   * The action is parsed first so a `reset` trigger can take its account from
   * it rather than from the client — the account whose window we wait on is by
   * definition the account the work runs on, and deriving it makes the two
   * impossible to get out of step.
   *
   * Everything here is checked at schedule time so a typo surfaces now rather
   * than at 3am. Fire-time validation is `command()`'s own and is unchanged.
   */
  async function parseSchedule(
    body: Record<string, unknown>,
  ): Promise<{ trigger: Trigger; action: Action } | { error: string }> {
    const t = body.trigger as Record<string, unknown> | undefined;
    const a = body.action as Record<string, unknown> | undefined;
    if (!t || !a) return { error: 'schedule needs a trigger and an action' };

    let action: Action;
    let account: string;

    if (a.kind === 'create') {
      // typeof-guarded, not coerced: String()/Number() turn a wrong-shaped
      // field (an array, an object, null) into a plausible-looking value
      // instead of rejecting it — e.g. String({}) is the non-empty, non-blank
      // string '[object Object]', which would sail past a truthiness check
      // and get scheduled as a real branch name. A bad request must 400 here,
      // not become a queue item that misbehaves later at fire time.
      if (typeof a.account !== 'string') return { error: 'account must be a string' };
      const found = accounts.find((x) => x.name === a.account);
      if (!found) return { error: `unknown account: ${a.account}` };
      if (typeof a.repo !== 'string') return { error: 'repo must be a string' };
      const repo = a.repo;
      if (!(await stat(repo).then((s) => s.isDirectory(), () => false))) {
        return { error: `not a directory: ${repo}` };
      }
      if (typeof a.branch !== 'string') return { error: 'branch must be a string' };
      const branch = a.branch.trim();
      if (!branch) return { error: 'branch is required' };
      if (typeof a.prompt !== 'string') return { error: 'prompt must be a string' };
      const prompt = a.prompt.trim();
      if (!prompt) return { error: 'prompt is required' };
      if (found.provider !== 'codex' && Object.hasOwn(a, 'codexSettings')) {
        return { error: 'Codex settings are only available for Codex sessions.' };
      }
      let codexSettings: CodexThreadSettings | undefined;
      try {
        codexSettings = found.provider === 'codex'
          ? validateCodexSettings(a.codexSettings)
          : undefined;
      } catch (error) {
        return { error: String((error as Error).message ?? error) };
      }
      action = {
        kind: 'create', repo, branch, account: found.name, prompt,
        ...(codexSettings ? { codexSettings } : {}),
      };
      account = found.name;
    } else if (a.kind === 'send' || a.kind === 'resume') {
      if (typeof a.sessionId !== 'string') return { error: 'sessionId must be a string' };
      const sessionId = a.sessionId;
      const session = registry.get(sessionId);
      if (!session) return { error: `no such session: ${sessionId}` };
      const field = a.kind === 'send' ? 'text' : 'prompt';
      const raw = a.kind === 'send' ? a.text : a.prompt;
      if (typeof raw !== 'string') return { error: `${field} must be a string` };
      const text = raw.trim();
      if (!text) return { error: 'message is required' };
      action = a.kind === 'send'
        ? { kind: 'send', sessionId, text }
        : { kind: 'resume', sessionId, prompt: text };
      account = session.account;
    } else {
      return { error: `unknown action: ${String(a.kind)}` };
    }

    if (t.kind === 'at') {
      if (typeof t.time !== 'number' || !Number.isFinite(t.time)) {
        return { error: 'trigger.time must be a timestamp' };
      }
      return { trigger: { kind: 'at', time: t.time }, action };
    }
    if (t.kind === 'reset') {
      const selected = accounts.find((candidate) => candidate.name === account);
      if (selected?.provider === 'codex') {
        const eligibility = limitCoordinator?.codexResetEligibility(account);
        if (!eligibility?.eligible) {
          return {
            error: `Codex reset scheduling is unavailable: ${eligibility?.reason ?? 'no fresh Codex usage window'}`,
          };
        }
      }
      const resetAction = action.kind === 'create' && selected
        ? { ...action, resetProvider: selected.provider }
        : action;
      return { trigger: { kind: 'reset', account }, action: resetAction };
    }
    return { error: `unknown trigger: ${String(t.kind)}` };
  }

  async function command(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    switch (body.cmd) {
      case 'create': {
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
        if (account.provider !== 'codex' && Object.hasOwn(body, 'codexSettings')) {
          return { status: 400, json: { error: 'Codex settings are only available for Codex sessions.' } };
        }
        let codexSettings: CodexThreadSettings | undefined;
        try {
          codexSettings = account.provider === 'codex' ? validateCodexSettings(body.codexSettings) : undefined;
        } catch (error) {
          return { status: 400, json: { error: String((error as Error).message ?? error) } };
        }
        let cwd: string;
        try {
          cwd = await createWorktree(String(body.repo), String(body.branch));
        } catch (err) {
          return { status: 400, json: { error: (err as Error).message } };
        }
        const session = registry.create({
          provider: account.provider,
          account: account.name,
          repo: String(body.repo),
          cwd,
          branch: String(body.branch),
          title: String(body.branch),
          ...(account.provider === 'codex' ? { codexTransport: account.codexTransport ?? 'sdk' } : {}),
          ...(codexSettings ? { codexSettings } : {}),
        });
        const reservation = Symbol(session.id);
        createReservations.set(session.id, reservation);
        const changedDuringPreparation = (): boolean => (
          createReservations.get(session.id) !== reservation
          || registry.get(session.id) !== session
          || session.status === 'stopped'
          || handles.has(session.id)
        );
        try {
          let prepared: PreparedProvider;
          try {
            prepared = await prepareForSession(account, session);
          } catch (error) {
            if (changedDuringPreparation()) {
              return { status: 409, json: { error: 'session changed while create was preparing' } };
            }
            return preparationFailure(session, account, error, 'create');
          }
          // No request can interleave between this final ownership check and the
          // synchronous prompt append + launch below. Stop/delete revoke the
          // reservation before mutating the Registry, so a completed preflight
          // can never resurrect their session or orphan a handle.
          if (changedDuringPreparation()) {
            return { status: 409, json: { error: 'session changed while create was preparing' } };
          }
          if (account.provider === 'codex' && prepared.runtimeVersion) {
            registry.recordCodexRuntimeVersion(session.id, prepared.runtimeVersion);
          }
          const prompt = String(body.prompt);
          const promptId = registry.appendPrompt(
            session.id, prompt, account.provider === 'codex' ? 'queued' : 'sent',
          );
          // Set before launch because launch() reads the flag from the Registry.
          if (registry.settings().autoApprove) registry.setAuto(session.id, true);
          const launchError = launch(
            session.id, account, prepared.adapter, cwd, { text: prompt, attachments: [] }, undefined, promptId,
          );
          if (launchError) return { status: 500, json: launchError };
          return { status: 200, json: { id: session.id } };
        } finally {
          if (createReservations.get(session.id) === reservation) createReservations.delete(session.id);
        }
      }

      case 'handoff': {
        cancelRecovery(String(body.id));
        const source = registry.get(String(body.id));
        if (!source) return { status: 404, json: { error: 'no such session' } };
        if (deletingSessions.has(source.id)) {
          return { status: 409, json: { error: 'session deletion is in progress' } };
        }
        const sourceMutation = worktreeMutations.get(source.id);
        if (sourceMutation) {
          return { status: 409, json: { error: worktreeMutationError(sourceMutation.kind) } };
        }
        // The same guard merge applies, for the same reason: a running agent's
        // half-written files must not be committed underneath it.
        if (source.status === 'working' || source.status === 'needs-you') {
          return { status: 409, json: { error: 'stop the session before handing it off' } };
        }
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
        if (handoffReservations.has(source.id)) {
          return { status: 409, json: { error: 'session handoff is already in progress' } };
        }
        const branch = String(body.branch);
        const successorId = randomUUID();
        const ownership: SessionOwnership = {
          id: successorId,
          provider: account.provider,
          ...(account.provider === 'codex' ? { codexTransport: account.codexTransport ?? 'sdk' } : {}),
        };
        const reservation: { token: symbol; phase: 'preparing' | 'committing' } = {
          token: Symbol(successorId), phase: 'preparing',
        };
        handoffReservations.set(source.id, reservation);
        const sourceStatus = source.status;
        let worktreeOwnership: WorktreeMutationReservation | undefined;
        const changedDuringPreparation = (): boolean => (
          handoffReservations.get(source.id) !== reservation
          || registry.get(source.id) !== source
          || source.status !== sourceStatus
        );
        try {
          let prepared: PreparedProvider;
          try {
            prepared = await prepareForSession(account, ownership);
          } catch (error) {
            if (changedDuringPreparation()) {
              return { status: 409, json: { error: 'session changed while handoff was preparing' } };
            }
            if (account.provider === 'codex' || error instanceof CodexRuntimeError) {
              return preparationError(ownership, account, error, 'create');
            }
            throw error;
          }
          if (changedDuringPreparation()) {
            return { status: 409, json: { error: 'session changed while handoff was preparing' } };
          }

          // Preparation is the only long-running phase that stop/delete cancel.
          // Acquire immediately before changing phase: this is the authoritative
          // atomic admission check against delete, merge, upload, and another
          // handoff. Once repository mutation begins, those commands reject until
          // the successor is launched and the source is fully stopped.
          const acquired = acquireWorktreeMutation([source.id], 'handoff');
          if ('busy' in acquired) {
            return { status: 409, json: { error: worktreeMutationError(acquired.busy.kind) } };
          }
          worktreeOwnership = acquired;
          reservation.phase = 'committing';
          try {
            await commitOutstanding(source.cwd, source.branch);
          } catch (err) {
            return {
              status: 400,
              json: { error: `committing "${source.branch}" failed: ${(err as Error).message}` },
            };
          }
          let cwd: string;
          try {
            cwd = await createWorktree(source.repo, branch, source.branch);
          } catch (err) {
            return { status: 400, json: { error: (err as Error).message } };
          }
          try {
            await mkdir(join(cwd, dirname(HANDOFF_FILE)), { recursive: true });
            // Load-bearing, not incidental: this ignores the whole directory for
            // git status/diff/add, not just commits. Without it the handoff file
            // (deliberately never committed) reads as untracked "+N added" work on
            // every /status poll for the life of the session, shows up as a fake
            // diff, and — since a pathspec exclusion only stops *this* commit, not
            // whatever the successor runs later — is one `git add -A` away from
            // landing in a merge target.
            await writeFile(join(cwd, dirname(HANDOFF_FILE), '.gitignore'), '*\n', 'utf8');
            await writeFile(join(cwd, HANDOFF_FILE), renderHandoff(source), 'utf8');
          } catch (err) {
            // The worktree is left behind, exactly as `create` leaves one when
            // launch fails. Inventing a cleanup path here that create does not
            // have would leave the two inconsistent for no gain.
            return { status: 500, json: { error: `writing the handoff file failed: ${(err as Error).message}` } };
          }
          const session = registry.create({
            provider: ownership.provider,
            account: account.name,
            repo: source.repo,
            cwd,
            branch,
            title: branch,
            ...(ownership.provider === 'codex' ? { codexTransport: ownership.codexTransport } : {}),
          }, successorId);
          if (account.provider === 'codex' && prepared.runtimeVersion) {
            registry.recordCodexRuntimeVersion(session.id, prepared.runtimeVersion);
          }
          // The successor branches from the source at the source's own commit, so
          // the two share every committed path and would otherwise report a
          // guaranteed, permanent false overlap warning on each other — see the
          // `lineage` comment above.
          lineage.add(channelKey(source.id, session.id));
          const promptId = registry.appendPrompt(
            session.id, HANDOFF_PROMPT, account.provider === 'codex' ? 'queued' : 'sent',
          );
          if (registry.settings().autoApprove) registry.setAuto(session.id, true);
          const launchError = launch(
            session.id, account, prepared.adapter, cwd,
            { text: HANDOFF_PROMPT, attachments: [] }, undefined, promptId,
          );
          if (launchError) return { status: 500, json: launchError };
          // Stopped last: every failure above leaves the source exactly as it was.
          // Delete before stop — see the emit callback in launch().
          const handle = handles.get(source.id);
          handles.delete(source.id);
          handle?.stop();
          await handle?.quiescence;
          // A rate-limit stop can have already queued "resume A when account
          // resets" (see the emit callback above). Left in place, that item fires
          // after handoff and relaunches A onto a branch B has already moved past,
          // diverging the two — exactly what stopping A here is meant to prevent.
          // It also blocks unlinking the (now exhausted) source account, since
          // unlink refuses while reset-triggered items for it remain queued.
          for (const item of scheduler.all()) {
            if (item.state === 'waiting' && item.action.kind === 'resume' && item.action.sessionId === source.id) {
              scheduler.remove(item.id);
            }
          }
          return { status: 200, json: { id: session.id } };
        } finally {
          if (worktreeOwnership) releaseWorktreeMutation(worktreeOwnership);
          if (handoffReservations.get(source.id)?.token === reservation.token) {
            handoffReservations.delete(source.id);
          }
        }
      }

      case 'send': {
        const sessionId = String(body.id);
        const session = registry.get(sessionId);
        const handle = handles.get(sessionId);
        if (!session || !handle) return { status: 404, json: { error: 'no live session' } };
        const text = String(body.text);
        if (session.provider === 'codex' && session.codexTransport === 'app-server') {
          const command = text.trim().match(/^\/(compact|skills|apps|mcp)(?=\s|$)/)?.[1];
          if (command && command !== 'compact') {
            return {status:400,json:{error:`/${command} opens the capability picker. Select a capability to send.`}};
          }
          if (command === 'compact' && (text.trim() !== '/compact'
            || (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 0)))) {
            return {status:400,json:{error:'/compact does not accept arguments or attachments.'}};
          }
        }
        let prompt: AgentPrompt;
        try {
          prompt = await resolvePrompt(session.cwd, text, body.attachments);
        } catch (error) {
          return { status: 400, json: { error: String((error as Error).message ?? error) } };
        }
        const alias = text.match(/^\/(?:skill|app|mcp):[^\s]+/)?.[0].slice(1);
        if (alias && session.provider === 'codex' && session.codexTransport === 'app-server') {
          try { prompt.capability = await handle.resolveCapability?.(alias) ?? undefined; } catch {}
          if (!prompt.capability) return {status:409,json:{error:'Capability is unavailable. Refresh capabilities and retry.'}};
        }
        const currentSession = registry.get(sessionId);
        const currentHandle = handles.get(sessionId);
        if (currentSession !== session || currentHandle !== handle || currentSession.status === 'stopped') {
          return { status: 409, json: { error: 'session changed while attachments were being validated' } };
        }
        const promptId = registry.appendPrompt(
          session.id, text, session.provider === 'codex' ? 'queued' : 'sent',
          prompt.attachments.map((attachment) => attachment.name),
        );
        handle.send(prompt, promptId);
        return { status: 200, json: { ok: true } };
      }

      case 'respond-elicitation': {
        const id = String(body.id);
        const session = registry.get(id);
        const handle = handles.get(id);
        if (!handle?.respondElicitation || session?.provider !== 'codex' || session.codexTransport !== 'app-server') {
          return {status:404,json:{error:'no live form session'}};
        }
        if (!session.pending?.elicitation || session.pending.responding || body.requestId !== session.pending.id) {
          return {status:409,json:{error:'request is no longer awaiting a response'}};
        }
        return handle.respondElicitation(session.pending.id,body.response)
          ? {status:200,json:{ok:true}} : {status:400,json:{error:'invalid form response'}};
      }

      case 'answer-question': {
        const id = String(body.id);
        const session = registry.get(id);
        const handle = handles.get(id);
        if (!handle || session?.provider !== 'codex' || session.codexTransport !== 'app-server'
          || !handle.answerQuestion) return { status: 404, json: { error: 'no live question session' } };
        if (!session.pending?.question || session.pending.responding || body.requestId !== session.pending.id) {
          return { status: 409, json: { error: 'question is no longer awaiting an answer' } };
        }
        // Answers go directly to the provider callback, never into the transcript.
        if (!handle.answerQuestion(session.pending.id, body.answer)) {
          return { status: 400, json: { error: 'invalid question answer' } };
        }
        return { status: 200, json: { ok: true } };
      }

      case 'decide': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        const session = registry.get(String(body.id));
        if (session?.provider === 'codex' && session.codexTransport === 'app-server') {
          if (!session.pending || body.requestId !== session.pending.id || session.pending.responding) {
            return { status: 409, json: { error: 'approval is no longer awaiting a decision' } };
          }
          if (session.pending.question || session.pending.elicitation) return { status: 400, json: { error: 'use question answer controls' } };
          if (typeof body.allow !== 'boolean' || body.answer !== undefined) return { status: 400, json: { error: 'invalid approval decision' } };
        }
        const answer = typeof body.answer === 'string' && body.answer ? body.answer : undefined;
        // Recorded as a prompt so the scrollback shows what was chosen; clicking
        // an option is the user speaking, and it is delivered as the tool result.
        if (answer) registry.appendPrompt(String(body.id), answer, 'sent');
        handle.decide(Boolean(body.allow), answer);
        return { status: 200, json: { ok: true } };
      }

      case 'auto': {
        const session = registry.get(String(body.id));
        if (!session) return { status: 404, json: { error: 'no such session' } };
        const on = Boolean(body.auto);
        // Registry first, so the flag sticks (and survives a restart) even for a
        // stopped session with no live handle to tell.
        registry.setAuto(session.id, on);
        handles.get(session.id)?.setAuto(on);
        return { status: 200, json: { ok: true, auto: on } };
      }

      case 'codex-settings': {
        const session = registry.get(String(body.id));
        if (!session) return { status: 404, json: { error: 'no such session' } };
        if (session.provider !== 'codex') {
          return { status: 409, json: { error: 'Codex settings are only available for Codex sessions.' } };
        }
        if (session.status !== 'stopped') {
          return { status: 409, json: { error: 'Codex settings can only change while the session is stopped.' } };
        }
        try {
          registry.setCodexSettings(session.id, validateCodexSettings(body.codexSettings));
        } catch (error) {
          return { status: 400, json: { error: String((error as Error).message ?? error) } };
        }
        return { status: 200, json: { ok: true } };
      }

      case 'stop': {
        const sessionId = String(body.id);
        cancelRecovery(sessionId);
        const handoff = handoffReservations.get(sessionId);
        if (handoff?.phase === 'committing') {
          return { status: 409, json: { error: 'session handoff is committing' } };
        }
        const currentMutation = worktreeMutations.get(sessionId);
        if (currentMutation) {
          // A repeated stop is idempotent, but must leave the first stop's exact
          // writer token in place. Every other owner is already mutating the
          // worktree and cannot safely be cancelled or replaced here.
          if (currentMutation.kind === 'stop') {
            return { status: 200, json: { ok: true } };
          }
          return { status: 409, json: { error: worktreeMutationError(currentMutation.kind) } };
        }
        // Capture and reserve before any reservation, Registry, or handle
        // mutation. App-server stop is terminal from the UI's perspective
        // before setup/snapshot/interrupt work necessarily releases its writer.
        const handle = handles.get(sessionId);
        const quiescence = handle?.quiescence;
        let stopOwnership: WorktreeMutationReservation | undefined;
        if (handle) {
          const acquired = acquireWorktreeMutation([sessionId], 'stop');
          if ('busy' in acquired) {
            return { status: 409, json: { error: worktreeMutationError(acquired.busy.kind) } };
          }
          stopOwnership = acquired;
          if (quiescence) {
            // Fulfillment is positive proof that the writer retired. Rejection
            // violates AgentHandle's contract, so handle it without releasing
            // the fail-closed owner. Exact-token release also prevents a stale
            // fulfillment from removing any later owner.
            void quiescence.then(
              () => releaseWorktreeMutation(acquired),
              () => {
                // Retain ownership: rejection is not evidence of quiescence.
              },
            );
          }
        }
        handoffReservations.delete(sessionId);
        resumeReservations.delete(sessionId);
        if (createReservations.delete(sessionId)) {
          const session = registry.get(sessionId);
          registry.apply(sessionId, {
            type: 'stopped',
            reason: 'Stopped by user.',
            ...(session?.provider === 'codex' ? { code: 'codex_user_stopped' as const } : {}),
          });
        }
        // Delete first, then stop — see the emit callback in launch().
        if (handles.get(sessionId) === handle) handles.delete(sessionId);
        try {
          handle?.stop();
          if (stopOwnership && !quiescence) releaseWorktreeMutation(stopOwnership);
        } catch {
          // A provider violated stop()'s void/no-throw contract. Keep the exact
          // stop owner unless its quiescence later fulfills, so no worktree
          // operation can race a writer whose retirement is unproven.
        }
        return { status: 200, json: { ok: true } };
      }

      case 'resume': {
        const sessionId = String(body.id);
        cancelRecovery(sessionId, false);
        if (deletingSessions.has(sessionId)) {
          return { status: 409, json: { error: 'session deletion is in progress' } };
        }
        const mutation = worktreeMutations.get(sessionId);
        if (mutation) {
          return { status: 409, json: { error: worktreeMutationError(mutation.kind) } };
        }
        const session = registry.get(sessionId);
        if (!session) return { status: 404, json: { error: 'no such session' } };
        if (handoffReservations.has(sessionId)) {
          return { status: 409, json: { error: 'session handoff is in progress' } };
        }
        // Without this, resume on a live session (or a double-click on Resume)
        // calls launch(), whose handles.set() overwrites the live handle —
        // orphaning an agent that no stop() can reach while it still holds write
        // access to the worktree a second agent is now editing.
        if (session.status !== 'stopped' || handles.has(sessionId)) {
          return { status: 409, json: { error: 'session is not stopped' } };
        }
        if (resumeReservations.has(sessionId)) {
          return { status: 409, json: { error: 'session resume is already in progress' } };
        }
        const account = accounts.find((a) => a.name === session.account);
        if (!account) return { status: 400, json: { error: 'account no longer configured' } };
        if (account.provider !== session.provider) {
          const reason = 'session provider no longer matches its configured account';
          if (session.provider === 'codex') {
            registry.recordStoppedFailure(session.id, reason, 'codex_resume_failed');
            return { status: 409, json: { error: reason, code: 'codex_resume_failed' } };
          }
          return { status: 409, json: { error: reason } };
        }
        if (session.provider === 'codex' && session.codexTransport !== 'sdk' && session.codexTransport !== 'app-server') {
          const reason = session.stoppedReason ?? 'This Codex session has an invalid stored transport. Delete it and create a new session.';
          registry.recordStoppedFailure(session.id, reason, 'codex_resume_failed');
          return { status: 409, json: { error: reason, code: 'codex_resume_failed' } };
        }
        const reservation = Symbol(sessionId);
        resumeReservations.set(sessionId, reservation);
        try {
          // A worktree can be removed (merged and cleaned up, or deleted by hand)
          // while its session card lives on. Spawning into a missing cwd makes the
          // Claude SDK report a native-binary/platform mismatch — the binary is
          // fine, the directory is gone — so check here and say what actually
          // happened rather than passing that error on.
          if (!(await stat(session.cwd).then((s) => s.isDirectory(), () => false))) {
            const rawReason = `worktree is gone: ${session.cwd} — delete this session, or recreate the worktree`;
            if (account.provider === 'codex') {
              const reason = redactAccountValue(rawReason, account);
              registry.recordStoppedFailure(session.id, reason, 'codex_resume_failed');
              return { status: 409, json: { error: reason, code: 'codex_resume_failed' } };
            }
            return { status: 409, json: { error: rawReason } };
          }
          let prepared: PreparedProvider;
          try {
            prepared = await prepareForSession(account, session);
          } catch (error) {
            return preparationFailure(session, account, error, 'resume');
          }
          if (account.provider === 'codex' && prepared.runtimeVersion) {
            registry.recordCodexRuntimeVersion(session.id, prepared.runtimeVersion);
          }
          // No request can interleave between this final identity/status check and
          // synchronous revival + launch. The reservation blocks another resume;
          // identity catches delete; handle absence prevents overwriting a live agent.
          if (resumeReservations.get(sessionId) !== reservation
            || registry.get(sessionId) !== session
            || session.status !== 'stopped'
            || handles.has(sessionId)) {
            return { status: 409, json: { error: 'session changed while resume was preparing' } };
          }
          // registry.revive() (not a direct mutation) so subscribers get #notify()'d
          // immediately; neither adapter emits a synchronous status event at start(),
          // so without this an SSE client would keep showing 'stopped' until the
          // resumed agent's first async event arrived.
          registry.revive(session.id);
          const prompt = typeof body.prompt === 'string' ? body.prompt : 'continue';
          const promptId = account.provider === 'codex' && typeof body.prompt === 'string'
            ? registry.appendPrompt(session.id, prompt, 'queued')
            : undefined;
          const launchError = launch(
            session.id, account, prepared.adapter, session.cwd, { text: prompt, attachments: [] },
            session.vendorSessionId ?? undefined, promptId,
          );
          if (launchError) return { status: 500, json: launchError };
          cancelRecovery(sessionId);
          return { status: 200, json: { ok: true } };
        } finally {
          if (resumeReservations.get(sessionId) === reservation) resumeReservations.delete(sessionId);
        }
      }

      case 'merge': {
        const sel = selectedRepo(body);
        if ('error' in sel) return { status: 400, json: { error: sel.error } };
        // A `working`/`needs-you` session has an agent actively writing to its
        // worktree; committing out from under it would race the agent's own
        // writes and could snapshot a half-written state. `done` and `stopped`
        // are both quiescent — nothing is touching the files right now.
        const busy = sel.sessions.find((s) => s.status === 'working' || s.status === 'needs-you');
        if (busy) {
          return { status: 409, json: { error: `"${busy.branch}" is still running — stop it or wait before merging` } };
        }
        const changed = sel.sessions.find((session) => registry.get(session.id) !== session);
        if (changed) {
          return { status: 409, json: { error: `session changed before merging "${changed.branch}"` } };
        }
        const ownership = acquireWorktreeMutation(sel.sessions.map((session) => session.id), 'merge');
        if ('busy' in ownership) {
          return { status: 409, json: { error: worktreeMutationError(ownership.busy.kind) } };
        }
        try {
          const result = await mergeWorktrees(sel.repo, sel.sessions.map((s) => ({ cwd: s.cwd, branch: s.branch })));
          if (!result.ok) return { status: 409, json: { error: result.error, merged: result.merged } };
          return { status: 200, json: result };
        } finally {
          releaseWorktreeMutation(ownership);
        }
      }

      case 'push': {
        const sel = selectedRepo(body);
        if ('error' in sel) return { status: 400, json: { error: sel.error } };
        const result = await pushRepo(sel.repo);
        if (!result.ok) return { status: 400, json: { error: result.error } };
        return { status: 200, json: result };
      }

      case 'delete': {
        cancelRecovery(String(body.id));
        const sessionId = String(body.id);
        if (deletingSessions.has(sessionId)) {
          return { status: 409, json: { error: 'session deletion is already in progress' } };
        }
        const ownership = acquireWorktreeMutation([sessionId], 'delete');
        if ('busy' in ownership) {
          return { status: 409, json: { error: worktreeMutationError(ownership.busy.kind) } };
        }
        deletingSessions.add(sessionId);
        try {
          handoffReservations.delete(sessionId);
          createReservations.delete(sessionId);
          resumeReservations.delete(sessionId);
          const session = registry.get(sessionId);
          const handle = handles.get(sessionId);
          // Stop accepting new work immediately, but retain launch ownership so
          // the app-server's terminal callback can settle Registry state before
          // deletion removes the card and optional worktree.
          handles.delete(sessionId);
          handle?.stop();
          await handle?.quiescence;
          launchOwners.delete(sessionId);
          registry.remove(sessionId);
          dropChannels(channels, sessionId);
          dropSeen(seenChannels, sessionId);
          dropSeen(lineage, sessionId);
          dropPaths(paths, sessionId);
          if (session && body.removeWorktree) {
            await beforeWorktreeRemoval?.(session.cwd);
            await run('git', ['worktree', 'remove', '--force', session.cwd], { cwd: session.repo })
              .catch(() => rm(session.cwd, { recursive: true, force: true }));
          }
          return { status: 200, json: { ok: true } };
        } finally {
          deletingSessions.delete(sessionId);
          releaseWorktreeMutation(ownership);
        }
      }

      case 'schedule': {
        const parsed = await parseSchedule(body);
        if ('error' in parsed) return { status: 400, json: { error: parsed.error } };
        const item = scheduler.add(parsed.trigger, parsed.action);
        return { status: 200, json: { id: item.id } };
      }

      case 'unschedule': {
        scheduler.remove(String(body.itemId));
        return { status: 200, json: { ok: true } };
      }

      case 'settings': {
        const parsed = parseSettingsPatch(body.patch);
        if ('error' in parsed) return { status: 400, json: { error: parsed.error } };
        if (parsed.patch.autoRequeue === false) recoveryCandidates.clear();
        registry.setSettings(parsed.patch);
        return { status: 200, json: { ok: true } };
      }

      case 'link-start': {
        if (!linker || !accountStore) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        const provider = body.provider;
        if (provider !== 'claude' && provider !== 'codex') {
          return { status: 400, json: { error: 'provider must be claude or codex' } };
        }
        const { error } = await linker.start(provider);
        // A pending link is the only reason start() refuses, and that is a
        // conflict rather than a malformed request.
        if (error) return { status: 409, json: { error } };
        return { status: 200, json: { ok: true } };
      }

      case 'link-code': {
        if (!linker) return { status: 400, json: { error: 'account linking is not available' } };
        if (typeof body.code !== 'string') {
          return { status: 400, json: { error: 'code must be a string' } };
        }
        const { error } = linker.submitCode(body.code);
        if (error) return { status: 409, json: { error } };
        return { status: 200, json: { ok: true } };
      }

      case 'link-confirm': {
        if (!linker || !accountStore) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        if (typeof body.name !== 'string') {
          return { status: 400, json: { error: 'name must be a string' } };
        }
        const { account, error } = await linker.commit(body.name);
        if (error || !account) return { status: 409, json: { error: error ?? 'link failed' } };
        // Directory renamed, now make it durable, then admit it to the running
        // process. Only this entry enters memory: the file on disk may have
        // gained hand edits while the browser tab was open, and adopting those
        // here would be an uncontrolled reload triggered by an unrelated action.
        await accountStore.append(account);
        accounts.push(account);
        registry.touch();
        return { status: 200, json: { ok: true, name: account.name } };
      }

      case 'link-cancel': {
        if (!linker) return { status: 400, json: { error: 'account linking is not available' } };
        await linker.cancel();
        return { status: 200, json: { ok: true } };
      }

      case 'unlink': {
        if (!accountStore || !linker) {
          return { status: 400, json: { error: 'account linking is not available' } };
        }
        const name = String(body.name);
        const index = accounts.findIndex((a) => a.name === name);
        if (index === -1) return { status: 404, json: { error: `unknown account: ${name}` } };

        if (accountBusy(registry, name)) {
          return { status: 409, json: { error: `${name} has a running session` } };
        }
        const queued = scheduler.all().filter((item) =>
          (item.trigger.kind === 'reset' && item.trigger.account === name)
          || (item.action.kind === 'create' && item.action.account === name));
        if (queued.length > 0) {
          return {
            status: 409,
            json: { error: `${name} has ${queued.length} queued item(s). Remove them first.` },
          };
        }

        const account = accounts[index];
        // Durable record first. A failed rm then leaves a stray directory,
        // which is harmless and sweepable; the reverse order can delete
        // credentials and then fail to persist, leaving a live entry pointing
        // at nothing.
        await accountStore.remove(name);
        accounts.splice(index, 1);
        await limitCoordinator?.forget(account);
        await codexPool?.retire?.(account);

        // Only ever delete a directory that is exactly <accountsRoot>/<name>.
        // A hand-written accounts.json entry can point its credential dir
        // anywhere — real user data this app did not create and does not own
        // (see the README's claude-alt example). Checked two ways: the name
        // itself must be shaped like something the app could only have
        // produced honestly (ACCOUNT_NAME_RE bars `.` and `/`, so join() can
        // never be walked out of the root by the name), and the resolved
        // directory must equal the resolved managed path exactly — not
        // merely share a string prefix with it.
        const dir = account.env[CREDENTIAL_ENV[account.provider]];
        const managed = ACCOUNT_NAME_RE.test(name) && dir !== undefined
          && resolve(dir) === resolve(join(linker.root, name));
        if (managed) {
          // Best-effort revoke, so the refresh token dies rather than being
          // orphaned. A network hiccup must not block removing an account.
          await revokeLogin(account, linker.claudeBin).catch(() => {});
          await rm(dir, { recursive: true, force: true });
        }
        registry.touch();
        return { status: 200, json: { ok: true, removedDirectory: managed } };
      }

      default:
        return { status: 400, json: { error: `unknown cmd: ${String(body.cmd)}` } };
    }
  }

  // True while a tick's `command()` calls are in flight. An item stays
  // `waiting` until its own call resolves, so if one pass runs past TICK_MS
  // (a realistic case: due() deliberately lets a backlog build up while
  // Switchboard is down, and each `create` in that backlog awaits a real git
  // checkout), the next interval firing would call due() again and see the
  // same still-waiting items — dispatching a `create` a second time and
  // spawning two live agents for one scheduled task. Skipping the overlapping
  // pass is correct, not just convenient: it has nothing unique to do, and
  // the next interval will pick up whatever is still due 30s later.
  let ticking = false;

  /**
   * One scheduler pass. Every due item is routed back through `command()` — a
   * scheduled create is literally the same code path as a create from the
   * dialog, so there is no second launch path to keep in sync, and scheduled
   * actions inherit `command()`'s validation and 404/409 handling for free.
   *
   * No save here: `due()`'s `missed` transition and every `remove()`/`fail()`
   * below all go through Scheduler#notify(), and the coalesced save timer
   * (`unsubSave` below) is subscribed to the scheduler as well as the
   * registry — so a scheduler-only change persists on its own, coalesced
   * schedule instead of this function rewriting all of state.json on every
   * 30s tick regardless of whether anything happened.
   */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      // Persisted scheduler data is untrusted. Reset routing must be derived
      // from the action's current account, never from a restored trigger that
      // could mislabel Codex work as Claude and bypass the boundary read.
      for (const item of scheduler.all()) {
        if (item.state !== 'waiting' || item.trigger.kind !== 'reset') continue;
        let actionAccount: string | null = null;
        let actionProvider: Account['provider'] | null = null;
        if (item.action.kind === 'create') {
          actionAccount = typeof item.action.account === 'string' ? item.action.account : null;
          actionProvider = item.action.resetProvider === 'claude' || item.action.resetProvider === 'codex'
            ? item.action.resetProvider
            : null;
        } else if (item.action.kind === 'send' || item.action.kind === 'resume') {
          const session = registry.get(item.action.sessionId);
          actionAccount = session?.account ?? null;
          actionProvider = session?.provider ?? null;
        }
        const configuredAccount = actionAccount
          ? accounts.find((account) => account.name === actionAccount)
          : undefined;
        if (!actionAccount || !configuredAccount) {
          scheduler.fail(item.id, 'scheduled reset action no longer has an account');
        } else if (item.action.kind === 'create'
          && (!actionProvider || configuredAccount.provider !== actionProvider)) {
          scheduler.fail(item.id, 'scheduled reset provider changed or is missing — reschedule this item');
        } else if (actionProvider && configuredAccount.provider !== actionProvider) {
          scheduler.fail(item.id, 'scheduled reset provider no longer matches its action');
        } else if (item.trigger.account !== actionAccount) {
          scheduler.fail(item.id, 'scheduled reset account no longer matches its action');
        }
      }

      const busy = (name: string) => accountBusy(registry, name);

      const dispatch = async (items: ReturnType<Scheduler['due']>): Promise<void> => {
        for (const item of items) {
          if (!scheduler.all().includes(item) || item.state !== 'waiting') continue;
          let action = item.action;
          // A queued `send` can only be decided against the session's status at
          // schedule time — but the headline use of this feature is scheduling a
          // send hours out against a session that is live *right now*. By fire
          // time the server has very likely restarted, and Registry.load marks
          // every session `stopped` on load (see GRACE_MS's own restart-survival
          // reasoning above). Deciding at schedule time would then queue a `send`
          // that 404s at fire time — the message silently never reaches anyone.
          // Only fire time knows the real answer, so the downgrade happens here,
          // not in the client.
          if (action.kind === 'send' && registry.get(action.sessionId)?.status === 'stopped') {
            action = { kind: 'resume', sessionId: action.sessionId, prompt: action.text };
          }
          let result: { status: number; json: unknown };
          try {
            result = await command(toCommand(action));
          } catch (err) {
            result = { status: 500, json: { error: String((err as Error).message ?? err) } };
          }
          if (result.status === 200) scheduler.remove(item.id);
          else scheduler.fail(item.id, String((result.json as { error?: string }).error ?? 'failed'));
        }
      };

      // Timed work is a user-named deadline and must not wait behind an
      // app-server boundary read. `free: false` leaves reset work untouched.
      await dispatch(scheduler.due(now, { free: () => false, busy }));

      const codexReady = new Map<string, boolean>();
      if (limitCoordinator) {
        const candidates = scheduler.waitingResetAccounts()
          .map((name) => accounts.find((account) => account.name === name))
          .filter((account): account is Account => Boolean(account)
            && account.provider === 'codex' && !busy(account.name));
        await Promise.all(candidates.map(async (account) => {
          const release = await limitCoordinator.releaseCodexAfterFreshRead(account.name, now);
          codexReady.set(account.name, release.ready);
        }));
      }

      await dispatch(scheduler.due(now, {
        busy,
        free: (name) => {
          const account = accounts.find((candidate) => candidate.name === name);
          if (!account) return false;
          return account.provider === 'claude'
            ? usage.free(account.name, account.budget, now)
            : codexReady.get(account.name) === true;
        },
      }));
    } finally {
      ticking = false;
    }
  }

  const server = httpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Every fallible await for this request happens inside this try. Node treats
    // an unhandled rejection as a fatal, process-wide error — one bad request
    // (a missing static file, a Registry#save() hiccup, anything future) would
    // otherwise kill every live agent session on the whole process, not just
    // this request. A single top-level catch covers every current and future
    // await in the handler, instead of relying on every branch to remember its
    // own try/catch.
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // Applied above the route dispatch, with no per-route exemptions: /repos
      // used to be reachable without it and leaked the decoded path of every
      // project the user has opened in Claude Code to a rebound attacker page.
      // Every route here either mutates the machine or returns local paths,
      // transcripts and repo names, so none of them wants an exemption.
      if (!hostOk(req)) { res.writeHead(403).end('forbidden'); return; }

      if (url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const push = () => res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        push();
        const unsubRegistry = registry.subscribe(push);
        const unsubScheduler = scheduler.subscribe(push);
        const unsubLink = linker ? linker.subscribe(push) : () => {};
        // Keeps proxies and sleeping laptops from dropping an idle stream.
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          unsubRegistry();
          unsubScheduler();
          unsubLink();
          clearInterval(ping);
        });
        return;
      }

      if (url.pathname === '/repos') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await recentRepos()));
        return;
      }

      if (url.pathname === '/capabilities' && req.method === 'GET') {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'application/json');
        const params = url.searchParams;
        const keys = [...params.keys()];
        const live = params.has('session');
        const allowed = live ? ['session','refresh'] : ['account','cwd','refresh'];
        if (keys.some(key => !allowed.includes(key) || params.getAll(key).length !== 1)
          || (params.has('refresh') && params.get('refresh') !== '1')
          || (!live && (!params.get('account') || !params.get('cwd')))) {
          res.writeHead(400); res.end(JSON.stringify({error:'Unsupported capability query.'})); return;
        }
        if (!live) {
          const account = accounts.find(a => a.name === params.get('account'));
          if (account?.provider !== 'codex' || account.codexTransport !== 'app-server' || !codexPool?.capabilities) {
            res.writeHead(404); res.end(JSON.stringify({error:'No app-server capability account.'})); return;
          }
          let cwd: string;
          try {
            cwd = await realpath(params.get('cwd')!);
            if (!(await stat(cwd)).isDirectory()) throw new Error();
            const result = await run('git', ['-C',cwd,'rev-parse','--is-inside-work-tree'], {timeout:5000});
            if (result.stdout.trim() !== 'true') throw new Error();
          } catch {
            res.writeHead(400); res.end(JSON.stringify({error:'Choose an existing Git repository directory.'})); return;
          }
          try {
            if (accounts.find(a => a.name === account.name) !== account || account.codexTransport !== 'app-server') throw new Error();
            const snapshot = await codexPool.capabilities(account,cwd,params.get('refresh') === '1');
            if (accounts.find(a => a.name === account.name) !== account || account.codexTransport !== 'app-server') throw new Error();
            res.writeHead(200); res.end(JSON.stringify(snapshot));
          } catch {
            res.writeHead(409); res.end(JSON.stringify({error:'Capabilities changed or are unavailable. Refresh and retry.'}));
          }
          return;
        }
        const id = params.get('session') ?? '';
        const session = registry.get(id);
        const handle = handles.get(id);
        if (session?.provider !== 'codex' || session.codexTransport !== 'app-server' || !handle?.capabilities) {
          res.writeHead(404); res.end(JSON.stringify({error:'No live capability session.'})); return;
        }
        try {
          const snapshot = await handle.capabilities(url.searchParams.get('refresh') === '1');
          if (handles.get(id) !== handle || registry.get(id) !== session || session.status === 'stopped') throw new Error();
          res.writeHead(200); res.end(JSON.stringify(snapshot));
        } catch { res.writeHead(409); res.end(JSON.stringify({error:'Capabilities changed or are unavailable. Refresh and retry.'})); }
        return;
      }

      if (url.pathname === '/elicitation-url' && req.method === 'GET') {
        const id=url.searchParams.get('session')??'';
        const requestId=url.searchParams.get('request')??'';
        const pending=registry.get(id)?.pending;
        const destination=pending?.id===requestId && pending.elicitation?.mode==='url' && !pending.responding
          ? handles.get(id)?.elicitationUrl?.(requestId) : null;
        res.setHeader('cache-control','no-store');
        res.setHeader('referrer-policy','no-referrer');
        if(!destination){res.writeHead(409);res.end('This request is no longer available.');return;}
        res.writeHead(302,{location:destination});res.end();return;
      }

      if (url.pathname === '/detail' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? '';
        const itemId = url.searchParams.get('item') ?? '';
        const detail = registry.getToolDetail(sessionId, itemId);
        if (!detail) {
          res.writeHead(404, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          res.end('{}');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(detail));
        return;
      }

      if (url.pathname === '/status') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('{}'); return; }
        const status = await worktreeStatus(session.cwd).catch(() => null);
        if (!status) {
          // The worktree is gone, permanently as far as this process is
          // concerned — every later attempt will fail the same way. Drop the
          // cached paths rather than leaving them for siblings to keep
          // intersecting against forever: a transient git hiccup is what
          // refreshPaths' stale-on-failure is for, but this caller has the
          // liveness signal that says this is not that.
          dropPaths(paths, id);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('null');
          return;
        }
        // Collected here rather than on a timer of its own: this route is
        // already polled per card, and refreshPaths' TTL is what stops a
        // four-second poll from spawning git on every call.
        //
        // currentBranch resolves INSIDE the closure, not before it. Outside, it
        // would run on every poll even when the paths are fresh — and it is the
        // same answer for every session in the repo, so a ten-session grid would
        // ask it 150 times a minute to learn one thing. Inside, it rides the TTL
        // that is already there and costs nothing when nothing is stale.
        await refreshPaths(paths, id, async () => changedPaths(
          session.cwd, await currentBranch(session.repo).catch(() => ''),
        ), Date.now());
        const siblings = registry.all()
          .filter((s) => s.id !== id && s.repo === session.repo)
          .map((s) => ({ id: s.id, branch: s.branch }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ...status,
          talking: siblings.filter((s) => channelOpen(channels, id, s.id)),
          // The count is the true total; the file list is capped so a full
          // intersection (a codemod across thousands of files, polled every
          // four seconds per visible card) is never serialized whole — nothing
          // downstream reads past MAX_LISTED_PATHS anyway.
          overlapping: overlaps(paths, id, siblings)
            .filter((o) => !lineage.has(channelKey(id, o.id)))
            .map((o) => ({ id: o.id, branch: o.branch, count: o.files.length, files: o.files.slice(0, MAX_LISTED_PATHS) })),
        }));
        return;
      }

      // Keyed by session id, never a path from the client: the repo to read is
      // whatever that session already runs in, so this opens no way to point
      // `git log` at a directory the user never registered.
      if (url.pathname === '/graph') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('[]'); return; }
        const commits = await commitGraph(session.cwd, session.repo).catch(() => []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(commits));
        return;
      }

      // Same rule as /graph: keyed by session id, never a path from the client.
      if (url.pathname === '/diff') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('[]'); return; }
        const files = await worktreeDiff(session.cwd).catch(() => []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(files));
        return;
      }

      if (url.pathname === '/command' && req.method === 'POST') {
        if (!originOk(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'cross-origin request blocked' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let result: { status: number; json: unknown };
        try {
          result = await command(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        } catch (err) {
          result = { status: 400, json: { error: (err as Error).message } };
        }
        // Persist before responding, not after: the brief's original order sent the
        // response first and awaited save() afterward. The client sees the response
        // complete as soon as res.end() flushes, regardless of that trailing await —
        // so a test's cleanup (rm the temp state dir) could run concurrently with the
        // still-in-flight write-tmp-then-rename in Registry#save, intermittently
        // failing with ENOTEMPTY. Saving first makes "response received" imply "state
        // durable," which is also the more correct guarantee to offer callers.
        await registry.save();
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.json));
        return;
      }

      if (url.pathname === '/upload' && req.method === 'POST') {
        if (!originOk(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'cross-origin request blocked' }));
          return;
        }
        const sessionId = url.searchParams.get('id') ?? '';
        const session = registry.get(sessionId);
        // No session means no worktree to write into — there is no sane default
        // target for the bytes, so this is a 404 rather than a guess.
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such session' }));
          return;
        }
        // Trust boundary: the name comes from the browser and is used to build a
        // filesystem path. Reject anything basename() had to change rather than
        // silently rewriting it — a caller asking for ../../.ssh/authorized_keys
        // should get an error, not a surprise file in uploads/.
        const raw = url.searchParams.get('name') ?? '';
        const name = basename(raw);
        if (!name || name === '.' || name === '..' || name !== raw) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad filename' }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          // Counted as it streams, not after: buffering first would mean a
          // mistaken drop of a video file allocates the whole thing before we
          // decide to refuse it.
          if (size > MAX_UPLOAD) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'file too large' }));
            req.destroy();
            return;
          }
          chunks.push(c as Buffer);
        }
        if (registry.get(sessionId) !== session) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'session changed while upload was streaming' }));
          return;
        }
        const ownership = acquireWorktreeMutation([sessionId], 'upload');
        if ('busy' in ownership) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: worktreeMutationError(ownership.busy.kind) }));
          return;
        }
        try {
          // Preserve the explicit rejection for a tracked legacy uploads symlink,
          // but do not write through that mutable directory at all. The contained
          // writer creates an unpredictable direct child of the worktree root and
          // binds all bytes to its already-opened file handle.
          const uploadsDir = join(session.cwd, 'uploads');
          if ((await lstat(uploadsDir).catch(() => null))?.isSymbolicLink()) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'refusing to follow symlink' }));
            return;
          }
          let storedPath: string;
          try {
            storedPath = await writeContainedUpload(
              session.cwd, name, Buffer.concat(chunks),
              { ...(beforeUploadRootPin ? { beforeRootPin: beforeUploadRootPin } : {}),
                ...(beforeUploadWrite ? { beforeWrite: beforeUploadWrite } : {}) },
            );
          } catch (error) {
            const changed = error instanceof UploadChangedError;
            res.writeHead(changed ? 409 : 400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: changed ? error.message : 'could not store upload' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ path: storedPath }));
          return;
        } finally {
          releaseWorktreeMutation(ownership);
        }
      }

      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // Serve only the known assets; never join user-controlled path segments.
      // The fonts sit flat in web/ rather than web/fonts/ for exactly that
      // reason — a subdirectory would mean building a path from the URL.
      if (!['index.html', 'app.js', 'lib.js', 'questions.js', 'codex-commands.js', 'style.css', 'inter.woff2', 'garamond.woff2'].includes(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      // web/app.js and web/style.css legitimately don't exist until Task 7 lands —
      // that's a 404, not a server error, so it's handled here rather than falling
      // through to the catch-all 500 below.
      let body: Buffer;
      try {
        body = await readFile(join(WEB, file));
      } catch {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] });
      res.end(body);
    } catch {
      // A rejected await anywhere above lands here instead of escaping as an
      // unhandled rejection. Never write a second set of headers onto a response
      // that already started one — destroy the socket instead.
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal server error' }));
      }
    }
  });

  // Persist on any state change, not just on a command. save()'s only other call
  // site is the /command handler, so a session that ran to completion unattended
  // never got past its `create` snapshot: state.json held status "working" with an
  // empty transcript, and a restart brought back an empty card — exactly the case
  // restart survival exists for. Coalesced because #notify() fires per SDK
  // message. The .catch is load-bearing: this runs outside the request handler's
  // try/catch, where an unguarded rejection is fatal to the whole process and
  // would take every live agent with it.
  //
  // Also subscribed to the scheduler, not just the registry: `state.json` holds
  // the queue too, and `tick()`'s `missed` transition and the auto-requeue
  // `scheduler.add()` in launch()'s emit callback both need to survive a
  // restart just like a registry change does. One shared timer coalesces
  // whichever source fires first, so a burst of scheduler and registry changes
  // in the same 30s tick still writes state.json once, not twice.
  //
  // unref()'d rather than flushed on close: the timer must never be the reason
  // the process stays alive (it would also hold test runs open for 2s each, and
  // fire a write into an already-deleted temp dir), while the server handle keeps
  // the loop alive for as long as saving actually matters. Cleared on 'close' too
  // so a closed server can't write after its state dir is gone.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void registry.save().catch(() => {});
    }, 2000).unref();
  };
  const unsubSave = registry.subscribe(scheduleSave);
  const unsubSchedulerSave = scheduler.subscribe(scheduleSave);
  server.on('close', () => {
    unsubSave();
    unsubSchedulerSave();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  });

  // unref()'d and cleared on close for the same reasons as the save timer above:
  // it must never be the reason the process stays alive, and a closed server
  // must not fire a create into an already-deleted state directory.
  const tickTimer = setInterval(() => { void tick().catch(() => {}); }, TICK_MS).unref();
  server.on('close', () => clearInterval(tickTimer));
  if (limitCoordinator) attachAccountLimitLifecycle(server, limitCoordinator, limitLifecycle);
  if (codexPool) server.once('close', () => { void codexPool.close().catch(() => {}); });

  // Exposed so tests can drive exactly one pass instead of racing a 30s timer.
  (server as Server & { tick: () => Promise<void> }).tick = tick;

  return server as Server & { tick: () => Promise<void> };
}

// Entry point: only when run directly, so tests can import createServer freely.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const statePath = new URL('../state.json', import.meta.url).pathname;
  const accountsPath = new URL('../accounts.json', import.meta.url).pathname;
  const accounts = await loadAccounts(accountsPath);
  const accountStore = createAccountStore(accountsPath);
  const accountsRoot = join(homedir(), '.switchboard', 'accounts');
  const linker = new Linker({ accountsRoot, accounts: () => accounts });
  // Clears staging dirs left by a crash or a kill. A pending link deliberately
  // does not survive a restart.
  await linker.sweep();
  const usage = new Usage();
  const scheduler = new Scheduler();
  const registry = await Registry.load(statePath, usage, scheduler);
  const codexPool = new CodexProviderPool();
  const limitCoordinator = createAccountLimitCoordinator({
    accounts,
    usage,
    onChange: () => registry.touch(),
    codexPool,
  });
  // ponytail: env override so a second copy (a worktree, a test drive) can run
  // beside the real one instead of failing on EADDRINUSE.
  const port = Number(process.env.PORT) || 4711;
  const server = createServer({
    registry, usage, scheduler, accounts, accountStore, linker, limitCoordinator, codexPool,
  });
  server.listen(port, '127.0.0.1', () => console.log(`switchboard on http://127.0.0.1:${port}`));
}
