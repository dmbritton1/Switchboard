import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { prepareCodexRuntime } from './agents/codex-runtime.ts';

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
  spawnLogin?: SpawnLogin;
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
  readonly #urlTimeoutMs: number;
  readonly #overallTimeoutMs: number;

  constructor(options: LinkerOptions) {
    this.#root = options.accountsRoot;
    this.#spawn = options.spawnLogin;
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

  async start(provider: LinkProvider): Promise<{ error?: string }> {
    if (this.#pending) return { error: 'a link is already in progress' };
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
      void this.#fail('The sign-in command did not print a sign-in URL.');
    }, this.#urlTimeoutMs);
    pending.overallTimer = setTimeout(() => {
      void this.#fail('The sign-in timed out. Start it again when you are ready.');
    }, this.#overallTimeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onOutput(chunk, true));
    child.stderr?.on('data', (chunk: string) => this.#onOutput(chunk, false));
    child.on('error', (error) => { void this.#fail(this.redact(String(error.message))); });
    child.on('close', (code) => this.#onClose(code));

    this.#notify();
    return {};
  }

  #onOutput(chunk: string, isStdout: boolean): void {
    const p = this.#pending;
    if (!p) return;
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

  /** Overridden in Task 5 to run identity readback. Here it only marks the
   *  terminal phases so the state machine is observable. */
  #onClose(code: number | null): void {
    const p = this.#pending;
    if (!p || p.settled) return;
    if (code === 0) {
      // The login succeeded and staging now holds real credentials — the
      // overall timer must not be left running to later `rm` them out from
      // under a link that already finished.
      this.#clearTimers(p);
      p.phase = 'verifying';
      this.#notify();
      return;
    }
    void this.#fail(this.redact(`The sign-in command exited with code ${code}.`));
  }

  /** Removes any value that could identify the staging directory before text
   *  reaches the browser. */
  redact(text: string): string {
    const staging = this.#pending?.staging;
    return staging ? text.split(staging).join('[credential dir]') : text;
  }

  async #fail(message: string): Promise<void> {
    const p = this.#pending;
    if (!p || p.settled) return;
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
}
