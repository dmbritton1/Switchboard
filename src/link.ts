import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, rename, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareCodexRuntime } from './agents/codex-runtime.ts';
import { DEFAULT_BUDGET, validateAccountName, type Account } from './accounts.ts';

const runFile = promisify(execFile);

export type LinkProvider = 'claude' | 'codex';
export type LinkPhase = 'starting' | 'awaiting-user' | 'verifying' | 'naming' | 'error';
export type LinkIdentity = { email: string; subscription: string | null };

export type PublicLink = {
  provider: LinkProvider;
  phase: LinkPhase;
  url: string | null;
  codeRequested: boolean;
  identity: LinkIdentity | null;
  suggestedName: string | null;
  error: string | null;
};

export type SpawnLogin = (provider: LinkProvider, env: Record<string, string>) => ChildProcess;

export type LinkerOptions = {
  accountsRoot: string;
  /** Read at commit and suggest time, not captured at construction: the array
   *  is mutated in place as accounts are linked and unlinked. */
  accounts: () => readonly Account[];
  spawnLogin?: SpawnLogin;
  /** The `claude` binary to run for identity readback. Defaults to the bare
   *  name resolved from PATH; tests point this at a fake CLI so no real
   *  `claude` process is ever spawned. */
  claudeBin?: string;
  urlTimeoutMs?: number;
  overallTimeoutMs?: number;
};

/**
 * Anchored to the two hosts the real CLIs were measured using. A bare
 * `https://\S+` would let a stray URL in an update notice or a warning hijack
 * the flow, and the thing it would hijack is where we send the user to type
 * their password.
 */
const AUTH_URL = /https:\/\/(?:claude\.com|auth\.openai\.com)\/\S*oauth\S*/;

/** The Claude CLI's own prompt. Detected rather than assumed from the provider:
 *  it hedges with "if prompted", so the branch where it completes without
 *  asking is real, and discovering the prompt handles both with no special
 *  case. */
const CODE_PROMPT = /Paste code here/;

const MAX_OUTPUT_TAIL = 8 * 1024;

export const CREDENTIAL_ENV: Record<LinkProvider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/** A bounded, whitespace-collapsed tail of child output, for error messages
 *  only. Mirrors detailSuffix() in agents/codex-runtime.ts. */
function tailSuffix(tail: string): string {
  const safe = tail.replace(/\s+/g, ' ').trim();
  return safe ? ` ${safe.slice(-400)}` : '';
}

