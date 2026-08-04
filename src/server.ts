import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir, rm, stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { Registry } from './sessions.ts';
import { Usage } from './usage.ts';
import { Scheduler, type Ctx } from './schedule.ts';
import { commitGraph, createWorktree, worktreeStatus } from './worktree.ts';
import { mergeWorktrees, pushRepo } from './merge.ts';
import { claudeAdapter, probeLimits } from './agents/claude.ts';
import { createCodexAdapter } from './agents/codex.ts';
import {
  CodexRuntimeError, prepareCodexRuntime, redactCodexText, redactable,
} from './agents/codex-runtime.ts';
import type {
  AccountLimits, Action, Adapter, AdapterEvent, AgentHandle, CodexFailureCode, NotifyOn, Session,
  Settings, SortMode, Trigger,
} from './types.ts';

const run = promisify(execFile);

export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
  bin?: string;
};

type PreparedProvider = {
  adapter: Adapter;
};

async function prepareProvider(account: Account): Promise<PreparedProvider> {
  if (account.provider === 'claude') return { adapter: claudeAdapter };
  const runtime = await prepareCodexRuntime({ bin: account.bin, env: account.env });
  return { adapter: createCodexAdapter(runtime) };
}

/**
 * Account values are launch-only configuration, so any of them — not just the
 * credential-shaped keys redactCodexText() knows about — is removed from text
 * the browser will see. Short values are left alone: see MIN_REDACTABLE, a
 * substring search for "1" redacts arithmetic, not a secret.
 */
