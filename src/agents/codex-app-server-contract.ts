import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactValues, type PreparedCodexRuntime } from './codex-runtime.ts';

export const CODEX_TELEMETRY_VERSION = '0.145.0';
export const TELEMETRY_CLIENT_METHODS = [
  'initialize',
  'account/read',
  'account/rateLimits/read',
] as const;
export const TELEMETRY_NOTIFICATIONS = [
  'account/updated',
  'account/rateLimits/updated',
] as const;
export const TURN_CLIENT_METHODS = [
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
] as const;
export const TURN_NOTIFICATIONS = [
  'error',
  'thread/started',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'turn/completed',
] as const;
export const DENIED_SERVER_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval',
] as const;
export const PRIVATE_NOTIFICATIONS = [
  'remoteControl/status/changed',
] as const;

const GENERATION_TIMEOUT_MS = 10_000;
const GENERATION_TERMINATION_GRACE_MS = 250;
const VERIFIED_CONTRACTS = new Map<string, Promise<void>>();
const GENERATED_SCHEMAS = new Map<string, Promise<Map<string, string>>>();
const AUTH_MODES = [
  'apikey',
  'chatgpt',
  'chatgptAuthTokens',
  'headers',
  'agentIdentity',
  'personalAccessToken',
  'bedrockApiKey',
];
const ACCOUNT_TYPES = ['apiKey', 'chatgpt', 'amazonBedrock'];

export type ContractDeps = {
  timeoutMs?: number;
};

export type CodexAppServerMode = 'telemetry' | 'turns';

export function appServerArgs(mode: CodexAppServerMode): string[] {
  const config = mode === 'telemetry'
    ? ['-c', 'hooks={}', '-c', 'mcp_servers={}']
    : [];
  return [
    '--strict-config',
    ...config,
    '-c', 'otel.exporter="none"',
    'app-server', '--listen', 'stdio://',
  ];
}

export function telemetryAppServerArgs(): string[] {
  return appServerArgs('telemetry');
}

function publishedVersion(version: string): string {
  return version.split('+', 1)[0];
}

function contractError(runtime: PreparedCodexRuntime, mode: CodexAppServerMode): Error {
  const message = mode === 'telemetry'
    ? 'Codex telemetry contract verification failed.'
    : 'Codex app-server turn contract verification failed.';
  return new Error(redactValues(message, Object.values(runtime.env)));
}

function sameMembers(actual: Iterable<string>, expected: readonly string[]): boolean {
  const values = [...new Set(actual)].sort();
  return values.length === expected.length && values.every((value, index) => value === [...expected].sort()[index]);
}

function methods(source: string): string[] {
  return [...source.matchAll(/"method"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
}

function quoted(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function taggedUnionMember(source: string, type: string): string | undefined {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`\\{\\s*"type"\\s*:\\s*"${escaped}"\\s*,[\\s\\S]*?\\}`))?.[0];
}

function outerObjectMembers(source: string): string | null {
  const assignment = source.indexOf('=');
  const opening = source.indexOf('{', assignment + 1);
  if (assignment === -1 || opening === -1) return null;
  let members = '';
  const nestedClosers: string[] = [];
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const atOuterLevel = (): boolean => nestedClosers.length === 0;
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        if (atOuterLevel()) members += '\n';
      } else if (atOuterLevel()) members += ' ';
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        if (atOuterLevel()) members += '  ';
        blockComment = false;
        index += 1;
      } else if (atOuterLevel()) members += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote !== null) {
      if (atOuterLevel()) members += ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      if (atOuterLevel()) members += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      if (atOuterLevel()) members += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      if (atOuterLevel()) members += ' ';
      quote = character;
      continue;
    }
    const closer = character === '{' ? '}'
      : character === '(' ? ')'
        : character === '[' ? ']'
          : character === '<' ? '>'
            : null;
    if (closer !== null) {
      if (atOuterLevel()) members += ' ';
      nestedClosers.push(closer);
      continue;
    }
    if (nestedClosers.at(-1) === character) {
      nestedClosers.pop();
      continue;
    }
    if (character === '}' && atOuterLevel()) return members;
    if (atOuterLevel()) members += character;
  }
  return null;
}

async function generatedFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(current: string, relative = ''): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const childRelative = join(relative, entry.name);
      const child = join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) files.set(childRelative, await readFile(child, 'utf8'));
    }
  }
  await walk(directory);
  return files;
}

