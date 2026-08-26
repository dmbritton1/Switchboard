#!/usr/bin/env node

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'normal';
const interleave = process.env.FAKE_APP_SERVER_INTERLEAVE === '1';
const threadId = 'fixture-thread';
let turnNumber = 0;
let initialized = false;
let heldAccountRead: Message | undefined;
const serverResolvers = new Map<number, (message: Message) => void>();

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
    ...(process.env.FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST
      ? [process.env.FAKE_APP_SERVER_SCHEMA_ADD_SERVER_REQUEST]
      : []),
  ].filter(include);
  writeFileSync(join(out, 'ServerRequest.ts'), [
    `export type ServerRequest = ${serverRequests.map((method) => `{ "method": "${method}" }`).join(' | ')};`,
  ].join('\n'));
  const notifications = [
    'account/updated',
    'account/rateLimits/updated',
    'remoteControl/status/changed',
    'thread/started',
    'turn/started',
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
  writeFileSync(join(out, 'v2', 'RateLimitSnapshot.ts'), 'export type RateLimitSnapshot = { limitId: string | null, usedPercent: number, windowDurationMins: number, resetsAt: number, spendControlReached: boolean | null, rateLimitReachedType: string | null };\n');
  writeFileSync(join(out, 'v2', 'GetAccountRateLimitsResponse.ts'), 'export type GetAccountRateLimitsResponse = { rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null };\n');
  writeFileSync(join(out, 'v2', 'AccountRateLimitsUpdatedNotification.ts'), '/** Sparse rolling rate-limit update. */\nexport type AccountRateLimitsUpdatedNotification = { rateLimits: RateLimitSnapshot };\n');
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
}

function send(message: Message): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
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
    result: {
      account: { type: 'chatgpt', email: null, planType: 'unknown' },
      requiresOpenaiAuth: true,
    },
  });
}

async function serverRequest(
  id: number,
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
  if (JSON.stringify(command.result) !== JSON.stringify({ decision: 'acceptForSession' })) {
    fail('unexpected command approval response');
  }
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
  if (JSON.stringify(file.result) !== JSON.stringify({ decision: 'accept' })) {
    fail('unexpected file approval response');
  }
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
  if (JSON.stringify(elicitation.result) !== JSON.stringify({
    action: 'decline',
    content: null,
    _meta: null,
  })) {
    fail('unexpected MCP elicitation response');
  }
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

  if (mode === 'malformed') {
    process.stdout.write('{malformed\n');
    return;
  }
  if (mode === 'crash') {
    process.stderr.write(`controlled crash ${process.env.PROBE_TOKEN ?? ''}\n`);
    process.exit(23);
  }
  if (mode === 'hang' || mode === 'ignore-term') return;

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
    case 'thread/start': {
      if (!initialized) fail('thread/start before initialized');
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
      if (message.params?.threadId !== threadId) fail('thread/resume used the wrong thread');
      send({ id: message.id, result: threadResponse() });
      return;
    case 'turn/interrupt': {
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
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  process.on('SIGTERM', () => {
    const marker = process.env.FAKE_APP_SERVER_EXIT_MARKER;
    if (marker) appendFileSync(marker, 'SIGTERM');
    if (mode === 'hang') process.exit(0);
  });
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
  if (mode === 'normal' && serverResolvers.size > 0) fail('client closed with unresolved server requests');
});
