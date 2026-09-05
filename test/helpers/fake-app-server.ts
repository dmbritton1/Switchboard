#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { DENIED_SERVER_METHODS } from '../../src/agents/codex-app-server-contract.ts';

type Message = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'normal';
const interleave = process.env.FAKE_APP_SERVER_INTERLEAVE === '1';
const threadId = 'fixture-thread';
let turnNumber = 0;
let multiThreadNumber = 0;
let multiTurnNumber = 0;
const multiThreads = new Map<string, string>();
const multiTurns = new Map<string, string>();
let initialized = false;
let heldAccountRead: Message | undefined;
let heldClientRequest: Message | undefined;
let rateLimitReads = 0;
const serverResolvers = new Map<string | number, (message: Message) => void>();

function fromJsonEnvironment(name: string, fallback: unknown): unknown {
  const value = process.env[name];
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(`${name} must contain JSON`);
  }
}

const defaultRateLimits = {
  rateLimits: {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 2_000_604_800 },
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: 'unknown',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
};

function record(value: Record<string, unknown>): void {
  const path = process.env.FAKE_APP_SERVER_CALL_LOG;
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

const appServerIndex = process.argv.indexOf('app-server');

if (appServerIndex !== -1 && process.argv[appServerIndex + 1] === 'generate-ts') {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  if (!out) fail('generate-ts requires --out');
  const schemaMode = process.env.FAKE_APP_SERVER_SCHEMA_MODE;
  if (schemaMode === 'hang') setInterval(() => {}, 1_000);
  if (schemaMode === 'ignore-term') {
    const pidFile = process.env.FAKE_APP_SERVER_SCHEMA_PID_FILE;
    if (pidFile) writeFileSync(pidFile, String(process.pid));
    process.on('SIGTERM', () => {
      const marker = process.env.FAKE_APP_SERVER_SCHEMA_EXIT_MARKER;
      if (marker) appendFileSync(marker, 'SIGTERM');
    });
    setInterval(() => {}, 1_000);
    await new Promise<void>(() => {});
  }
  if (schemaMode === 'error') fail(`fake schema failure ${process.env.CODEX_TOKEN ?? ''}`);
  if (schemaMode === 'malformed') {
    writeFileSync(join(out, 'malformed.ts'), 'not the generated schema');
    process.exit(0);
  }
  mkdirSync(join(out, 'v2'), { recursive: true });
  mkdirSync(join(out, 'serde_json'), { recursive: true });
  const omit = process.env.FAKE_APP_SERVER_SCHEMA_OMIT;
  const include = (value: string): boolean => value !== omit;
  writeFileSync(join(out, 'ClientRequest.ts'), [
    'initialize',
    'account/read',
    'account/rateLimits/read',
    'thread/start',
    'turn/start',
    'thread/resume',
    'turn/interrupt',
  ].filter(include).map((method) => `{ "method": "${method}" }`).join('\n'));
  const serverRequests = [
    ...DENIED_SERVER_METHODS,
    ...(process.env.FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST
      ? [process.env.FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST]
      : []),
  ].filter(include);
  writeFileSync(join(out, 'ServerRequest.ts'), [
    `export type ServerRequest = ${serverRequests.map((method) => `{ "method": "${method}" }`).join(' | ')};`,
  ].join('\n'));
  const notifications = [
    'error',
    'account/updated',
    'account/rateLimits/updated',
    'remoteControl/status/changed',
    'thread/started',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'turn/completed',
    'serverRequest/resolved',
  ].filter(include);
  writeFileSync(
    join(out, 'ServerNotification.ts'),
    `${notifications.map((method) => `{ "method": "${method}" }`).join('\n')}\n`,
  );
  writeFileSync(join(out, 'ServerNotificationEnvelope.ts'), 'export type ServerNotificationEnvelope = { emittedAtMs?: number };\n');
  writeFileSync(join(out, 'AuthMode.ts'), 'export type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "headers" | "agentIdentity" | "personalAccessToken" | "bedrockApiKey";\n');
  writeFileSync(join(out, 'v2', 'Account.ts'), 'export type Account = { "type": "apiKey" } | { "type": "chatgpt" } | { "type": "amazonBedrock" };\n');
  writeFileSync(join(out, 'v2', 'RateLimitSnapshot.ts'), 'export type RateLimitSnapshot = { limitId: string | null, limitName: string | null, primary: { usedPercent: number, windowDurationMins: number | null, resetsAt: number | null } | null, secondary: { usedPercent: number, windowDurationMins: number | null, resetsAt: number | null } | null, spendControlReached: boolean | null, rateLimitReachedType: string | null };\n');
  writeFileSync(join(out, 'v2', 'GetAccountRateLimitsResponse.ts'), 'export type GetAccountRateLimitsResponse = { rateLimits: RateLimitSnapshot, rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null };\n');
  writeFileSync(join(out, 'v2', 'AccountRateLimitsUpdatedNotification.ts'), '/** Sparse rolling rate-limit update. */\nexport type AccountRateLimitsUpdatedNotification = { rateLimits: RateLimitSnapshot };\n');
  const shapeOmit = process.env.FAKE_APP_SERVER_SCHEMA_SHAPE_OMIT;
  const shape = (name: string, value: string): string => shapeOmit === name ? '' : value;
  const changedShape = (name: string, value: string, changed: string): string =>
    shapeOmit === name ? changed : value;
  writeFileSync(join(out, 'v2', 'AskForApproval.ts'), [
    'export type AskForApproval = "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean } } | ',
    shape('approval-never', '"never"'),
    changedShape('approval-alias-extra', '', ' | "future"'),
    ';\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'SandboxMode.ts'), [
    'export type SandboxMode = "read-only" | ',
    shape('sandbox-workspace-write', '"workspace-write" | '),
    '"danger-full-access"',
    changedShape('sandbox-alias-extra', '', ' | "future"'),
    ';\n',
  ].join(''));
  writeFileSync(join(out, 'serde_json', 'JsonValue.ts'), changedShape(
    'json-value-type',
    'export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;\n',
    'export type JsonValue = unknown;\n',
  ));
  writeFileSync(join(out, 'v2', 'ThreadStartParams.ts'), [
    'export type ThreadStartParams = {',
    shape('thread-params', [
      'model?: string | null, cwd?: string | null, ',
      changedShape('thread-start-approval-type', changedShape(
        'thread-start-approval-union',
        'approvalPolicy?: AskForApproval | null, ',
        'approvalPolicy?: AskForApproval | null | unknown, ',
      ), 'approvalPolicy?: unknown, '),
      changedShape('thread-start-sandbox-type', changedShape(
        'thread-start-sandbox-union',
        'sandbox?: SandboxMode | null, ',
        'sandbox?: SandboxMode | null | unknown, ',
      ), 'sandbox?: unknown, '),
      changedShape('thread-start-config-type', changedShape(
        'thread-start-config-union',
        'config?: { [key in string]?: JsonValue } | null,',
        'config?: { [key in string]?: JsonValue } | null | unknown,',
      ), 'config?: unknown,'),
    ].join('')),
    '};\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'ThreadResumeParams.ts'), [
    'export type ThreadResumeParams = { threadId: string,',
    shape('thread-params', [
      'model?: string | null, cwd?: string | null, ',
      changedShape('thread-resume-approval-type', changedShape(
        'thread-resume-approval-union',
        'approvalPolicy?: AskForApproval | null, ',
        'approvalPolicy?: AskForApproval | null | unknown, ',
      ), 'approvalPolicy?: unknown, '),
      changedShape('thread-resume-sandbox-type', changedShape(
        'thread-resume-sandbox-union',
        'sandbox?: SandboxMode | null, ',
        'sandbox?: SandboxMode | null | unknown, ',
      ), 'sandbox?: unknown, '),
      changedShape('thread-resume-config-type', changedShape(
        'thread-resume-config-union',
        'config?: { [key in string]?: JsonValue } | null,',
        'config?: { [key in string]?: JsonValue } | null | unknown,',
      ), 'config?: unknown,'),
    ].join('')),
    '};\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnStartParams.ts'), [
    'export type TurnStartParams = { threadId: string,',
    shape('turn-params', 'clientUserMessageId?: string | null, input: Array<UserInput>,'),
    '};\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnInterruptParams.ts'), 'export type TurnInterruptParams = { threadId: string, turnId: string };\n');
  writeFileSync(join(out, 'v2', 'UserInput.ts'), [
    'export type UserInput = { "type": "text", ',
    changedShape('user-input-text-union', 'text: string, ', 'text: string | null, '),
    shape('user-input-text-elements', changedShape(
      'user-input-text-elements-union',
      'text_elements: Array<TextElement>,',
      'text_elements: Array<TextElement> | null,',
    )),
    ' } | { "type": "image", url: string } | ',
    shape('user-input', changedShape(
      'user-input-local-image-path',
      changedShape(
        'user-input-local-image-path-union',
        '{ "type": "localImage", path: string, } | ',
        '{ "type": "localImage", path: string | null, } | ',
      ),
      '{ "type": "localImage", detail?: ImageDetail } | ',
    )),
    '{ "type": "audio", url: string } | { "type": "localAudio", path: string } | { "type": "skill", name: string, path: string } | { "type": "mention", name: string, path: string };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'ThreadItem.ts'), [
    'export type ThreadItem = { "type": "agentMessage", id: string } | { "type": "reasoning", id: string } | { "type": "plan", id: string } | { "type": "commandExecution", id: string } | { "type": "fileChange", id: string } | { "type": "mcpToolCall", id: string } | ',
    shape('thread-items', '{ "type": "webSearch", id: string } | '),
    '{ "type": "contextCompaction", id: string };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnStatus.ts'), [
    'export type TurnStatus = ',
    shape('turn-status', '"completed" | "interrupted" | "failed" | "inProgress"'),
    ';\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnError.ts'), [
    'export type TurnError = { message: string, ',
    shape('turn-error', 'codexErrorInfo: CodexErrorInfo | null,'),
    ' additionalDetails: string | null };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'Turn.ts'), 'export type Turn = { id: string, status: TurnStatus, error: TurnError | null };\n');
  writeFileSync(join(out, 'v2', 'TokenUsageBreakdown.ts'), 'export type TokenUsageBreakdown = { totalTokens: number, inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number, reasoningOutputTokens: number };\n');
  writeFileSync(join(out, 'v2', 'ThreadTokenUsage.ts'), [
    'export type ThreadTokenUsage = { total: TokenUsageBreakdown, ',
    shape('token-usage', 'last: TokenUsageBreakdown,'),
    ' modelContextWindow: number | null };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'Thread.ts'), 'export type Thread = { id: string };\n');
  writeFileSync(join(out, 'v2', 'ThreadStartedNotification.ts'), 'export type ThreadStartedNotification = { thread: Thread };\n');
  writeFileSync(join(out, 'v2', 'ThreadTokenUsageUpdatedNotification.ts'), [
    'export type ThreadTokenUsageUpdatedNotification = { threadId: string, ',
    shape('routing-ids', 'turnId: string,'),
    changedShape('token-usage-payload', changedShape(
      'token-usage-payload-union',
      ' tokenUsage: ThreadTokenUsage,',
      ' tokenUsage: ThreadTokenUsage | null,',
    ), ' tokenUsage: unknown,'),
    ' };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnStartedNotification.ts'), 'export type TurnStartedNotification = { threadId: string, turn: Turn };\n');
  writeFileSync(join(out, 'v2', 'TurnPlanUpdatedNotification.ts'), [
    'export type TurnPlanUpdatedNotification = { threadId: string, ',
    shape('routing-ids', 'turnId: string,'),
    ' plan: Array<unknown> };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'ItemStartedNotification.ts'), [
    'export type ItemStartedNotification = { item: ThreadItem, threadId: string, ',
    shape('routing-ids', 'turnId: string,'),
    ' startedAtMs: number };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'ItemCompletedNotification.ts'), [
    'export type ItemCompletedNotification = { item: ThreadItem, threadId: string, ',
    shape('routing-ids', 'turnId: string,'),
    ' completedAtMs: number };\n',
  ].join(''));
  writeFileSync(join(out, 'v2', 'TurnCompletedNotification.ts'), 'export type TurnCompletedNotification = { threadId: string, turn: Turn };\n');
  const exactWillRetry = changedShape(
    'error-will-retry-optional',
    changedShape(
      'error-will-retry-nullable',
      changedShape(
        'error-will-retry-union',
        changedShape(
          'error-will-retry-literals',
          changedShape(
            'error-will-retry-no-delimiter',
            'willRetry: boolean, ',
            'willRetry: booleanFuture, ',
          ),
          'willRetry: true | false, ',
        ),
        'willRetry: boolean | string, ',
      ),
      'willRetry: boolean | null, ',
    ),
    'willRetry?: boolean, ',
  );
  const willRetry = changedShape(
    'error-will-retry-function-decoy',
    changedShape(
      'error-will-retry-tuple-decoy',
      changedShape(
        'error-will-retry-computed-function-decoy',
        changedShape(
          'error-will-retry-nested-decoy',
          changedShape(
            'error-will-retry-comment-decoy',
            changedShape(
              'error-will-retry-string-decoy',
              changedShape('error-will-retry-multiline-nullable',
                changedShape('error-will-retry-multiline-union', exactWillRetry, 'willRetry: boolean\n | string, '),
                'willRetry: boolean\n | null, '),
              'willRetry?: boolean, decoy: ", willRetry: boolean,", ',
            ),
            'willRetry?: boolean, /*, willRetry: boolean, */ ',
          ),
          'willRetry?: boolean, nested: { willRetry: boolean }, ',
        ),
        'willRetry?: boolean, [Symbol.iterator]: (x: string, willRetry: boolean, y: number) => void, ',
      ),
      'willRetry?: boolean, decoy: [x: string, willRetry: boolean, y: number], ',
    ),
    'willRetry?: boolean, decoy: (x: string, willRetry: boolean, y: number) => void, ',
  );
  writeFileSync(join(out, 'v2', 'ErrorNotification.ts'), [
    'export type ErrorNotification = { error: TurnError, ',
    shape('error-will-retry', willRetry),
    'threadId: string, ',
    shape('routing-ids', 'turnId: string'),
    ' };\n',
  ].join(''));
  record({ operation: 'generate-ts' });
  process.exit(0);
}

if (appServerIndex !== -1) {
  const rootArgs = process.argv.slice(2, appServerIndex);
  const configs = rootArgs.flatMap((value, index) => value === '-c' ? [rootArgs[index + 1]] : []);
  const strict = rootArgs.includes('--strict-config');
  const knownConfigs = new Set(['hooks={}', 'mcp_servers={}', 'otel.exporter="none"']);
  if (strict && configs.some((value) => !knownConfigs.has(value))) fail('strict config rejected unknown key');
  if (!strict && process.env.FAKE_APP_SERVER_STRICT_CONFIG_MARKER) {
    writeFileSync(process.env.FAKE_APP_SERVER_STRICT_CONFIG_MARKER, 'strict config missing');
    fail('strict config required');
  }
  if (!configs.includes('hooks={}') && process.env.FAKE_APP_SERVER_INHERITED_HOOK_MARKER) {
    writeFileSync(process.env.FAKE_APP_SERVER_INHERITED_HOOK_MARKER, 'inherited hook');
    fail('inherited hook ran');
  }
  if (!configs.includes('mcp_servers={}') && process.env.FAKE_APP_SERVER_INHERITED_MCP_MARKER) {
    writeFileSync(process.env.FAKE_APP_SERVER_INHERITED_MCP_MARKER, 'inherited mcp');
    fail('inherited MCP server started');
  }
  const launchRecord = process.env.FAKE_APP_SERVER_LAUNCH_RECORD;
  const launchLog = process.env.FAKE_APP_SERVER_LAUNCH_LOG;
  if (launchLog) {
    appendFileSync(launchLog, `${JSON.stringify({
      operation: 'launch',
      strict,
      configs,
      inheritedHooks: !configs.includes('hooks={}'),
      inheritedMcpServers: !configs.includes('mcp_servers={}'),
    })}\n`);
  }
  if (launchRecord) {
    writeFileSync(launchRecord, JSON.stringify({
      strict,
      configs,
      inheritedHooks: !configs.includes('hooks={}'),
      inheritedMcpServers: !configs.includes('mcp_servers={}'),
    }));
    process.exit(0);
  }
}

function send(message: Message): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function maybePauseBootstrap(): void {
  const enteredMarker = process.env.FAKE_APP_SERVER_BOOTSTRAP_ENTERED_MARKER;
  if (enteredMarker) writeFileSync(enteredMarker, 'entered');
  const releaseMarker = process.env.FAKE_APP_SERVER_BOOTSTRAP_RELEASE_MARKER;
  if (!releaseMarker) return;
  while (!existsSync(releaseMarker)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function turn(id: string, status: 'inProgress' | 'completed' | 'interrupted'): Record<string, unknown> {
  return {
    id,
    items: [],
    itemsView: 'full',
    status,
    error: null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function thread(): Record<string, unknown> {
  return {
    id: threadId,
    sessionId: 'fixture-session',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'fixture lifecycle',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: 'idle' },
    path: null,
    cwd: '/fixture',
    cliVersion: '0.145.0',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function threadResponse(): Record<string, unknown> {
  return {
    thread: thread(),
    model: 'fixture-model',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/fixture',
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: ['/fixture'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    reasoningEffort: null,
  };
}

function multiThreadResponse(id: string, cwd: string): Record<string, unknown> {
  return {
    thread: { id, cwd, path: '/private/fake/thread.json' },
    model: 'fixture-model',
    modelProvider: 'openai',
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
    reasoningEffort: null,
  };
}

function multiInputText(message: Message): string {
  const input = message.params?.input;
  if (!Array.isArray(input) || input.length === 0) return '';
  const first = input[0];
  return first && typeof first === 'object' && !Array.isArray(first)
    && typeof (first as Record<string, unknown>).text === 'string'
    ? (first as Record<string, unknown>).text as string
    : '';
}

function multiUsage(thread: string): Record<string, unknown> {
  const inputTokens = thread.endsWith('-1') ? 11 : 12;
  return {
    total: {},
    last: {
      totalTokens: inputTokens + 3, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 3, reasoningOutputTokens: 1,
    },
    modelContextWindow: 100,
  };
}

function agentMessage(id: string, text: string): Record<string, unknown> {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null };
}

function commandExecution(status: 'inProgress' | 'completed'): Record<string, unknown> {
  return {
    type: 'commandExecution',
    id: 'command-item',
    command: 'printf ok',
    cwd: '/fixture',
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: status === 'completed' ? 'ok' : null,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: status === 'completed' ? 1 : null,
  };
}

function fileChange(status: 'inProgress' | 'completed'): Record<string, unknown> {
  return { type: 'fileChange', id: 'file-item', changes: [], status };
}

function accountRead(message: Message): void {
  if (message.params?.refreshToken !== false) fail('account/read must disable token refresh');
  send({
    id: message.id,
    result: fromJsonEnvironment('FAKE_APP_SERVER_ACCOUNT_RESPONSE', {
      account: { type: 'chatgpt', email: null, planType: 'unknown' },
      requiresOpenaiAuth: true,
    }),
  });
}

function notifyAfterRateLimitRead(): void {
  if (rateLimitReads !== 1) return;
  const stderrAfterRate = process.env.FAKE_APP_SERVER_STDERR_AFTER_RATE;
  if (stderrAfterRate) process.stderr.write(`${stderrAfterRate}\n`);
  if (process.env.FAKE_APP_SERVER_PRIVATE_NOTIFICATION === '1') {
    setTimeout(() => {
      send({
        method: 'remoteControl/status/changed',
        params: {
          serverName: 'private-server-name',
          installationId: 'private-installation-id',
          environmentId: 'private-environment-id',
        },
      });
    }, 5);
  }
  if (mode === 'telemetry-exit-after-rate-read') {
    setTimeout(() => {
      process.stderr.write(`terminal after rate read ${process.env.PROBE_TOKEN ?? ''}\n`);
      process.exit(31);
    }, 5);
  }
  if (mode === 'telemetry-malformed-after-rate-read') {
    setTimeout(() => {
      process.stderr.write(`malformed after rate read ${process.env.PROBE_TOKEN ?? ''}\n`);
      process.stdout.write(`{malformed ${process.env.PROBE_TOKEN ?? ''}\n`);
    }, 5);
  }
  if (mode === 'telemetry-rate-burst') {
    setTimeout(() => {
      const sparse = {
        rateLimits: {
          limitId: null,
          serverName: 'private-sparse-server',
          installationId: 'private-sparse-installation',
        },
      };
      send({ method: 'account/rateLimits/updated', params: sparse });
      send({ method: 'account/rateLimits/updated', params: sparse });
      send({ method: 'account/rateLimits/updated', params: sparse });
    }, 5);
  }
  if (mode === 'telemetry-auth-cycle') {
    setTimeout(() => {
      send({ method: 'account/updated', params: { authMode: 'headers', planType: null } });
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: null } } });
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: null } } });
    }, 5);
    setTimeout(() => {
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'pro' } });
    }, 15);
  }
  if (mode === 'telemetry-auth-during-read') {
    setTimeout(() => {
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: null } } });
    }, 5);
  }
  if (mode === 'telemetry-private-notification') {
    setTimeout(() => {
      send({
        method: 'remoteControl/status/changed',
        params: {
          serverName: 'private-server-name',
          installationId: 'private-installation-id',
          environmentId: 'private-environment-id',
        },
      });
    }, 5);
  }
  if (mode === 'telemetry-refresh-request') {
    setTimeout(() => {
      void serverRequest(7_001, 'account/chatgptAuthTokens/refresh', {
        refreshToken: 'private-refresh-token',
        accountId: 'private-account-id',
      }).then((response) => {
        if (!denied(response)) fail('auth refresh server request was not denied');
      });
    }, 5);
  }
}

