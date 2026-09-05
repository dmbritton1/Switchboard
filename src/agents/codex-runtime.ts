import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { CodexFailureCode } from '../types.ts';

const VERSION = /\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
const CREDENTIAL_KEY = /(token|key|secret|password|authorization|credential)/i;
/**
 * Shortest account environment value worth substituting out of public text. A
 * value is redacted by searching for it in unrelated output, so a short one is
 * a shredder rather than a guard: `RUST_LOG=info` or `CODEX_DEBUG=1` would turn
 * `--grep info 1 file changed` into `--grep [REDACTED] [REDACTED] file changed`.
 * Nothing a credential store issues is this short, so the floor costs no real
 * protection.
 */
const MIN_REDACTABLE = 6;
const FILE_URI_CANDIDATE = /\b(?=(file:[^\s"`<>{}\[\]“”‘’]+))/giu;
const FILE_URI_TRAILING_PROSE = /[.,;:!?]/u;
// Ignore only an unambiguous leading URI delimiter: a qualified authority or
// an opaque namespace. A one-letter namespace before `:/` is a Windows drive.
const OPAQUE_URI_PREFIX = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/(?=[^/\\\s]*\.)|[A-Za-z][A-Za-z0-9+.-]*:(?![A-Za-z]:\/)[^:/\\\s]+:\/)/u;

export function redactable(value: string): boolean {
  return typeof value === 'string' && value.length >= MIN_REDACTABLE;
}

function absoluteFileTarget(target: string): boolean {
  return /^(?:\/|\\|%2f|%5c)/i.test(target)
    || /^[A-Za-z](?::|%3a)(?:\/|\\|%2f|%5c)/i.test(target);
}

function absoluteFileUriEnd(token: string, offset: number, source: string): number | null {
  let uriEnd = token.length;
  while (uriEnd > 'file:'.length && FILE_URI_TRAILING_PROSE.test(token[uriEnd - 1]!)) uriEnd -= 1;
  if (source[offset - 1] === '(' && token[uriEnd - 1] === ')') uriEnd -= 1;
  const target = token.slice('file:'.length, uriEnd);
  return absoluteFileTarget(target) ? uriEnd : null;
}

function* absoluteFileUris(source: string): Generator<{ start: number; end: number }> {
  for (const match of source.matchAll(FILE_URI_CANDIDATE)) {
    const token = match[1]!;
    const uriEnd = absoluteFileUriEnd(token, match.index, source);
    if (uriEnd !== null) yield { start: match.index, end: match.index + uriEnd };
  }
}

export function containsAbsoluteFileUri(value: string): boolean {
  for (const _uri of absoluteFileUris(value)) return true;
  return false;
}

/** Admission check only: never rewrite an opaque identifier into another ID. */
export function unsafeCodexProviderIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const scanFrom = value.match(OPAQUE_URI_PREFIX)?.[0].length ?? 0;
  return containsAbsoluteFileUri(value)
    || /(?:^|[^\p{L}\p{N}_./\\-])(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value.slice(scanFrom));
}

function redactAbsoluteFileUris(value: string): string {
  let safe = '';
  let offset = 0;
  for (const uri of absoluteFileUris(value)) {
    if (uri.start < offset) continue;
    safe += `${value.slice(offset, uri.start)}[path omitted]`;
    offset = uri.end;
  }
  return safe + value.slice(offset);
}
const CHATGPT_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);
const run = promisify(execFile);

export type CodexRuntimeSource = 'explicit' | 'chatgpt' | 'sdk';

export type PreparedCodexRuntime = {
  source: CodexRuntimeSource;
  commandPath: string;
  codexPathOverride?: string;
  version: string;
  env: Record<string, string>;
  diagnostics: string[];
};

export class CodexRuntimeError extends Error {
  readonly code: CodexFailureCode;

  constructor(
    code: CodexFailureCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'CodexRuntimeError';
  }
}

export type CodexRuntimeDeps = {
  platform?: NodeJS.Platform;
  chatgptPath?: string;
  bundledPath?: string;
  sdkVersion?: string;
  preflightTimeoutMs?: number;
  /** Skip the `login status` preflight. Account linking sets this false: it
   *  runs against a fresh, empty credential dir, where an auth check would
   *  always fail on the one path that exists to create those credentials.
   *  Version and executability checks still run. */
  requireAuth?: boolean;
  runFile?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string }>;
};

type AccountConfig = { bin?: string; env: Record<string, string> };
type CommandOutput = { stdout: string; stderr: string };

class CodexPreflightTimeoutError extends Error {}

function publishedVersion(version: string): string {
  return version.split('+', 1)[0];
}

function parseVersion(output: string): string | null {
  return output.match(VERSION)?.[1] ?? null;
}

/**
 * Longest value first, deduplicated. Replacing a short value before a longer one
 * that contains it leaves the rest of the longer value standing: with
 * `A=secret` and `B=secretlonger`, insertion order rewrites `secretlonger` to
 * `[REDACTED]longer` and publishes the suffix of B. Every redaction path routes
 * through here so no caller can reintroduce the ordering.
 */
