import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir, rm, stat, lstat, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { Registry } from './sessions.ts';
import { Usage } from './usage.ts';
import { commitGraph, createWorktree, worktreeStatus } from './worktree.ts';
import { mergeWorktrees, pushRepo } from './merge.ts';
import { claudeAdapter } from './agents/claude.ts';
import { createCodexAdapter } from './agents/codex.ts';
import { validateCodexSettings } from './agents/codex-settings.ts';
import { resolveAgentPrompt } from './prompt-input.ts';
import {
  CodexRuntimeError, prepareCodexRuntime, redactCodexText, redactable,
} from './agents/codex-runtime.ts';
import type {
  Adapter, AdapterEvent, AgentHandle, AgentPrompt, CodexFailureCode, CodexThreadSettings, Session,
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

export function createServer(opts: {
  registry: Registry;
  usage: Usage;
  accounts: Account[];
  resolvePrompt?: typeof resolveAgentPrompt;
}): Server {
  const { registry, usage, accounts, resolvePrompt = resolveAgentPrompt } = opts;
  const handles = new Map<string, AgentHandle>();

  function snapshot() {
    return {
      sessions: registry.publicSessions(),
      accounts: accounts.map((a) => ({
        name: a.name,
        provider: a.provider,
        budget: a.budget,
        pace: usage.pace(a.name, a.budget),
      })),
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
    try {
      const handle = adapter.start({ cwd, prompt, promptId, env: account.env, resumeId, auto, codexSettings }, (e) => {
        const safeEvent = sanitizeCodexEvent(e, account);
        if (safeEvent.type === 'usage') {
          // Optional Codex breakdowns are informational subsets, not account pace.
          const { inputTokens, outputTokens } = safeEvent;
          usage.record(account.name, inputTokens, outputTokens);
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
        let prepared: PreparedProvider;
        try {
          prepared = await prepareProvider(account);
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
          ...(codexSettings ? { codexSettings } : {}),
        });
        const prompt = String(body.prompt);
        const promptId = registry.appendPrompt(
          session.id, prompt, account.provider === 'codex' ? 'queued' : 'sent',
        );
        const launchError = launch(
          session.id, account, prepared.adapter, cwd, { text: prompt, attachments: [] }, undefined, promptId,
        );
        if (launchError) return { status: 500, json: launchError };
        return { status: 200, json: { id: session.id } };
      }

      case 'send': {
        const sessionId = String(body.id);
        const session = registry.get(sessionId);
        const handle = handles.get(sessionId);
        if (!session || !handle) return { status: 404, json: { error: 'no live session' } };
        const text = String(body.text);
        let prompt: AgentPrompt;
        try {
          prompt = await resolvePrompt(session.cwd, text, body.attachments);
        } catch (error) {
          return { status: 400, json: { error: String((error as Error).message ?? error) } };
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

      case 'decide': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        handle.decide(Boolean(body.allow));
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
          prepared = await prepareProvider(account);
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
          session.id, account, prepared.adapter, session.cwd, { text: prompt, attachments: [] },
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

      default:
        return { status: 400, json: { error: `unknown cmd: ${String(body.cmd)}` } };
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
        const unsub = registry.subscribe(push);
        // Keeps proxies and sleeping laptops from dropping an idle stream.
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => { unsub(); clearInterval(ping); });
        return;
      }

      if (url.pathname === '/repos') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(await recentRepos()));
        return;
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
  // unref()'d rather than flushed on close: the timer must never be the reason
  // the process stays alive (it would also hold test runs open for 2s each, and
  // fire a write into an already-deleted temp dir), while the server handle keeps
  // the loop alive for as long as saving actually matters. Cleared on 'close' too
  // so a closed server can't write after its state dir is gone.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubSave = registry.subscribe(() => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void registry.save().catch(() => {});
    }, 2000).unref();
  });
  server.on('close', () => {
    unsubSave();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  });

  return server;
}

// Entry point: only when run directly, so tests can import createServer freely.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const statePath = new URL('../state.json', import.meta.url).pathname;
  const accounts = JSON.parse(
    await readFile(new URL('../accounts.json', import.meta.url), 'utf8'),
  ) as Account[];
  const usage = new Usage();
  const registry = await Registry.load(statePath, usage);
  // ponytail: env override so a second copy (a worktree, a test drive) can run
  // beside the real one instead of failing on EADDRINUSE.
  const port = Number(process.env.PORT) || 4711;
  createServer({ registry, usage, accounts })
    .listen(port, '127.0.0.1', () => console.log(`switchboard on http://127.0.0.1:${port}`));
}