async function serverRequest(
  id: string | number,
  method: string,
  params: Record<string, unknown>,
): Promise<Message> {
  const response = new Promise<Message>((resolve) => serverResolvers.set(id, resolve));
  send({ method, id, params });
  return response;
}

function resolved(requestId: number): void {
  send({ method: 'serverRequest/resolved', params: { threadId, requestId } });
}

function denied(response: Message): boolean {
  const error = response.error;
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && (error as Record<string, unknown>).code === -32601;
}

async function handleClientCorrelation(message: Message): Promise<boolean> {
  switch (message.method) {
    case 'initialize': {
      send({
        method: 'fixture/notice',
        params: { delivered: true },
        emittedAtMs: 1,
        unrecognizedEnvelopeField: 'ignored',
      } as Message);
      const numeric = await serverRequest(1, 'fixture/numeric-server-request', { source: 'server' });
      if (!denied(numeric)) fail('numeric server request was not denied');
      send({ id: message.id, result: { initialized: true } });
      return true;
    }
    case 'client/first':
      heldClientRequest = message;
      return true;
    case 'client/second': {
      if (!heldClientRequest) fail('client/second arrived before client/first');
      send({ id: message.id, result: { response: 'second' } });
      const string = await serverRequest('server-1', 'fixture/string-server-request', { source: 'server' });
      if (!denied(string)) fail('string server request was not denied');
      send({ id: heldClientRequest.id, result: { response: 'first' } });
      heldClientRequest = undefined;
      return true;
    }
    default:
      fail(`unsupported client correlation method ${String(message.method)}`);
  }
}