function redactAccountValue(text: string, account: Account): string {
  let safe = redactCodexText(text, account.env);
  for (const value of Object.values(account.env)) {
    if (redactable(value)) safe = safe.replaceAll(value, '[REDACTED]');
  }
  return safe;
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
    return { cmd: 'create', repo: a.repo, branch: a.branch, account: a.account, prompt: a.prompt };
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
 * disagree. Real plan utilization when we have it, the local budget estimate
 * otherwise. `max` of the two windows: a 95%-consumed week has to outrank a
 * quiet five-hour window, and both are already 0-100 from the SDK.
 */
export function accountLoad(usage: Usage, a: Account): number {
  const { limits } = usage.getLimits(a.name);
  if (!limits) return usage.pace(a.name, a.budget);
  const pct = Math.max(limits.fiveHour?.utilization ?? 0, limits.sevenDay?.utilization ?? 0);
  return pct / 100;
}

/**
 * One refresh pass over every Claude account, concurrently.
 *
 * `probe` is a parameter so tests drive this with a fake and never spawn a CLI.
 * Every failure is swallowed into `limitsError`: a probe that throws must leave
 * the account showing exactly the estimate UI it shows today, never block a
 * session, and never take its neighbours down with it — hence allSettled and
 * the per-account try.
 */
export async function refreshLimits(
  usage: Usage,
  accounts: Account[],
  probe: (env: Record<string, string>) => Promise<AccountLimits> = probeLimits,
): Promise<void> {
  await Promise.allSettled(
    accounts
      .filter((a) => a.provider === 'claude')
      .map(async (a) => {
        try {
          usage.setLimits(a.name, await probe(a.env), null);
        } catch (err) {
          // The SDK can build messages like "...exited with code N. stderr: <tail>",
          // which may contain this account's own env values (paths, tokens) — the
          // same reason launch()'s codex error path redacts before it reaches the
          // browser, for an error the user never even triggered by hand.
          usage.setLimits(a.name, null, redactAccountValue(String((err as Error).message ?? err), a));
        }
      }),
  );
}

export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  scheduler: Scheduler;
  accounts: Account[];
  /**
   * Defaults to the real provider resolution; overridable so tests can drive
   * launch() through a fake adapter instead of a real subprocess.
   *
   * This replaced a plain `adapters: { claude, codex }` pair when the Codex
   * runtime landed: choosing a Codex adapter is now an async preflight
   * (locating the binary, checking its version and login), not a lookup, so
   * the seam tests need is the whole resolution step rather than its result.
   */
  prepare?: (account: Account) => Promise<PreparedProvider>;
}): Server & { tick: () => Promise<void> } {
  const { registry, usage, scheduler, accounts, prepare = prepareProvider } = opts;
  const handles = new Map<string, AgentHandle>();

  function snapshot() {
    return {
      sessions: registry.all(),
      queue: scheduler.all(),
      settings: registry.settings(),
      accounts: accounts.map((a) => {
        const { limits, error } = usage.getLimits(a.name);
        return {
          name: a.name,
          provider: a.provider,
          budget: a.budget,
          pace: usage.pace(a.name, a.budget),
          limits,
          limitsError: error,
          load: accountLoad(usage, a),
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
    sessionId: string, account: Account, adapter: Adapter, cwd: string, prompt: string, resumeId?: string,
    promptId?: string,
  ): { error: string; code?: CodexFailureCode } | null {
    const auto = registry.get(sessionId)?.auto ?? false;
    try {
      const handle = adapter.start({ cwd, prompt, promptId, env: account.env, resumeId, auto }, (e) => {
        const safeEvent = sanitizeCodexEvent(e, account);
        if (safeEvent.type === 'usage') usage.record(account.name, safeEvent.inputTokens, safeEvent.outputTokens);
        // Claude only — the Codex SDK reports no rate-limit signal at all, which
        // is why a Codex session never auto-requeues below.
        if (safeEvent.type === 'rate-limit') {
          usage.noteLimit(account.name, safeEvent.status, safeEvent.resetsAt);
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
        const dead = handles.get(sessionId);
        handles.delete(sessionId);
        registry.apply(sessionId, safeEvent);
        // Before stop(), for the same reason apply() is: stop() re-enters this
        // callback, and by then `dead` is gone and the requeue would be skipped.
        if (shouldRequeue(
          Boolean(dead), usage.resetAt(account.name), Date.now(), registry.settings().autoRequeue,
        )) {
          scheduler.add(
            { kind: 'reset', account: account.name },
            { kind: 'resume', sessionId, prompt: 'continue' },
          );
        }
        dead?.stop();
      });
      handles.set(sessionId, handle);
      return null;
    } catch (error) {
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
      action = { kind: 'create', repo, branch, account: found.name, prompt };
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
    if (t.kind === 'reset') return { trigger: { kind: 'reset', account }, action };
    return { error: `unknown trigger: ${String(t.kind)}` };
  }

  async function command(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    switch (body.cmd) {
      case 'create': {
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
        let prepared: PreparedProvider;
        try {
          prepared = await prepare(account);
        } catch (error) {
          if (error instanceof CodexRuntimeError) {
            return {
              status: 400,
              json: { error: redactCodexText(error.message, account.env), code: error.code },
            };
          }
          throw error;
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
        });
        const prompt = String(body.prompt);
        const promptId = registry.appendPrompt(
          session.id, prompt, account.provider === 'codex' ? 'queued' : 'sent',
        );
        // Before launch, not after: launch() reads the flag back out of the
        // registry (see the `auto` local in launch), so setting it here means
        // the agent starts auto-approving rather than prompting once first.
        if (registry.settings().autoApprove) registry.setAuto(session.id, true);
        const launchError = launch(session.id, account, prepared.adapter, cwd, prompt, undefined, promptId);
        if (launchError) return { status: 500, json: launchError };
        return { status: 200, json: { id: session.id } };
      }

      case 'send': {
        const session = registry.get(String(body.id));
        const handle = handles.get(String(body.id));
        if (!session || !handle) return { status: 404, json: { error: 'no live session' } };
        const text = String(body.text);
        const promptId = registry.appendPrompt(
          session.id, text, session.provider === 'codex' ? 'queued' : 'sent',
        );
        handle.send(text, promptId);
        return { status: 200, json: { ok: true } };
      }

      case 'decide': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
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

      case 'stop': {
        // Delete first, then stop — see the emit callback in launch().
        const handle = handles.get(String(body.id));
        handles.delete(String(body.id));
        handle?.stop();
        return { status: 200, json: { ok: true } };
      }

      case 'resume': {
        const session = registry.get(String(body.id));
        if (!session) return { status: 404, json: { error: 'no such session' } };
        // Without this, resume on a live session (or a double-click on Resume)
        // calls launch(), whose handles.set() overwrites the live handle —
        // orphaning an agent that no stop() can reach while it still holds write
        // access to the worktree a second agent is now editing.
        if (session.status !== 'stopped') {
          return { status: 409, json: { error: 'session is not stopped' } };
        }
        const account = accounts.find((a) => a.name === session.account);
        if (!account) return { status: 400, json: { error: 'account no longer configured' } };
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
          prepared = await prepare(account);
        } catch (error) {
          if (error instanceof CodexRuntimeError) {
            const reason = redactCodexText(error.message, account.env);
            registry.recordStoppedFailure(session.id, reason, error.code);
            return { status: 400, json: { error: reason, code: error.code } };
          }
          throw error;
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
          session.id, account, prepared.adapter, session.cwd, prompt,
          session.vendorSessionId ?? undefined, promptId,
        );
        if (launchError) return { status: 500, json: launchError };
        return { status: 200, json: { ok: true } };
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
        const result = await mergeWorktrees(sel.repo, sel.sessions.map((s) => ({ cwd: s.cwd, branch: s.branch })));
        if (!result.ok) return { status: 409, json: { error: result.error, merged: result.merged } };
        return { status: 200, json: result };
      }

      case 'push': {
        const sel = selectedRepo(body);
        if ('error' in sel) return { status: 400, json: { error: sel.error } };
        const result = await pushRepo(sel.repo);
        if (!result.ok) return { status: 400, json: { error: result.error } };
        return { status: 200, json: result };
      }

      case 'delete': {
        const session = registry.get(String(body.id));
        const handle = handles.get(String(body.id));
        handles.delete(String(body.id));
        handle?.stop();
        if (session && body.removeWorktree) {
          await run('git', ['worktree', 'remove', '--force', session.cwd], { cwd: session.repo })
            .catch(() => rm(session.cwd, { recursive: true, force: true }));
        }
        registry.remove(String(body.id));
        return { status: 200, json: { ok: true } };
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
        registry.setSettings(parsed.patch);
        return { status: 200, json: { ok: true } };
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
      const ctx: Ctx = {
        free: (name) => {
          const a = accounts.find((x) => x.name === name);
          // An account dropped from accounts.json can never be free — its work
          // cannot run at all, and command() will say so if the item ever fires.
          return a ? usage.free(a.name, a.budget) : false;
        },
        busy: (name) => registry.all().some(
          (s) => s.account === name && (s.status === 'working' || s.status === 'needs-you'),
        ),
      };

      for (const item of scheduler.due(Date.now(), ctx)) {
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
        // Keeps proxies and sleeping laptops from dropping an idle stream.
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          unsubRegistry();
          unsubScheduler();
          clearInterval(ping);
        });
        return;
      }

      if (url.pathname === '/repos') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await recentRepos()));
        return;
      }

      if (url.pathname === '/status') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('{}'); return; }
        const status = await worktreeStatus(session.cwd).catch(() => null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      // Keyed by session id, never a path from the client: the repo to read is
      // whatever that session already runs in, so this opens no way to point
      // `git log` at a directory the user never registered.
      if (url.pathname === '/graph') {
        const id = url.searchParams.get('id') ?? '';
        const session = registry.get(id);
        if (!session) { res.writeHead(404).end('[]'); return; }
        const commits = await commitGraph(session.cwd).catch(() => []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(commits));
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
        const session = registry.get(url.searchParams.get('id') ?? '');
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
        // mkdir({recursive:true}) is a no-op if uploads already exists, and
        // writeFile follows symlinks — so a tracked symlink named uploads/ (or
        // uploads/<name>) checked out by an untrusted branch could redirect this
        // write outside the worktree. lstat (unlike stat) doesn't follow
        // symlinks, so it tells us the truth about what's actually there. A
        // missing path is fine — that's the normal new-file case — only an
        // existing symlink is refused.
        const uploadsDir = join(session.cwd, 'uploads');
        const target = join(uploadsDir, name);
        for (const p of [uploadsDir, target]) {
          const st = await lstat(p).catch(() => null);
          if (st?.isSymbolicLink()) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'refusing to follow symlink' }));
            return;
          }
        }
        await mkdir(uploadsDir, { recursive: true });
        await writeFile(target, Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: `uploads/${name}` }));
        return;
      }

      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      // Serve only the four known assets; never join user-controlled path segments.
      if (!['index.html', 'app.js', 'lib.js', 'style.css'].includes(file)) {
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

  // Exposed so tests can drive exactly one pass instead of racing a 30s timer.
  (server as Server & { tick: () => Promise<void> }).tick = tick;

  return server as Server & { tick: () => Promise<void> };
}