export function redactValues(text: string, values: Iterable<string>): string {
  let safe = redactAbsoluteFileUris(text);
  safe = safe.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  const ordered = [...new Set(values)].filter(redactable).sort((a, b) => b.length - a.length);
  for (const value of ordered) safe = safe.replaceAll(value, '[REDACTED]');
  return safe;
}

export function redactCodexText(text: string, env: Record<string, string>): string {
  return redactValues(text, Object.entries(env)
    .filter(([key]) => CREDENTIAL_KEY.test(key))
    .map(([, value]) => value));
}

function validateAccount(account: unknown): AccountConfig {
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new CodexRuntimeError('codex_start_failed', 'Codex account configuration is invalid.');
  }
  const { bin, env } = account as { bin?: unknown; env?: unknown };
  if ((bin !== undefined && (typeof bin !== 'string' || bin.length === 0))
    || !env || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some((value) => typeof value !== 'string')) {
    throw new CodexRuntimeError('codex_start_failed', 'Codex account configuration is invalid.');
  }
  return { bin, env: env as Record<string, string> };
}

async function defaultSdkVersion(): Promise<string> {
  let pkg: { version?: unknown };
  try {
    const packageJson = new URL('../package.json', import.meta.resolve('@openai/codex-sdk'));
    pkg = JSON.parse(await readFile(packageJson, 'utf8')) as { version?: unknown };
  } catch {
    throw new CodexRuntimeError('codex_start_failed', 'Installed Codex SDK version is unavailable.');
  }
  if (typeof pkg.version !== 'string') {
    throw new CodexRuntimeError('codex_start_failed', 'Installed Codex SDK version is unavailable.');
  }
  return pkg.version;
}

function defaultBundledPath(): string {
  return require.resolve('@openai/codex/bin/codex.js');
}

/**
 * The redacted tail of whatever the candidate actually said, appended to a
 * public message. Without it, every unreadable-version cause — a wrapper that
 * prints nothing, a first-run OS verification that kills the process, a fork
 * that fails under load — arrives as the same "Reinstall or update Codex" for
 * a CLI that may run fine on the next attempt, and there is nowhere else to
 * look: this output is never persisted.
 */
function detailSuffix(raw: string, env: Record<string, string>): string {
  const safe = redactCodexText(raw, env).replace(/\s+/g, ' ').trim();
  if (!safe) return '';
  return ` It reported: ${safe.length > 200 ? `${safe.slice(0, 200)}…` : safe}`;
}

function outputFrom(error: unknown): CommandOutput {
  if (!error || typeof error !== 'object') return { stdout: '', stderr: '' };
  const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: typeof stderr === 'string' ? stderr : '',
  };
}