async function handleDeniedServerRequests(message: Message): Promise<boolean> {
  if (message.method !== 'initialize') return false;
  for (const [index, method] of DENIED_SERVER_METHODS.entries()) {
    const response = await serverRequest(1_000 + index, method, { fixture: true });
    if (!denied(response)) fail(`server request ${method} was not denied`);
    const error = response.error as Record<string, unknown>;
    record({
      operation: 'server-response',
      method,
      code: error.code,
      message: error.message,
    });
  }
  send({
    id: message.id,
    result: {
      userAgent: 'codex-app-server/0.145.0',
      codexHome: '/fixture/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });
  return true;
}

async function completeApprovalTurn(turnId: string): Promise<void> {
  send({
    method: 'item/started',
    params: { threadId, turnId, item: commandExecution('inProgress'), startedAtMs: 1 },
  });
  const command = await serverRequest(900, 'item/commandExecution/requestApproval', {
    threadId,
    turnId,
    itemId: 'command-item',
    startedAtMs: 1,
    environmentId: null,
    reason: 'fixture command approval',
    command: 'printf ok',
    cwd: '/fixture',
  });
  if (!denied(command)) fail('command approval was not denied');
  resolved(900);
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: commandExecution('completed'), completedAtMs: 2 },
  });

  send({
    method: 'item/started',
    params: { threadId, turnId, item: fileChange('inProgress'), startedAtMs: 2 },
  });
  const file = await serverRequest(901, 'item/fileChange/requestApproval', {
    threadId,
    turnId,
    itemId: 'file-item',
    startedAtMs: 2,
    reason: 'fixture file approval',
  });
  if (!denied(file)) fail('file approval was not denied');
  resolved(901);
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: fileChange('completed'), completedAtMs: 3 },
  });

  const elicitation = await serverRequest(902, 'mcpServer/elicitation/request', {
    threadId,
    turnId,
    serverName: 'fixture-mcp',
    mode: 'form',
    _meta: null,
    message: 'Confirm fixture input',
    requestedSchema: {
      type: 'object',
      properties: { confirmed: { type: 'boolean', title: 'Confirmed' } },
      required: ['confirmed'],
    },
  });
  if (!denied(elicitation)) fail('MCP elicitation was not denied');
  resolved(902);
  send({
    method: 'item/completed',
    params: { threadId, turnId, item: agentMessage('item-1', 'first turn'), completedAtMs: 4 },
  });
  send({ method: 'turn/completed', params: { threadId, turn: turn(turnId, 'completed') } });
}

