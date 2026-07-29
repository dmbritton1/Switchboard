import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { Registry } from './sessions.ts';
import { Usage } from './usage.ts';
import { createWorktree, worktreeStatus } from './worktree.ts';
import { claudeAdapter } from './agents/claude.ts';
import { codexAdapter } from './agents/codex.ts';
import type { AgentHandle } from './types.ts';

const run = promisify(execFile);

export type Account = {
  name: string;
  provider: 'claude' | 'codex';
  budget: number;
  env: Record<string, string>;
};

const WEB = new URL('../web/', import.meta.url).pathname;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

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
  statePath: string;
}): Server {
  const { registry, usage, accounts } = opts;
  const handles = new Map<string, AgentHandle>();

  function snapshot() {
    return {
      sessions: registry.all(),
      accounts: accounts.map((a) => ({
        name: a.name,
        provider: a.provider,
        pace: usage.pace(a.name, a.budget),
      })),
    };
  }

  function launch(sessionId: string, account: Account, cwd: string, prompt: string, resumeId?: string): void {
    const adapter = account.provider === 'claude' ? claudeAdapter : codexAdapter;
    const handle = adapter.start({ cwd, prompt, env: account.env, resumeId }, (e) => {
      if (e.type === 'usage') usage.record(account.name, e.inputTokens, e.outputTokens);
      registry.apply(sessionId, e);
    });
    handles.set(sessionId, handle);
  }

  async function command(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    switch (body.cmd) {
      case 'create': {
        const account = accounts.find((a) => a.name === body.account);
        if (!account) return { status: 400, json: { error: `unknown account: ${body.account}` } };
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
        launch(session.id, account, cwd, String(body.prompt));
        return { status: 200, json: { id: session.id } };
      }

      case 'send': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        registry.apply(String(body.id), {
          type: 'msg', msg: { kind: 'user', text: String(body.text) },
        });
        handle.send(String(body.text));
        return { status: 200, json: { ok: true } };
      }

      case 'decide': {
        const handle = handles.get(String(body.id));
        if (!handle) return { status: 404, json: { error: 'no live session' } };
        handle.decide(Boolean(body.allow));
        return { status: 200, json: { ok: true } };
      }

      case 'stop': {
        handles.get(String(body.id))?.stop();
        handles.delete(String(body.id));
        return { status: 200, json: { ok: true } };
      }

      case 'resume': {
        const session = registry.get(String(body.id));
        if (!session) return { status: 404, json: { error: 'no such session' } };
        const account = accounts.find((a) => a.name === session.account);
        if (!account) return { status: 400, json: { error: 'account no longer configured' } };
        session.status = 'working';
        session.stoppedReason = null;
        launch(
          session.id, account, session.cwd, String(body.prompt ?? 'continue'),
          session.vendorSessionId ?? undefined,
        );
        return { status: 200, json: { ok: true } };
      }

      case 'delete': {
        const session = registry.get(String(body.id));
        handles.get(String(body.id))?.stop();
        handles.delete(String(body.id));
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

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

    if (url.pathname === '/status') {
      const id = url.searchParams.get('id') ?? '';
      const session = registry.get(id);
      if (!session) { res.writeHead(404).end('{}'); return; }
      const status = await worktreeStatus(session.cwd).catch(() => null);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      // Origin guard: the server binds loopback only, but loopback binding does not
      // stop CSRF. Any page open in the user's browser — including a malicious one
      // on the open internet — can issue a same-network POST to 127.0.0.1:4711;
      // browsers don't preflight a simple POST like the ones this UI sends, so the
      // request reaches us and its side effects (worktree creation, process launch,
      // directory deletion) run before any CORS check would block the attacker from
      // reading the response. The attacker doesn't need to read the response to do
      // damage. Browsers attach `Origin` on cross-origin requests; our own same-origin
      // page also sends it. Non-browser clients (curl, scripts, this file's own tests)
      // typically send no Origin header at all, so we only reject a *mismatched* one —
      // this blocks the drive-by case without breaking local tooling.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
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

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Serve only the three known assets; never join user-controlled path segments.
    if (!['index.html', 'app.js', 'style.css'].includes(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] });
    res.end(await readFile(join(WEB, file)));
  });

  return server;
}

// Entry point: only when run directly, so tests can import createServer freely.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const statePath = new URL('../state.json', import.meta.url).pathname;
  const accounts = JSON.parse(
    await readFile(new URL('../accounts.json', import.meta.url), 'utf8'),
  ) as Account[];
  const registry = await Registry.load(statePath);
  const usage = new Usage();
  createServer({ registry, usage, accounts, statePath })
    .listen(4711, '127.0.0.1', () => console.log('switchboard on http://127.0.0.1:4711'));
}