async function generate(commandPath: string, env: Record<string, string>, directory: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timingOut = false;
    const child = spawn(commandPath, ['app-server', 'generate-ts', '--out', directory], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.resume();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let resolveClose: () => void;
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const waitForClose = (milliseconds: number): Promise<boolean> => Promise.race([
      close.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
    ]);
    const timer = setTimeout(() => {
      timingOut = true;
      void (async () => {
        child.kill('SIGTERM');
        if (!await waitForClose(GENERATION_TERMINATION_GRACE_MS)) child.kill('SIGKILL');
        await close;
        finish(new Error('schema generation timed out'));
      })();
    }, timeoutMs);
    child.once('error', () => finish(new Error('schema generation failed')));
    child.once('close', (code, signal) => {
      resolveClose();
      if (!timingOut) {
        if (code === 0 && signal === null) finish();
        else finish(new Error('schema generation failed'));
      }
    });
  });
}

function assertContract(files: Map<string, string>, mode: CodexAppServerMode): void {
  const all = [...files.values()].join('\n');
  const client = files.get('ClientRequest.ts');
  const server = files.get('ServerRequest.ts');
  const notifications = files.get('ServerNotification.ts');
  const envelope = files.get('ServerNotificationEnvelope.ts');
  const account = files.get(join('v2', 'Account.ts'));
  const authMode = files.get('AuthMode.ts');
  const rateLimits = files.get(join('v2', 'GetAccountRateLimitsResponse.ts'));
  const snapshot = files.get(join('v2', 'RateLimitSnapshot.ts'));
  const updated = files.get(join('v2', 'AccountRateLimitsUpdatedNotification.ts'));
  if (!client || !server || !notifications || !envelope || !account || !authMode || !rateLimits || !snapshot || !updated) {
    throw new Error('generated schema is incomplete');
  }
  if (!TELEMETRY_CLIENT_METHODS.every((method) => methods(client).includes(method))
    || !TELEMETRY_NOTIFICATIONS.every((method) => methods(notifications).includes(method))
    || !PRIVATE_NOTIFICATIONS.every((method) => methods(notifications).includes(method))
    || !sameMembers(methods(server), DENIED_SERVER_METHODS)
    || !sameMembers([...account.matchAll(/"type"\s*:\s*"([^"]+)"/g)].map((match) => match[1]), ACCOUNT_TYPES)
    || !sameMembers(quoted(authMode), AUTH_MODES)
    || !/emittedAtMs\s*\?\s*:\s*number/.test(envelope)
    || !/usedPercent/.test(all)
    || !/windowDurationMins/.test(all)
    || !/resetsAt/.test(all)
    || !/rateLimitsByLimitId/.test(rateLimits)
    || !/rateLimitReachedType/.test(snapshot)
    || !/spendControlReached/.test(snapshot)
    || !/limitId\s*:\s*string\s*\|\s*null/.test(snapshot)
    || !/Sparse rolling rate-limit update/.test(updated)
    || !/rateLimits\s*:\s*RateLimitSnapshot/.test(updated)) {
    throw new Error('generated schema differs from the telemetry contract');
  }
  if (mode === 'turns') assertTurnContract(files, client, notifications);
}

function assertTurnContract(files: Map<string, string>, client: string, notifications: string): void {
  const approvalPolicy = files.get(join('v2', 'AskForApproval.ts'));
  const sandboxMode = files.get(join('v2', 'SandboxMode.ts'));
  const jsonValue = files.get(join('serde_json', 'JsonValue.ts'));
  const threadStart = files.get(join('v2', 'ThreadStartParams.ts'));
  const threadResume = files.get(join('v2', 'ThreadResumeParams.ts'));
  const turnStart = files.get(join('v2', 'TurnStartParams.ts'));
  const turnInterrupt = files.get(join('v2', 'TurnInterruptParams.ts'));
  const userInput = files.get(join('v2', 'UserInput.ts'));
  const threadItem = files.get(join('v2', 'ThreadItem.ts'));
  const turn = files.get(join('v2', 'Turn.ts'));
  const turnStatus = files.get(join('v2', 'TurnStatus.ts'));
  const turnError = files.get(join('v2', 'TurnError.ts'));
  const tokenUsage = files.get(join('v2', 'ThreadTokenUsage.ts'));
  const tokenBreakdown = files.get(join('v2', 'TokenUsageBreakdown.ts'));
  const thread = files.get(join('v2', 'Thread.ts'));
  const threadStarted = files.get(join('v2', 'ThreadStartedNotification.ts'));
  const usageUpdated = files.get(join('v2', 'ThreadTokenUsageUpdatedNotification.ts'));
  const turnStarted = files.get(join('v2', 'TurnStartedNotification.ts'));
  const planUpdated = files.get(join('v2', 'TurnPlanUpdatedNotification.ts'));
  const itemStarted = files.get(join('v2', 'ItemStartedNotification.ts'));
  const itemCompleted = files.get(join('v2', 'ItemCompletedNotification.ts'));
  const turnCompleted = files.get(join('v2', 'TurnCompletedNotification.ts'));
  const error = files.get(join('v2', 'ErrorNotification.ts'));
  const approvalPolicyContract = /export\s+type\s+AskForApproval\s*=\s*"untrusted"\s*\|\s*"on-request"\s*\|\s*\{\s*"granular"\s*:\s*\{\s*sandbox_approval\s*:\s*boolean\s*,\s*rules\s*:\s*boolean\s*,\s*skill_approval\s*:\s*boolean\s*,\s*request_permissions\s*:\s*boolean\s*,\s*mcp_elicitations\s*:\s*boolean\s*,?\s*\}\s*\}\s*\|\s*"never"\s*;/;
  const sandboxModeContract = /export\s+type\s+SandboxMode\s*=\s*"read-only"\s*\|\s*"workspace-write"\s*\|\s*"danger-full-access"\s*;/;
  const threadBasics = /model\s*\?\s*:\s*string\s*\|\s*null[\s\S]*cwd\s*\?\s*:\s*string\s*\|\s*null/;
  const threadApproval = /approvalPolicy\s*\?\s*:\s*AskForApproval\s*\|\s*null\s*,/;
  const threadSandbox = /sandbox\s*\?\s*:\s*SandboxMode\s*\|\s*null\s*,/;
  const threadConfig = /config\s*\?\s*:\s*\{\s*\[key\s+in\s+string\]\s*\?\s*:\s*JsonValue\s*\}\s*\|\s*null\s*,/;
  const jsonValueContract = /export\s+type\s+JsonValue\s*=\s*number\s*\|\s*string\s*\|\s*boolean\s*\|\s*Array\s*<\s*JsonValue\s*>\s*\|\s*\{\s*\[key\s+in\s+string\]\s*\?\s*:\s*JsonValue\s*\}\s*\|\s*null\s*;/;
  const turnInput = /threadId\s*:\s*string[\s\S]*clientUserMessageId\s*\?\s*:\s*string\s*\|\s*null[\s\S]*input\s*:\s*(?:Array\s*<\s*UserInput\s*>|UserInput\s*\[\])/;
  const routing = /threadId\s*:\s*string[\s\S]*turnId\s*:\s*string/;
  const errorMembers = error ? outerObjectMembers(error) : null;
  const requiredWillRetry = /(?:^|[,;])\s*willRetry\s*:\s*boolean\s*(?=[,;]|(?![\s\S]))/;
  const textInput = userInput ? taggedUnionMember(userInput, 'text') : undefined;
  const localImageInput = userInput ? taggedUnionMember(userInput, 'localImage') : undefined;
  if (!approvalPolicy || !sandboxMode || !jsonValue || !threadStart || !threadResume
    || !turnStart || !turnInterrupt || !userInput || !threadItem
    || !turn || !turnStatus || !turnError || !tokenUsage || !tokenBreakdown || !thread
    || !threadStarted || !usageUpdated || !turnStarted || !planUpdated || !itemStarted
    || !itemCompleted || !turnCompleted || !error
    || !TURN_CLIENT_METHODS.every((method) => methods(client).includes(method))
    || !TURN_NOTIFICATIONS.every((method) => methods(notifications).includes(method))
    || !approvalPolicyContract.test(approvalPolicy)
    || !sandboxModeContract.test(sandboxMode)
    || !jsonValueContract.test(jsonValue)
    || !threadBasics.test(threadStart) || !threadApproval.test(threadStart)
    || !threadSandbox.test(threadStart) || !threadConfig.test(threadStart)
    || !/threadId\s*:\s*string/.test(threadResume) || !threadBasics.test(threadResume)
    || !threadApproval.test(threadResume) || !threadSandbox.test(threadResume)
    || !threadConfig.test(threadResume)
    || !turnInput.test(turnStart)
    || !/threadId\s*:\s*string[\s\S]*turnId\s*:\s*string/.test(turnInterrupt)
    || !textInput || !/text\s*:\s*string\s*,/.test(textInput)
    || !/text_elements\s*:\s*Array\s*<\s*TextElement\s*>\s*,\s*\}/.test(textInput)
    || !localImageInput || !/path\s*:\s*string\s*,\s*\}/.test(localImageInput)
    || !['agentMessage', 'reasoning', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'contextCompaction']
      .every((type) => new RegExp(`"type"\\s*:\\s*"${type}"`).test(threadItem))
    || !sameMembers(quoted(turnStatus), ['completed', 'interrupted', 'failed', 'inProgress'])
    || !/id\s*:\s*string[\s\S]*status\s*:\s*TurnStatus[\s\S]*error\s*:\s*TurnError\s*\|\s*null/.test(turn)
    || !/message\s*:\s*string[\s\S]*codexErrorInfo\s*:\s*CodexErrorInfo\s*\|\s*null/.test(turnError)
    || !/total\s*:\s*TokenUsageBreakdown[\s\S]*last\s*:\s*TokenUsageBreakdown/.test(tokenUsage)
    || !['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']
      .every((field) => new RegExp(`${field}\\s*:\\s*number`).test(tokenBreakdown))
    || !/id\s*:\s*string/.test(thread)
    || !/thread\s*:\s*Thread/.test(threadStarted)
    || !routing.test(usageUpdated) || !/tokenUsage\s*:\s*ThreadTokenUsage\s*,\s*\}/.test(usageUpdated)
    || !/threadId\s*:\s*string[\s\S]*turn\s*:\s*Turn/.test(turnStarted)
    || !routing.test(planUpdated)
    || !routing.test(itemStarted) || !/item\s*:\s*ThreadItem/.test(itemStarted)
    || !routing.test(itemCompleted) || !/item\s*:\s*ThreadItem/.test(itemCompleted)
    || !/threadId\s*:\s*string[\s\S]*turn\s*:\s*Turn/.test(turnCompleted)
    || !routing.test(error) || !/error\s*:\s*TurnError/.test(error)
    || !errorMembers || !requiredWillRetry.test(errorMembers)) {
    throw new Error('generated schema differs from the turn contract');
  }
}