function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    // Decoded, never verified: this labels a file we just wrote, it does
    // not authenticate a request. Only `email` is read.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
      { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

/**
 * Who was just linked, or null when the provider exposes nobody.
 *
 * Null is not an error: a Codex auth.json can hold an API key with no
 * id_token, and a Console-authenticated Claude account reports no email. The
 * credentials are still valid, which is what matters — the caller falls back to
 * a numbered name and skips the duplicate check.
 */
export async function readIdentity(
  provider: LinkProvider,
  dir: string,
  claudeBin: string,
): Promise<LinkIdentity | null> {
  if (provider === 'codex') {
    try {
      const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as
        { tokens?: { id_token?: unknown } };
      const email = emailFromIdToken(auth.tokens?.id_token);
      // Codex has no equivalent of subscriptionType, at any auth mode.
      return email ? { email, subscription: null } : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await runFile(claudeBin, ['auth', 'status', '--json'], {
      env: { ...process.env, [CREDENTIAL_ENV.claude]: dir },
    });
    const status = JSON.parse(stdout) as { email?: unknown; subscriptionType?: unknown };
    if (typeof status.email !== 'string') return null;
    return {
      email: status.email,
      subscription: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/** `dwight@example.com` on claude becomes `claude-dwight`. Falls back to the
 *  bare provider, then a numeric suffix, when there is no identity to derive
 *  from or the derived name is taken. */
export function suggestName(
  provider: LinkProvider,
  identity: LinkIdentity | null,
  existing: readonly { name: string }[],
): string {
  const local = identity?.email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? '';
  const base = local ? `${provider}-${local}`.slice(0, 32) : provider;
  const taken = new Set(existing.map((a) => a.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 32);
}

async function defaultSpawnLogin(
  provider: LinkProvider,
  env: Record<string, string>,
): Promise<ChildProcess> {
  if (provider === 'claude') {
    return spawn('claude', ['auth', 'login'], { env: { ...process.env, ...env } });
  }
  // requireAuth: false — this runs against the fresh, empty CODEX_HOME the link
  // is about to populate, where the usual `login status` preflight would always
  // fail. Version and executability checks still run.
  const runtime = await prepareCodexRuntime({ env }, { requireAuth: false });
  return spawn(runtime.commandPath, ['login'], { env: { ...process.env, ...env } });
}

type Pending = {
  provider: LinkProvider;
  phase: LinkPhase;
  url: string | null;
  codeRequested: boolean;
  identity: LinkIdentity | null;
  suggestedName: string | null;
  error: string | null;
  staging: string;
  child: ChildProcess;
  tail: string;
  urlTimer: ReturnType<typeof setTimeout> | null;
  overallTimer: ReturnType<typeof setTimeout> | null;
  /** True once #fail has committed a terminal error state. Guards #onClose
   *  and #fail against re-entry: SIGTERM from a first #fail() reliably
   *  produces a later 'close' event, which must not overwrite the specific
   *  error message with a generic exit-code one or fire a second notify. */
  settled: boolean;
};

export class Linker {
  #subs = new Set<() => void>();
  #pending: Pending | null = null;
  readonly #root: string;
  readonly #spawn: SpawnLogin | undefined;
  readonly #accounts: () => readonly Account[];
  readonly #claudeBin: string;
  readonly #urlTimeoutMs: number;
  readonly #overallTimeoutMs: number;

  constructor(options: LinkerOptions) {
    this.#root = options.accountsRoot;
    this.#spawn = options.spawnLogin;
    this.#accounts = options.accounts;
    this.#claudeBin = options.claudeBin ?? 'claude';
    this.#urlTimeoutMs = options.urlTimeoutMs ?? 30_000;
    this.#overallTimeoutMs = options.overallTimeoutMs ?? 300_000;
  }

  // Mirrors Registry's and Scheduler's #subs/#notify exactly: same shape, so
  // the /events route can treat all three sources the same way.
  subscribe(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  #notify(): void {
    for (const fn of this.#subs) fn();
  }

  /** Never exposes the staging path, the child's pid, or raw child output —
   *  the staging path becomes an account env value, which must never reach the
   *  browser. */
  snapshot(): PublicLink | null {
    const p = this.#pending;
    if (!p) return null;
    return {
      provider: p.provider, phase: p.phase, url: p.url,
      codeRequested: p.codeRequested, identity: p.identity,
      suggestedName: p.suggestedName, error: p.error,
    };
  }

  /** The credential dir for the in-flight link. Server-side only. */
  stagingDir(): string | null {
    return this.#pending?.staging ?? null;
  }

  get root(): string {
    return this.#root;
  }

  /** The `claude` binary this Linker was configured with — tests point it at
   *  a fake CLI. Reused for logout so unlink never spawns a real binary that
   *  the login flow itself was careful to avoid. */
  get claudeBin(): string {
    return this.#claudeBin;
  }

  async start(provider: LinkProvider): Promise<{ error?: string }> {
    // A settled pending (phase: 'error') is done — #fail already killed its
    // child, cleared its timers and removed its staging dir. Refusing here
    // too would permanently lock out linking after the first failure, since
    // nothing else ever clears #pending in that phase.
    if (this.#pending && !this.#pending.settled) {
      return { error: 'a link is already in progress' };
    }
    if (provider !== 'claude' && provider !== 'codex') return { error: 'unknown provider' };

    await mkdir(this.#root, { recursive: true });
    const staging = await mkdtemp(join(this.#root, `.pending-${randomUUID().slice(0, 8)}-`));
    const env = { [CREDENTIAL_ENV[provider]]: staging };

    let child: ChildProcess;
    try {
      child = this.#spawn ? this.#spawn(provider, env) : await defaultSpawnLogin(provider, env);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // Redact against the local `staging` var, not the (not-yet-set)
      // #pending — and not the upstream env-key redactor, which only
      // catches keys matching /token|key|secret|password|.../ and would
      // never flag CODEX_HOME/CLAUDE_CONFIG_DIR.
      const message = String((error as Error).message ?? error);
      return { error: message.split(staging).join('[credential dir]') };
    }

    const pending: Pending = {
      provider, phase: 'starting', url: null, codeRequested: false,
      identity: null, suggestedName: null, error: null,
      staging, child, tail: '', urlTimer: null, overallTimer: null, settled: false,
    };
    this.#pending = pending;

    pending.urlTimer = setTimeout(() => {
      void this.#fail(pending, 'The sign-in command did not print a sign-in URL.');
    }, this.#urlTimeoutMs);
    pending.overallTimer = setTimeout(() => {
      void this.#fail(pending, 'The sign-in timed out. Start it again when you are ready.');
    }, this.#overallTimeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // Each listener closes over `pending`, the object this child belongs to
    // — not `this.#pending`, which may already point at a different link by
    // the time a late event from this child arrives (e.g. after cancel()
    // + a new start()). #onOutput/#onClose bail unless `pending` is still
    // the live one, matching the guard #verify already has.
    child.stdout?.on('data', (chunk: string) => this.#onOutput(pending, chunk, true));
    child.stderr?.on('data', (chunk: string) => this.#onOutput(pending, chunk, false));
    child.on('error', (error) => { void this.#fail(pending, this.redact(String(error.message))); });
    child.on('close', (code) => this.#onClose(pending, code));

    this.#notify();
    return {};
  }

  #onOutput(pending: Pending, chunk: string, isStdout: boolean): void {
    if (this.#pending !== pending) return;   // a stale event from a since-replaced link
    const p = pending;
    p.tail = (p.tail + chunk).slice(-MAX_OUTPUT_TAIL);

    let changed = false;
    // Matched against the accumulated tail, not the raw chunk: a real CLI's
    // spinner/redraw output can split a URL or the prompt across two writes,
    // which the fake CLI (one write per line) can never exercise but a real
    // binary can.
    if (!p.url) {
      const match = AUTH_URL.exec(p.tail);
      if (match) {
        p.url = match[0];
        p.phase = 'awaiting-user';
        if (p.urlTimer) { clearTimeout(p.urlTimer); p.urlTimer = null; }
        changed = true;
      }
    }
    // Only stdout carries the prompt, and only Claude emits one.
    if (isStdout && !p.codeRequested && CODE_PROMPT.test(p.tail)) {
      p.codeRequested = true;
      changed = true;
    }
    if (changed) this.#notify();
  }

  submitCode(code: string): { error?: string } {
    const p = this.#pending;
    if (!p || p.phase !== 'awaiting-user' || !p.codeRequested) {
      return { error: 'the sign-in is not waiting for a code' };
    }
    if (typeof code !== 'string' || !code.trim()) return { error: 'code is required' };
    // Straight to the child's stdin and nowhere else: never stored on the
    // pending link, never logged, never in snapshot().
    p.child.stdin?.write(`${code.trim()}\n`);
    return {};
  }

  #onClose(pending: Pending, code: number | null): void {
    // "is there a pending" is not enough — a stale close from a link that
    // was cancelled and replaced must not touch the new one (see #onOutput).
    if (this.#pending !== pending || pending.settled) return;
    const p = pending;
    if (code === 0) {
      // The login succeeded and staging now holds real credentials — the
      // overall timer must not be left running to later `rm` them out from
      // under a link that already finished.
      this.#clearTimers(p);
      p.phase = 'verifying';
      // A prompt still on screen must go away: the child is done either way.
      p.codeRequested = false;
      this.#notify();
      void this.#verify(p);
      return;
    }
    void this.#fail(p, this.redact(
      `The sign-in command exited with code ${code}.${tailSuffix(this.redact(p.tail))}`,
    ));
  }

  async #verify(p: Pending): Promise<void> {
    const identity = await readIdentity(p.provider, p.staging, this.#claudeBin);
    if (this.#pending !== p) return;   // cancelled while readback was running
    if (identity) {
      const clash = this.#accounts().find(
        (a) => a.provider === p.provider && a.identity === identity.email,
      );
      if (clash) {
        await this.#fail(p, this.redact(`That account is already linked as ${clash.name}.`));
        return;
      }
    }
    this.#clearTimers(p);
    p.identity = identity;
    p.suggestedName = suggestName(p.provider, identity, this.#accounts());
    p.phase = 'naming';
    this.#notify();
  }

  /** Removes any value that could identify the staging directory before text
   *  reaches the browser. */
  redact(text: string): string {
    const staging = this.#pending?.staging;
    return staging ? text.split(staging).join('[credential dir]') : text;
  }

  async #fail(pending: Pending, message: string): Promise<void> {
    // Same "is it still mine" guard as #onClose/#onOutput: a timer or error
    // event fired against a link this instance has already moved past
    // (cancelled, replaced, or already settled) must be a no-op.
    if (this.#pending !== pending || pending.settled) return;
    const p = pending;
    // Set before the await below so a concurrent re-entry (e.g. the 'close'
    // event this SIGTERM is about to produce) sees settled=true immediately,
    // not just after the rm() completes.
    p.settled = true;
    this.#clearTimers(p);
    p.child.kill('SIGTERM');
    await rm(p.staging, { recursive: true, force: true });
    p.phase = 'error';
    p.error = message;
    p.url = null;
    this.#notify();
  }

  #clearTimers(p: Pending): void {
    if (p.urlTimer) { clearTimeout(p.urlTimer); p.urlTimer = null; }
    if (p.overallTimer) { clearTimeout(p.overallTimer); p.overallTimer = null; }
  }

  async cancel(): Promise<void> {
    const p = this.#pending;
    if (!p) return;
    this.#clearTimers(p);
    p.child.kill('SIGTERM');
    this.#pending = null;
    await rm(p.staging, { recursive: true, force: true });
    this.#notify();
  }

  /**
   * Renames the staging dir into place and returns the account entry. Does NOT
   * write accounts.json — the server owns that, so this class never needs to
   * know where the file lives.
   *
   * Rename first, persist second: a failed write then leaves an orphan
   * directory, which is harmless, rather than an account entry pointing at a
   * directory that does not exist.
   */
  async commit(name: string): Promise<{ account?: Account; error?: string }> {
    const p = this.#pending;
    if (!p) return { error: 'no link is in progress' };
    if (p.phase !== 'naming') return { error: 'the sign-in is not ready to be named' };

    const invalid = validateAccountName(name, [...this.#accounts()]);
    if (invalid) return { error: invalid };

    const target = join(this.#root, name);
    try {
      await rename(p.staging, target);
    } catch {
      // Node's rename error names BOTH ends — including `target`, which is
      // about to become this account's CLAUDE_CONFIG_DIR/CODEX_HOME. Redacting
      // only `p.staging` (as start()'s catch does, correctly, for a path that
      // never becomes a live credential dir) would still leak `target` here.
      // The OS message carries no information the browser can act on beyond
      // "try a different name" anyway, so it is dropped entirely rather than
      // partially redacted.
      return {
        error: 'could not move the credential directory into place — a directory with '
          + 'that name may already exist. Try another name.',
      };
    }

    const account: Account = {
      name,
      provider: p.provider,
      budget: DEFAULT_BUDGET,
      env: { [CREDENTIAL_ENV[p.provider]]: target },
      ...(p.identity ? { identity: p.identity.email } : {}),
    };

    this.#clearTimers(p);
    this.#pending = null;
    this.#notify();
    return { account };
  }

  /**
   * Removes staging dirs left by a crash or a kill. Deliberately narrow: only
   * `.pending-*` entries. A sweep that deleted any unrecognised directory under
   * the accounts root would eat real credentials after an unrelated bug.
   *
   * Also excludes the currently active staging dir, if any — a live link's
   * credentials must survive a sweep regardless of when the caller invokes
   * it, not merely because callers today only call this at boot.
   */
  async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return;
    }
    const active = this.#pending?.staging;
    await Promise.all(entries
      .filter((entry) => entry.startsWith('.pending-') && join(this.#root, entry) !== active)
      .map((entry) => rm(join(this.#root, entry), { recursive: true, force: true })));
  }
}