// Entry point: only when run directly, so tests can import createServer freely.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const statePath = new URL('../state.json', import.meta.url).pathname;
  const accounts = JSON.parse(
    await readFile(new URL('../accounts.json', import.meta.url), 'utf8'),
  ) as Account[];
  const usage = new Usage();
  const scheduler = new Scheduler();
  const registry = await Registry.load(statePath, usage, scheduler);
  // Entry point only, never inside createServer: test/server.test.ts imports
  // createServer directly, and an interval started there would leak a timer and
  // a CLI spawn into every server test.
  const REFRESH_MS = 5 * 60_000;
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;      // a slow probe must not stack up passes
    refreshing = true;
    try {
      await refreshLimits(usage, accounts);
      // Registry#notify() is what actually reaches an open browser tab (see
      // the /events push in createServer) — refreshLimits only wrote into
      // Usage, which the Registry doesn't watch. Once per pass, not per
      // account: no reason to push N snapshots for one refresh.
      registry.touch();
    } finally { refreshing = false; }
  };
  void refresh();
  // ponytail: unconditional timer — it does not check whether a browser is
  // connected. Gate it on live SSE clients if the spawns ever show up in a
  // profile.
  setInterval(() => void refresh(), REFRESH_MS).unref();
  // ponytail: env override so a second copy (a worktree, a test drive) can run
  // beside the real one instead of failing on EADDRINUSE.
  const port = Number(process.env.PORT) || 4711;
  createServer({ registry, usage, scheduler, accounts })
    .listen(port, '127.0.0.1', () => console.log(`switchboard on http://127.0.0.1:${port}`));
}