async function defaultRunFile(
  file: string,
  args: string[],
  options: { env: Record<string, string>; signal?: AbortSignal },
): Promise<CommandOutput> {
  const result = await run(file, args, { env: options.env, signal: options.signal });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runPreflightFile(
  runFile: NonNullable<CodexRuntimeDeps['runFile']>,
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<CommandOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexPreflightTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      runFile(file, args, { env, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertCandidateFile(path: string, source: 'explicit' | 'chatgpt' | 'sdk'): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    throw new CodexRuntimeError(
      'codex_binary_missing',
      source === 'explicit'
        ? `Codex executable was not found at ${path}. Update this account's bin setting.`
        : `Codex SDK command was not found at ${path}. Reinstall @openai/codex-sdk.`,
    );
  }
  if (!info.isFile() || ((source === 'explicit' || source === 'chatgpt') && (info.mode & 0o111) === 0)) {
    throw new CodexRuntimeError(
      'codex_binary_not_executable',
      source === 'explicit'
        ? `Codex executable at ${path} is not an executable file. Update this account's bin setting.`
        : `Codex command at ${path} is not an executable file. Reinstall Codex.`,
    );
  }
}

async function readCompatibleVersion(
  path: string,
  source: 'explicit' | 'chatgpt' | 'sdk',
  sdkVersion: string,
  env: Record<string, string>,
  runFile: NonNullable<CodexRuntimeDeps['runFile']>,
): Promise<string> {
  let result: CommandOutput;
  try {
    result = await runFile(path, ['--version'], { env });
  } catch (error) {
    if (error instanceof CodexPreflightTimeoutError) {
      throw new CodexRuntimeError(
        'codex_version_unreadable',
        `Codex version check timed out at ${path}. Check that the executable starts normally and try again.`,
      );
    }
    const output = outputFrom(error);
    throw new CodexRuntimeError(
      'codex_version_unreadable',
      `Codex version could not be read from ${path}. Reinstall or update Codex.${
        detailSuffix(`${(error as Error)?.message ?? ''}\n${output.stdout}\n${output.stderr}`, env)}`,
    );
  }
  const combined = redactCodexText(`${result.stdout}\n${result.stderr}`, env);
  const version = parseVersion(combined);
  if (!version) {
    throw new CodexRuntimeError(
      'codex_version_unreadable',
      `Codex version could not be read from ${path}. Reinstall or update Codex.${detailSuffix(combined, env)}`,
    );
  }
  if (publishedVersion(version) !== publishedVersion(sdkVersion)) {
    throw new CodexRuntimeError(
      'codex_version_mismatch',
      `Codex at ${path} reports version ${version}, but the installed SDK requires ${sdkVersion}.`,
    );
  }
  return version;
}

async function assertAuthentication(
  path: string,
  env: Record<string, string>,
  diagnostics: string[],
  runFile: NonNullable<CodexRuntimeDeps['runFile']>,
): Promise<void> {
  try {
    await runFile(path, ['login', 'status'], { env });
  } catch (error) {
    if (error instanceof CodexPreflightTimeoutError) {
      throw new CodexRuntimeError(
        'codex_auth_unavailable',
        `Codex authentication check timed out at ${path}. Run ${path} login status and try again.`,
      );
    }
    const { stdout, stderr } = outputFrom(error);
    const output = redactCodexText(`${stdout}\n${stderr}`, env);
    const unsupported = /unrecognized subcommand|unknown subcommand|unexpected argument.*status/i;
    const loggedOut = /not logged in|login required|authentication required|unauthorized/i;
    if (unsupported.test(output)) {
      diagnostics.push(`Codex login status is unsupported at ${path}; authentication will be checked when Codex starts.`);
      return;
    }
    if (loggedOut.test(output)) {
      throw new CodexRuntimeError(
        'codex_auth_unavailable',
        `Codex authentication is unavailable. Run ${path} login and try again.`,
      );
    }
    throw new CodexRuntimeError(
      'codex_auth_unavailable',
      `Codex authentication could not be verified. Run ${path} login and try again.`,
    );
  }
}

async function prepareCandidate(
  path: string,
  source: 'explicit' | 'chatgpt' | 'sdk',
  sdkVersion: string,
  env: Record<string, string>,
  runFile: NonNullable<CodexRuntimeDeps['runFile']>,
  diagnostics: string[],
  requireAuth: boolean,
): Promise<PreparedCodexRuntime> {
  await assertCandidateFile(path, source);
  const version = await readCompatibleVersion(path, source, sdkVersion, env, runFile);
  if (requireAuth) await assertAuthentication(path, env, diagnostics, runFile);
  return {
    source,
    commandPath: path,
    ...(source === 'sdk' ? {} : { codexPathOverride: path }),
    version,
    env,
    diagnostics,
  };
}

function chatgptDiagnostic(error: CodexRuntimeError, path: string, sdkVersion: string): string {
  switch (error.code) {
    case 'codex_version_mismatch': {
      const version = error.message.match(/reports version ([^,]+)/)?.[1] ?? 'an incompatible version';
      return `ChatGPT candidate at ${path} reports version ${version}, but the installed SDK requires ${sdkVersion}; using the SDK CLI.`;
    }
    case 'codex_version_unreadable':
      return `ChatGPT candidate at ${path} has an unreadable version; using the SDK CLI.`;
    default:
      return `ChatGPT candidate at ${path} is unavailable; using the SDK CLI.`;
  }
}

export async function prepareCodexRuntime(
  account: { bin?: string; env: Record<string, string> },
  deps: CodexRuntimeDeps = {},
): Promise<PreparedCodexRuntime> {
  const safeAccount = validateAccount(account);
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw new CodexRuntimeError(
      'codex_platform_unsupported',
      'Codex integration is supported only on macOS.',
    );
  }

  const sdkVersion = deps.sdkVersion ?? await defaultSdkVersion();
  if (typeof sdkVersion !== 'string' || sdkVersion.length === 0) {
    throw new CodexRuntimeError('codex_start_failed', 'Installed Codex SDK version is unavailable.');
  }
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...safeAccount.env })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const timeoutMs = typeof deps.preflightTimeoutMs === 'number'
    && Number.isFinite(deps.preflightTimeoutMs) && deps.preflightTimeoutMs > 0
    ? deps.preflightTimeoutMs
    : DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const baseRunFile = deps.runFile ?? defaultRunFile;
  const runFile: NonNullable<CodexRuntimeDeps['runFile']> = (file, args, options) =>
    runPreflightFile(baseRunFile, file, args, options.env, timeoutMs);
  const diagnostics: string[] = [];
  const requireAuth = deps.requireAuth ?? true;

  if (safeAccount.bin !== undefined) {
    return prepareCandidate(safeAccount.bin, 'explicit', sdkVersion, env, runFile, diagnostics, requireAuth);
  }

  const chatgptPath = deps.chatgptPath ?? CHATGPT_PATH;
  try {
    return await prepareCandidate(chatgptPath, 'chatgpt', sdkVersion, env, runFile, diagnostics, requireAuth);
  } catch (error) {
    if (!(error instanceof CodexRuntimeError) || error.code === 'codex_auth_unavailable') throw error;
    diagnostics.push(chatgptDiagnostic(error, chatgptPath, sdkVersion));
  }

  const bundledPath = deps.bundledPath ?? defaultBundledPath();
  return prepareCandidate(bundledPath, 'sdk', sdkVersion, env, runFile, diagnostics, requireAuth);
}