async function handle(message: Message): Promise<void> {
  if ('jsonrpc' in message) fail('jsonrpc must be omitted on the wire');

  if (message.id !== undefined && message.method === undefined) {
    const resolve = serverResolvers.get(message.id);
    if (!resolve) fail(`unexpected response id ${message.id}`);
    serverResolvers.delete(message.id);
    resolve(message);
    return;
  }

  if (mode === 'malformed' || mode === 'malformed-and-exit') {
    process.stdout.write(`{malformed ${process.env.PROBE_TOKEN ?? ''}\n`);
    if (mode === 'malformed-and-exit') process.exit(26);
    return;
  }
  if (mode === 'crash') {
    process.stderr.write(`controlled crash ${process.env.PROBE_TOKEN ?? ''}\n`);
    process.exit(23);
  }
  if (mode === 'unknown-response') {
    send({ id: 999, result: { unexpected: true } });
    return;
  }
  if (mode === 'hang' || mode === 'ignore-term' || mode === 'pending-until-eof') return;

  if (mode === 'client-correlation' && await handleClientCorrelation(message)) return;
  if (mode === 'deny-server-requests' && await handleDeniedServerRequests(message)) return;

  if (message.method !== undefined) {
    record({
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    });
  }

  switch (message.method) {
    case 'initialize': {
      if (initialized) fail('initialize called twice');
      const capabilities = message.params?.capabilities;
      if (capabilities !== null) fail('fixture requires installed-schema capabilities: null');
      if (message.params && 'experimentalApi' in message.params) fail('experimentalApi must be omitted');
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: null } });
      send({
        id: message.id,
        result: {
          userAgent: 'codex-app-server/0.145.0',
          codexHome: '/fixture/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
      if (mode === 'crash-after-initialize') {
        setImmediate(() => {
          process.stderr.write(`controlled idle crash ${process.env.PROBE_TOKEN ?? ''}\n`);
          process.exit(24);
        });
      }
      return;
    }
    case 'initialized':
      if (message.params !== undefined) fail('initialized notification must omit params');
      initialized = true;
      return;
    case 'account/read':
      if (!initialized) fail('account/read before initialized');
      if (interleave) heldAccountRead = message;
      else accountRead(message);
      return;
    case 'account/rateLimits/read':
      if (!initialized) fail('account/rateLimits/read before initialized');
      rateLimitReads += 1;
      if (mode === 'telemetry-auth-during-read' && rateLimitReads === 2) {
        send({ method: 'account/updated', params: { authMode: 'headers', planType: null } });
        setTimeout(() => send({
          id: message.id,
          result: fromJsonEnvironment('FAKE_APP_SERVER_RATE_LIMITS_RESPONSE', defaultRateLimits),
        }), 5);
        return;
      }
      const configuredRateLimitError = fromJsonEnvironment('FAKE_APP_SERVER_RATE_LIMITS_ERROR', null);
      if (configuredRateLimitError !== null
        && rateLimitReads > Number(process.env.FAKE_APP_SERVER_RATE_LIMITS_ERROR_AFTER ?? 0)) {
        send({ id: message.id, error: configuredRateLimitError });
        return;
      }
      send({
        id: message.id,
        result: fromJsonEnvironment('FAKE_APP_SERVER_RATE_LIMITS_RESPONSE', defaultRateLimits),
      });
      notifyAfterRateLimitRead();
      return;
    case 'thread/start': {
      if (!initialized) fail('thread/start before initialized');
      if (mode === 'turn-request-timeout') {
        const cwd = message.params?.cwd;
        if (typeof cwd !== 'string') fail('turn timeout thread/start requires cwd');
        send({ id: message.id, result: multiThreadResponse(threadId, cwd) });
        return;
      }
      if (mode === 'turn-multi-session') {
        const cwd = message.params?.cwd;
        if (typeof cwd !== 'string') fail('multi-session thread/start requires cwd');
        const id = multiThreads.get(cwd) ?? `multi-thread-${++multiThreadNumber}`;
        multiThreads.set(cwd, id);
        send({ id: message.id, result: multiThreadResponse(id, cwd) });
        return;
      }
      send({ method: 'thread/started', params: { thread: thread() } });
      send({ id: message.id, result: threadResponse() });
      if (heldAccountRead) {
        send({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
        accountRead(heldAccountRead);
        heldAccountRead = undefined;
      }
      return;
    }
    case 'turn/start': {
      if (mode === 'turn-multi-session') {
        const requestedThread = message.params?.threadId;
        if (typeof requestedThread !== 'string' || ![...multiThreads.values()].includes(requestedThread)) {
          fail('turn/start used an unknown multi-session thread');
        }
        const turnId = `multi-turn-${++multiTurnNumber}`;
        multiTurns.set(turnId, requestedThread);
        send({ id: message.id, result: { turn: turn(turnId, 'inProgress') } });
        if (multiInputText(message).startsWith('crash-')) {
          setImmediate(() => process.exit(25));
          return;
        }
        send({ method: 'turn/started', params: { threadId: requestedThread, turn: turn(turnId, 'inProgress') } });
        const promptText = multiInputText(message);
        if (!promptText.startsWith('hold-')) {
          const reply = promptText.includes('session-a') ? 'reply:session-a' : 'reply:session-b';
          send({ method: 'turn/plan/updated', params: {
            threadId: requestedThread, turnId, plan: [{ step: `plan:${reply}`, status: 'completed' }],
          } });
          send({ method: 'thread/tokenUsage/updated', params: {
            threadId: requestedThread, turnId, tokenUsage: multiUsage(requestedThread),
          } });
          send({ method: 'item/completed', params: {
            threadId: requestedThread, turnId, item: agentMessage(`multi-item-${turnId}`, reply), completedAtMs: 2,
          } });
          send({ method: 'turn/completed', params: { threadId: requestedThread, turn: turn(turnId, 'completed') } });
        }
        return;
      }
      if (message.params?.threadId !== threadId) fail('turn/start used the wrong thread');
      const input = message.params.input;
      if (!Array.isArray(input) || input.length !== 1) fail('turn/start requires one input');
      const [textInput] = input;
      if (!textInput || typeof textInput !== 'object' || Array.isArray(textInput)
        || (textInput as Record<string, unknown>).type !== 'text'
        || typeof (textInput as Record<string, unknown>).text !== 'string'
        || !Array.isArray((textInput as Record<string, unknown>).text_elements)
        || ((textInput as Record<string, unknown>).text_elements as unknown[]).length !== 0) {
        fail('turn/start text input must include empty text_elements');
      }
      if (mode === 'turn-request-timeout') return;
      turnNumber += 1;
      const turnId = `fixture-turn-${turnNumber}`;
      send({ id: message.id, result: { turn: turn(turnId, 'inProgress') } });
      if (mode === 'crash-after-turn-response') {
        setImmediate(() => process.exit(25));
        return;
      }
      send({ method: 'turn/started', params: { threadId, turn: turn(turnId, 'inProgress') } });
      send({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: agentMessage(`item-${turnNumber}`, ''),
          startedAtMs: 1,
        },
      });
      if (turnNumber === 1) {
        void completeApprovalTurn(turnId);
      } else if (turnNumber === 2) {
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: agentMessage('item-2', 'follow-up'),
            completedAtMs: 2,
          },
        });
        send({ method: 'turn/completed', params: { threadId, turn: turn(turnId, 'completed') } });
      }
      return;
    }
    case 'thread/resume':
      if (mode === 'turn-multi-session') {
        const requestedThread = message.params?.threadId;
        const cwd = message.params?.cwd;
        if (typeof requestedThread !== 'string' || !requestedThread.startsWith('multi-thread-') || typeof cwd !== 'string') {
          fail('thread/resume used invalid multi-session identifiers');
        }
        multiThreads.set(cwd, requestedThread);
        send({ id: message.id, result: multiThreadResponse(requestedThread, cwd) });
        return;
      }
      if (message.params?.threadId !== threadId) fail('thread/resume used the wrong thread');
      send({ id: message.id, result: threadResponse() });
      return;
    case 'turn/interrupt': {
      if (mode === 'turn-multi-session') {
        const requestedThread = message.params?.threadId;
        const requestedTurn = message.params?.turnId;
        if (typeof requestedThread !== 'string' || typeof requestedTurn !== 'string'
          || multiTurns.get(requestedTurn) !== requestedThread) fail('turn/interrupt used the wrong multi-session identifiers');
        send({ id: message.id, result: {} });
        send({ method: 'turn/completed', params: { threadId: requestedThread, turn: turn(requestedTurn, 'interrupted') } });
        return;
      }
      if (message.params?.threadId !== threadId || message.params?.turnId !== 'fixture-turn-3') {
        fail('turn/interrupt used the wrong identifiers');
      }
      send({ id: message.id, result: {} });
      send({
        method: 'turn/completed',
        params: { threadId, turn: turn('fixture-turn-3', 'interrupted') },
      });
      return;
    }
    default:
      fail(`unsupported method ${String(message.method)}`);
  }
}

if (mode === 'hang' || mode === 'ignore-term') {
  const pidFile = process.env.FAKE_APP_SERVER_PID_FILE;
  process.on('SIGTERM', () => {
    const marker = process.env.FAKE_APP_SERVER_EXIT_MARKER;
    if (marker) appendFileSync(marker, 'SIGTERM');
    if (mode === 'hang') process.exit(0);
  });
  if (pidFile) writeFileSync(pidFile, String(process.pid));
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    fail('client sent malformed JSON');
  }
  void handle(message).catch((error: unknown) => fail(error instanceof Error ? error.message : 'fixture failure'));
});
lines.on('close', () => {
  record({ operation: 'eof' });
  if (mode === 'ignore-eof') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === 'normal' && serverResolvers.size > 0) fail('client closed with unresolved server requests');
});

maybePauseBootstrap();

const readyMarker = process.env.FAKE_APP_SERVER_READY_MARKER;
if (mode === 'write-failure') {
  process.stdin.destroy();
  process.exit(27);
} else if (readyMarker) writeFileSync(readyMarker, 'ready');