async function generateSchema(
  runtime: PreparedCodexRuntime,
  timeoutMs: number,
): Promise<Map<string, string>> {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-codex-contract-'));
  try {
    await generate(runtime.commandPath, runtime.env, directory, timeoutMs);
    return await generatedFiles(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function generatedSchema(runtime: PreparedCodexRuntime, timeoutMs: number): Promise<Map<string, string>> {
  const key = `${runtime.commandPath}\u0000${runtime.version}`;
  const existing = GENERATED_SCHEMAS.get(key);
  if (existing) return existing;
  const generated = generateSchema(runtime, timeoutMs);
  GENERATED_SCHEMAS.set(key, generated);
  void generated.catch(() => {
    if (GENERATED_SCHEMAS.get(key) === generated) GENERATED_SCHEMAS.delete(key);
  });
  return generated;
}

export function verifyAppServerContract(
  runtime: PreparedCodexRuntime,
  mode: CodexAppServerMode,
  deps: ContractDeps = {},
): Promise<void> {
  if (publishedVersion(runtime.version) !== CODEX_TELEMETRY_VERSION) {
    return Promise.reject(contractError(runtime, mode));
  }
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
    ? deps.timeoutMs
    : GENERATION_TIMEOUT_MS;
  const key = `${runtime.commandPath}\u0000${runtime.version}\u0000${mode}`;
  const existing = VERIFIED_CONTRACTS.get(key);
  if (existing) return existing;
  const verification = generatedSchema(runtime, timeoutMs)
    .then((files) => assertContract(files, mode))
    .catch(() => {
      throw contractError(runtime, mode);
    });
  VERIFIED_CONTRACTS.set(key, verification);
  void verification.catch(() => {
    if (VERIFIED_CONTRACTS.get(key) === verification) VERIFIED_CONTRACTS.delete(key);
  });
  return verification;
}

export function verifyTelemetryContract(
  runtime: PreparedCodexRuntime,
  deps: ContractDeps = {},
): Promise<void> {
  return verifyAppServerContract(runtime, 'telemetry', deps);
}
