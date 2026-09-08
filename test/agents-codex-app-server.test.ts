import assert from 'node:assert/strict';
import fs from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppServerClient, type AppServerClientOptions } from '../src/agents/codex-app-server-client.ts';
import * as appServerAdapter from '../src/agents/codex-app-server.ts';
import { fileURLToPath } from 'node:url';
import {
  codexAppServerPromptInput,
  createCodexAppServerAdapter,
  normalizeCodexAppServerItem,
} from '../src/agents/codex-app-server.ts';
import {
  CodexAppServerSupervisor,
  type CodexSessionRoute,
} from '../src/agents/codex-app-server-supervisor.ts';
import { Registry } from '../src/sessions.ts';
import { unsafeProviderIdentifiers, opaqueProviderIdentifiers } from './helpers/provider-identifiers.ts';
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import type { AdapterEvent, AgentPrompt, CodexFailureCode } from '../src/types.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));

function prompt(text: string): AgentPrompt {
  return { text, attachments: [] };
}

async function imagePrompt(cwd: string, text = 'inspect image'): Promise<AgentPrompt> {
  const absolutePath = join(cwd, 'image.png');
  await writeFile(absolutePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]));
  return {
    text,
    attachments: [{
      name: 'image.png', relativePath: 'image.png', absolutePath, kind: 'image',
    }],
  };
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function safeThreadResponse(threadId: string, cwd: string): Record<string, unknown> {
  return {
    thread: { id: threadId, cwd, path: '/private/provider/thread.json' },
    model: 'fixture-model',
    modelProvider: 'openai',
    serviceTier: null,
    cwd,
    instructionSources: ['/private/provider/AGENTS.md'],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    reasoningEffort: null,
  };
}

function turn(turnId: string, status: 'inProgress' | 'completed' | 'interrupted' | 'failed', error: unknown = null) {
  return {
    id: turnId,
    items: [],
    itemsView: 'full',
    status,
    error,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message = 'adapter state',
  milliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Request = { sessionId: string; method: string; params: unknown };

class ScriptedSupervisor {
  readonly requests: Request[] = [];
  readonly trace: string[] = [];
  readonly pendingDispatches: Array<() => void> = [];
  route: CodexSessionRoute | null = null;
  bound: { sessionId: string; threadId: string } | null = null;
  detached = 0;
  request: (request: Request) => Promise<unknown>;
  readonly autoDispatch: boolean;

  constructor(request?: (request: Request) => Promise<unknown>, autoDispatch = true) {
    this.autoDispatch = autoDispatch;
    let turnNumber = 0;
    this.request = request ?? (async ({ method, params }) => {
      if (method === 'thread/start') return safeThreadResponse('thread-new', (params as { cwd: string }).cwd);
      if (method === 'thread/resume') {
        const value = params as { threadId: string; cwd: string };
        return safeThreadResponse(value.threadId, value.cwd);
      }
      if (method === 'turn/start') return { turn: turn(`turn-${++turnNumber}`, 'inProgress') };
      if (method === 'turn/interrupt') return {};
      throw new Error(`unsupported request ${method}`);
    });
  }

  registerSession(sessionId: string, route: CodexSessionRoute): () => void {
    assert.equal(this.route, null, 'the adapter registers exactly one route');
    this.trace.push('route:registered');
    this.route = route;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.detached += 1;
      this.route = null;
      if (this.bound?.sessionId === sessionId) this.bound = null;
    };
  }

  bindThread(sessionId: string, threadId: string): void {
    assert.equal(this.bound, null, 'the adapter binds exactly one thread');
    this.bound = { sessionId, threadId };
    this.trace.push(`thread:bound:${threadId}`);
  }

  async requestForSession<T>(
    sessionId: string,
    method: Request['method'],
    params: unknown,
    onDispatched?: () => void,
  ): Promise<T> {
    const value = { sessionId, method, params };
    this.requests.push(value);
    this.trace.push(`request:${method}`);
    if (method === 'turn/start' && onDispatched) {
      if (this.autoDispatch) onDispatched();
      else this.pendingDispatches.push(onDispatched);
    }
    return this.request(value) as Promise<T>;
  }

  dispatchNext(): void {
    const dispatch = this.pendingDispatches.shift();
    assert.ok(dispatch, 'a turn/start dispatch acknowledgement is pending');
    dispatch();
  }

  notify(method: string, params: unknown): void {
    this.route?.onNotification(method, params);
  }

  fatal(reason: string, code: CodexFailureCode): void {
    this.route?.onFatal(reason, code);
  }

  async retireSessionGeneration(
    _sessionId?: string,
    failure?: { reason: string; code: CodexFailureCode },
  ): Promise<void> {
    this.fatal(
      failure?.reason ?? 'Codex app-server transport crashed. Retry the session manually.',
      failure?.code ?? 'codex_transport_crashed',
    );
  }
}

test('prompt conversion keeps app-server wire input distinct and never writes absolute file paths into text', () => {
  const input = codexAppServerPromptInput({
    text: 'inspect this',
    attachments: [
      {
        name: 'notes.txt', relativePath: 'notes.txt', absolutePath: '/validated/worktree/notes.txt', kind: 'file',
      },
      {
        name: 'image.png', relativePath: 'image.png', absolutePath: '/validated/worktree/image.png', kind: 'image',
      },
    ],
  });

  assert.deepEqual(input, [
    { type: 'text', text: 'inspect this\nAttached file: notes.txt', text_elements: [] },
    { type: 'localImage', path: '/validated/worktree/image.png' },
  ]);
  assert.doesNotMatch(String((input[0] as { text: string }).text), /validated\/worktree/);
  assert.equal(JSON.stringify(input).includes('local_image'), false, 'SDK local_image never crosses the app-server wire');
});

test('absolute-path-shaped identifiers fail before item, thread, resume, turn, Registry and persistence admission', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'sb-path-identifiers-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [index, unsafeId] of unsafeProviderIdentifiers.entries()) {
    for (const location of ['item', 'thread', 'resume', 'turn', 'plan'] as const) {
      await t.test(`${index}:${location}`, async () => {
        const statePath = join(cwd, `${index}-${location}.json`);
        const registry = new Registry(statePath);
        const session = registry.create({ provider: 'codex', account: 'codex', repo: cwd, cwd,
          branch: 'test', title: 'test', codexTransport: 'app-server' });
        const supervisor = new ScriptedSupervisor(async ({ method }) => {
          if (method.startsWith('thread/')) return safeThreadResponse(location === 'thread' ? unsafeId : 'thread-new', cwd);
          if (method === 'turn/start') return { turn: turn(location === 'turn' ? unsafeId : 'turn-1', 'inProgress') };
          return {};
        });
        const handle = createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, session.id, '0.145.0')
          .start({ cwd, prompt: prompt('inspect'), env: {}, ...(location === 'resume' ? { resumeId: unsafeId } : {}) },
            (event) => registry.apply(session.id, event));
        await waitFor(() => session.status === 'stopped' || supervisor.requests.some(({ method }) => method === 'turn/start'));
        if (location === 'item') {
          assert.deepEqual(normalizeCodexAppServerItem('started', { type: 'plan', id: unsafeId, text: 'unsafe' }), []);
          supervisor.notify('item/started', { threadId: 'thread-new', turnId: 'turn-1',
            item: { type: 'plan', id: unsafeId, text: 'unsafe' } });
        }
        if (location === 'plan') supervisor.notify('turn/plan/updated', {
          threadId: 'thread-new', turnId: unsafeId, plan: [{ step: 'unsafe', status: 'inProgress' }],
        });
        assert.equal(session.stoppedCode, 'codex_protocol_mismatch');
        if (location === 'thread' || location === 'resume') assert.equal(supervisor.bound, null);
        if (location === 'resume') assert.equal(supervisor.requests.length, 0);
        await registry.save();
        assert.equal(JSON.stringify(registry.publicSessions()).includes(unsafeId), false);
        assert.equal((await readFile(statePath, 'utf8')).includes(unsafeId), false);
        handle.stop();
      });
    }
  }
});

test('opaque provider identifiers survive binding, resume and public persistence byte for byte', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'sb-opaque-identifiers-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const id of opaqueProviderIdentifiers) {
    const registry = new Registry(join(cwd, 'state.json'));
    const session = registry.create({ provider: 'codex', account: 'codex', repo: cwd, cwd,
      branch: 'test', title: 'test', codexTransport: 'app-server' });
    const supervisor = new ScriptedSupervisor();
    const handle = createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, session.id, '0.145.0')
      .start({ cwd, prompt: prompt('inspect'), env: {}, resumeId: id }, (event) => registry.apply(session.id, event));
    await waitFor(() => session.status === 'stopped' || supervisor.requests.some(({ method }) => method === 'turn/start'));
    assert.notEqual(session.status, 'stopped', id);
    assert.equal(supervisor.bound?.threadId, id);
    assert.equal(session.vendorSessionId, id);
    assert.equal((supervisor.requests[0].params as { threadId: string }).threadId, id);
    registry.apply(session.id, ...normalizeCodexAppServerItem('started', { type: 'plan', id, text: 'safe' }) as [AdapterEvent]);
    await registry.save();
    const reloaded = await Registry.load(join(cwd, 'state.json'));
    assert.equal(reloaded.get(session.id)?.vendorSessionId, id);
    assert.ok(reloaded.publicSessions()[0].transcript.some((msg) => 'id' in msg && msg.id === id));
    handle.stop();
  }
});

test('app-server item normalization emits provider-neutral rows, summaries only for reasoning, and bounded redacted detail', () => {
  const secret = 'private-openai-secret';
  const env = { OPENAI_API_KEY: secret };
  const events = [
    ...normalizeCodexAppServerItem('completed', {
      type: 'agentMessage', id: 'agent-1', text: `Finished ${secret}`, phase: null,
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'reasoning', id: 'reason-1', summary: [`Checking ${secret}`, 'Running tests'],
      content: ['raw chain of thought must not appear'],
    }, env),
    ...normalizeCodexAppServerItem('started', {
      type: 'plan', id: 'plan-1', text: `Implement ${secret}`,
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'commandExecution', id: 'command-1', command: `printf ${secret}`,
      cwd: '/private/provider/worktree', status: 'completed', aggregatedOutput: `ok ${secret}`, exitCode: 0,
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'fileChange', id: 'file-1', status: 'failed', changes: [
        { path: '/private/provider/worktree/secret.ts', kind: 'update', diff: `+${secret}` },
      ],
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'mcpToolCall', id: 'mcp-1', server: 'files', tool: 'read', status: 'completed',
      arguments: { token: secret }, result: { content: [{ text: secret }], structuredContent: null }, error: null,
    }, env),
    ...normalizeCodexAppServerItem('started', {
      type: 'webSearch', id: 'search-1', query: `Codex ${secret}`, action: null, results: null,
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'error', id: 'error-1', message: `failed ${secret}`, additionalDetails: '/private/provider/error.json',
    }, env),
    ...normalizeCodexAppServerItem('completed', {
      type: 'contextCompaction', id: 'compact-1', path: '/private/provider/thread.json',
    }, env),
  ];

  assert.deepEqual(events.map((event) => event.type === 'upsert-msg' ? event.msg.kind : event.type), [
    'msg', 'reasoning', 'todo', 'tool', 'tool', 'tool', 'tool', 'msg', 'tool',
  ]);
  assert.deepEqual(events[0], { type: 'msg', msg: { kind: 'text', text: 'Finished [REDACTED]' } });
  assert.deepEqual(events[1], { type: 'upsert-msg', msg: {
    kind: 'reasoning', id: 'reason-1', text: 'Checking [REDACTED]\nRunning tests',
  } });
  assert.deepEqual(events[2], { type: 'upsert-msg', msg: {
    kind: 'todo', id: 'plan-1', items: [{ text: 'Implement [REDACTED]', completed: false }],
  } });
  assert.deepEqual(events[3], { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'command-1', name: 'shell', summary: 'printf [REDACTED]', status: 'ok',
    detail: 'ok [REDACTED]', detailTruncated: false,
  } });
  assert.ok(events.slice(4).every((event) => event.type === 'upsert-msg' || event.type === 'msg'));
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private-openai-secret|raw chain of thought|private\/provider/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /Context compacted/);
});

test('normalization ignores user messages, unknown variants, and provider thread paths', () => {
  assert.deepEqual(normalizeCodexAppServerItem('completed', {
    type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'private prompt' }],
  }), []);
  assert.deepEqual(normalizeCodexAppServerItem('completed', {
    type: 'futureItem', id: 'future-1', path: '/private/provider/thread.json', secret: 'do-not-log',
  }), []);
});

test('declined command execution normalizes to a terminal error row', () => {
  assert.deepEqual(normalizeCodexAppServerItem('completed', {
    type: 'commandExecution', id: 'command-declined', command: 'printf safe',
    status: 'declined', aggregatedOutput: 'not run',
  }), [{ type: 'upsert-msg', msg: {
    kind: 'tool', id: 'command-declined', name: 'shell', summary: 'printf safe', status: 'error',
    detail: 'not run', detailTruncated: false,
  } }]);
});

test('declined file change normalizes to a terminal error row', () => {
  const [event] = normalizeCodexAppServerItem('completed', {
    type: 'fileChange', id: 'file-declined', status: 'declined',
    changes: [{ path: '/private/worktree/safe.ts', kind: 'update' }],
  });
  assert.equal(event?.type, 'upsert-msg');
  assert.ok(event?.type === 'upsert-msg' && event.msg.kind === 'tool');
  assert.equal(event.msg.status, 'error');
});

test('normalization scrubs embedded absolute paths while preserving useful safe text', () => {
  const events = [
    ...normalizeCodexAppServerItem('completed', {
      type: 'agentMessage', id: 'agent-path', text: 'Read /private/worktree/result.txt successfully',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'reasoning', id: 'reason-path', summary: ['Inspect /private/worktree/result.txt before testing'],
    }),
    ...normalizeCodexAppServerItem('started', {
      type: 'plan', id: 'plan-path', text: 'Update /private/worktree/result.txt carefully',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'commandExecution', id: 'command-path',
      command: 'cat /private/worktree/result.txt && printf safe', status: 'completed',
      aggregatedOutput: 'read /private/worktree/result.txt successfully',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'error', id: 'error-path', message: 'Failed at /private/worktree/result.txt: permission denied',
    }),
  ];

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /\/private\/worktree/);
  assert.match(serialized, /Read|Inspect|Update|printf safe|permission denied/);
  assert.match(serialized, /\[path omitted\]/);
});

test('normalization scrubs every punctuation-delimited path without changing URL syntax', () => {
  const [event] = normalizeCodexAppServerItem('completed', {
    type: 'commandExecution', id: 'punctuated-paths', status: 'completed',
    command: 'inspect /private/a,/private/b;/private/c and </private/d> via https://example.test/a//b safely',
    aggregatedOutput: 'details /private/e,/private/f;/private/g and </private/h> remain useful',
  });

  assert.deepEqual(event, { type: 'upsert-msg', msg: {
    kind: 'tool', id: 'punctuated-paths', name: 'shell', status: 'ok',
    summary: 'inspect [path omitted],[path omitted];[path omitted] and <[path omitted]> via https://example.test/a//b safely',
    detail: 'details [path omitted],[path omitted];[path omitted] and <[path omitted]> remain useful',
    detailTruncated: false,
  } });
});

test('normalization removes file URIs from public text, summaries, and details', () => {
  const events = [
    ...normalizeCodexAppServerItem('completed', {
      type: 'agentMessage', id: 'agent-uri', text: 'Read file:///private/worktree/result.txt via https://example.test/docs',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'reasoning', id: 'reason-uri', summary: ['Inspect file:%2F%2F%2Fprivate%2Freason.txt'],
    }),
    ...normalizeCodexAppServerItem('started', {
      type: 'plan', id: 'plan-uri', text: 'Update file://localhost/private/worktree/result.txt',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'commandExecution', id: 'command-uri', status: 'completed',
      command: 'inspect file:///C:/Users/example/input.txt',
      aggregatedOutput: 'result at file:C:\\Users\\example\\output.txt',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'fileChange', id: 'change-uri', status: 'completed',
      changes: [{ path: 'file://fileserver/share/changed.ts', kind: 'update' }],
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'mcpToolCall', id: 'mcp-uri', status: 'completed', server: 'safe', tool: 'inspect',
      arguments: { uri: 'file:\\\\fileserver\\share\\input.txt' }, result: 'file:///private/result.json',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'webSearch', id: 'search-uri', status: 'completed', query: 'file:///private/query.txt',
    }),
    ...normalizeCodexAppServerItem('completed', {
      type: 'error', id: 'error-uri', message: 'failed at file:///private/error.txt',
    }),
  ];

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /file:(?:\/|%2f|[A-Za-z]:|\\)/i);
  assert.match(serialized, /\[path omitted\]/);
  assert.match(serialized, /https:\/\/example\.test\/docs/);
});

// Mutation caught: accepting an unsafe thread response emits and persists the
// raw value as vendor-session-id, then binds future resume traffic to it.
test('an absolute file URI in a provider thread id fails closed before binding or emission', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-thread-id-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const unsafeId = 'thread:file:///private/provider,thread;(secret).json';
  const supervisor = new ScriptedSupervisor(async ({ method }) => {
    if (method === 'thread/start') return safeThreadResponse(unsafeId, cwd);
    if (method === 'turn/start') return { turn: turn('safe-turn', 'inProgress') };
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];

  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'unsafe-thread', '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'unsafe-thread-prompt', env: {} }, (event) => events.push(event));

  await waitFor(
    () => events.some((event) => event.type === 'stopped' || event.type === 'vendor-session-id'),
    'unsafe thread-id decision',
    500,
  );
  assert.equal(supervisor.bound, null);
  assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);
  assert.equal(events.some((event) => event.type === 'vendor-session-id'), false);
  assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
  assert.equal(JSON.stringify(events).includes(unsafeId), false);
});

// Mutation caught: forwarding a legacy unsafe vendor thread id to thread/resume
// attempts provider recovery with an identifier that must instead fail closed.
test('an unsafe stored thread id is rejected before resume without rewriting it', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-resume-id-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const unsafeId = 'thread:file:///private/provider,resume;(secret).json';
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];

  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'unsafe-resume', '0.145.0')
    .start({
      cwd, prompt: prompt('continue'), promptId: 'unsafe-resume-prompt', env: {}, resumeId: unsafeId,
    }, (event) => events.push(event));

  await waitFor(
    () => events.some((event) => event.type === 'stopped')
      || supervisor.requests.some(({ method }) => method === 'thread/resume'),
    'unsafe stored thread-id decision',
    500,
  );
  assert.equal(supervisor.requests.some(({ method }) => method === 'thread/resume'), false);
  assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
  assert.equal(JSON.stringify(events).includes(unsafeId), false);
});

// Mutation caught: accepting an unsafe turn/start response lets the raw turn
// id become active and later derives a public todo id from it.
test('an absolute file URI in a provider turn id fails closed before public id derivation', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-turn-id-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const unsafeId = 'turn:file:///private/provider,turn;(secret).json';
  const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
    if (method === 'thread/start') return safeThreadResponse('safe-thread', (params as { cwd: string }).cwd);
    if (method === 'turn/start') return { turn: turn(unsafeId, 'inProgress') };
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];

  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'unsafe-turn', '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'unsafe-turn-prompt', env: {} }, (event) => events.push(event));

  await waitFor(
    () => events.some((event) => event.type === 'stopped')
      || events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'),
    'unsafe turn-id decision',
    500,
  );
  await new Promise((resolve) => setImmediate(resolve));
  supervisor.notify('turn/plan/updated', {
    threadId: 'safe-thread', turnId: unsafeId,
    plan: [{ step: 'must not publish', status: 'inProgress' }],
  });

  assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
  assert.equal(events.some((event) => event.type === 'upsert-msg' && event.msg.kind === 'todo'), false);
  assert.equal(JSON.stringify(events).includes(unsafeId), false);
});

// Mutation caught: forwarding an unsafe ThreadItem.id admits that raw value as
// a Registry upsert key even if every human-readable field is redacted.
test('an absolute file URI in a provider item id fails closed before Registry admission', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-item-id-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const unsafeId = 'item:file:///private/provider,item;(secret).json';
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];

  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'unsafe-item', '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'unsafe-item-prompt', env: {} }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));

  supervisor.notify('item/started', {
    threadId: 'thread-new', turnId: 'turn-1',
    item: {
      type: 'commandExecution', id: unsafeId, command: 'printf safe',
      status: 'inProgress', aggregatedOutput: null,
    },
  });

  assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
  assert.equal(events.some((event) => event.type === 'upsert-msg' && event.msg.id === unsafeId), false);
  assert.equal(JSON.stringify(events).includes(unsafeId), false);
});

// Mutation caught: a non-absolute file: prefix can mask a later absolute URI,
// allowing the mixed raw upsert key into persistence and public projection.
test('a non-absolute file prefix cannot hide an unsafe provider id from Registry', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-public-id-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const statePath = join(cwd, 'state.json');
  const registry = new Registry(statePath);
  const session = registry.create({
    provider: 'codex', account: 'codex', repo: cwd, cwd, branch: 'unsafe-id',
    title: 'unsafe id', codexTransport: 'app-server',
  });
  const unsafeId = 'item:file:notes,file:///private/provider,public;(secret).json';
  const supervisor = new ScriptedSupervisor();

  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, session.id, '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'unsafe-public-prompt', env: {} },
      (event) => registry.apply(session.id, event));
  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'));
  supervisor.notify('item/started', {
    threadId: 'thread-new', turnId: 'turn-1',
    item: {
      type: 'commandExecution', id: unsafeId, command: 'printf safe',
      status: 'inProgress', aggregatedOutput: null,
    },
  });
  await registry.save();

  assert.equal(registry.get(session.id)?.stoppedCode, 'codex_protocol_mismatch');
  assert.equal(JSON.stringify(registry.publicSessions()).includes(unsafeId), false);
  assert.equal((await readFile(statePath, 'utf8')).includes(unsafeId), false);
});

test('thread setup binds before one-at-a-time FIFO turns and preserves delivery, usage, plan, and status order', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-fifo-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const threadStart = deferred<unknown>();
  let turnNumber = 0;
  const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
    if (method === 'thread/start') return threadStart.promise;
    if (method === 'turn/start') return { turn: turn(`turn-${++turnNumber}`, 'inProgress') };
    if (method === 'turn/interrupt') return {};
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];
  const adapter = createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'session-fifo', '0.145.0');
  const handle = adapter.start({
    cwd,
    prompt: prompt('first'),
    promptId: 'prompt-1',
    env: {},
    codexSettings: {
      model: 'gpt-5.4',
      modelReasoningEffort: 'high',
      webSearchMode: 'live',
      networkAccessEnabled: true,
    },
  }, (event) => {
    events.push(event);
    if (event.type === 'prompt-delivery') supervisor.trace.push(`delivery:${event.id}:${event.delivery}`);
    if (event.type === 'status') supervisor.trace.push(`status:${event.status}`);
    if (event.type === 'usage') supervisor.trace.push('usage');
  });
  handle.send(prompt('second'), 'prompt-2');

  await waitFor(() => supervisor.requests.some(({ method }) => method === 'thread/start'), 'thread/start');
  assert.equal(supervisor.trace[0], 'route:registered');
  assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);
  assert.deepEqual(supervisor.requests[0], {
    sessionId: 'session-fifo',
    method: 'thread/start',
    params: {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: 'gpt-5.4',
      config: {
        web_search: 'live',
        sandbox_workspace_write: { network_access: true },
      },
    },
  });

  threadStart.resolve(safeThreadResponse('thread-fifo', cwd));
  await waitFor(() => supervisor.requests.filter(({ method }) => method === 'turn/start').length === 1, 'first turn/start');
  assert.deepEqual(supervisor.bound, { sessionId: 'session-fifo', threadId: 'thread-fifo' });
  assert.ok(events.some((event) => event.type === 'vendor-session-id' && event.id === 'thread-fifo'));
  assert.ok(supervisor.trace.indexOf('request:turn/start') < supervisor.trace.indexOf('delivery:prompt-1:sent'));
  assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/start').length, 1, 'second prompt waits');

  supervisor.notify('turn/plan/updated', {
    threadId: 'thread-fifo', turnId: 'turn-1', explanation: 'private reasoning',
    plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'inProgress' }],
  });
  supervisor.notify('thread/tokenUsage/updated', {
    threadId: 'thread-fifo', turnId: 'turn-1', tokenUsage: {
      total: {},
      last: {
        totalTokens: 19, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 2,
        outputTokens: 9, reasoningOutputTokens: 4,
      },
      modelContextWindow: 100,
    },
  });
  supervisor.notify('turn/completed', { threadId: 'thread-fifo', turn: turn('turn-1', 'completed') });

  await waitFor(() => supervisor.requests.filter(({ method }) => method === 'turn/start').length === 2, 'second turn/start');
  assert.deepEqual(supervisor.requests.filter(({ method }) => method === 'turn/start').map(({ params }) => params), [
    { threadId: 'thread-fifo', effort: 'high', input: [{ type: 'text', text: 'first', text_elements: [] }] },
    { threadId: 'thread-fifo', effort: 'high', input: [{ type: 'text', text: 'second', text_elements: [] }] },
  ]);
  const planEvents = events.filter((event) => event.type === 'upsert-msg' && event.msg.kind === 'todo');
  assert.equal(planEvents.length, 1);
  assert.deepEqual(planEvents[0], { type: 'upsert-msg', msg: {
    kind: 'todo', id: 'codex-plan:turn-1',
    items: [{ text: 'Inspect', completed: true }, { text: 'Test', completed: false }],
  } });
  const usageIndex = supervisor.trace.indexOf('usage');
  const doneIndex = supervisor.trace.indexOf('status:done');
  const nextWorkingIndex = supervisor.trace.indexOf('status:working', doneIndex + 1);
  const nextRequestIndex = supervisor.trace.lastIndexOf('request:turn/start');
  const nextDeliveryIndex = supervisor.trace.indexOf('delivery:prompt-2:sent');
  assert.ok(usageIndex !== -1 && usageIndex < doneIndex);
  assert.ok(doneIndex < nextWorkingIndex && nextWorkingIndex < nextRequestIndex);
  assert.ok(nextRequestIndex < nextDeliveryIndex);
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', inputTokens: 10, outputTokens: 9, cachedInputTokens: 3,
    cacheWriteInputTokens: 2, reasoningOutputTokens: 4,
  });
});

test('dispatch acknowledgement distinguishes a pre-write failure from a lost response', async (t) => {
  for (const acknowledged of [false, true]) {
    const cwd = await mkdtemp(join(tmpdir(), `switchboard-app-adapter-dispatch-${acknowledged}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const response = deferred<unknown>();
    const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
      if (method === 'thread/start') return safeThreadResponse(`thread-dispatch-${acknowledged}`, (params as { cwd: string }).cwd);
      if (method === 'turn/start') return response.promise;
      throw new Error(`unexpected ${method}`);
    }, false);
    const events: AdapterEvent[] = [];
    createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor,
      `dispatch-${acknowledged}`,
      '0.145.0',
    ).start({ cwd, prompt: prompt('dispatch me'), promptId: 'dispatch-prompt', env: {} }, (event) => events.push(event));

    await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'), 'pending turn/start write');
    assert.equal(events.some((event) => event.type === 'prompt-delivery'), false, 'the prompt stays queued before write acknowledgement');
    if (acknowledged) {
      supervisor.dispatchNext();
      await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));
    }
    response.reject(new Error(acknowledged ? 'response lost after dispatch' : 'write rejected before dispatch'));
    await waitFor(() => events.some((event) => event.type === 'stopped'), 'terminal request failure');

    assert.deepEqual(events.filter((event) => event.type === 'prompt-delivery'), [{
      type: 'prompt-delivery',
      id: 'dispatch-prompt',
      delivery: acknowledged ? 'sent' : 'unsent',
    }]);
  }
});

test('delayed stdin callbacks after stop correct only the accepted prompt through the production boundary', async (t) => {
  for (const accepted of [true, false]) {
    await t.test(accepted ? 'successful callback' : 'failed callback', async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), 'sb-delivery-stop-'));
      const registry = new Registry(join(cwd, 'state.json'));
      const session = registry.create({ provider: 'codex', account: 'codex', repo: cwd, cwd,
        branch: 'race', title: 'race', codexTransport: 'app-server' });
      const firstId = registry.appendPrompt(session.id, 'first', 'queued');
      const requests: Array<{ id: number; method: string; params?: any }> = [];
      const callbacks: Array<(error?: Error | null) => void> = [];
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr,
        kill() { queueMicrotask(() => child.emit('close', 0, null)); return true; } });
      stdin.on('finish', () => child.emit('close', 0, null));
      const respond = (id: number, result: unknown) => stdout.write(`${JSON.stringify({ id, result })}\n`);
      stdin.write = ((chunk: string, callback: (error?: Error | null) => void) => {
        const request = JSON.parse(String(chunk));
        requests.push(request);
        if (request.method === 'turn/start') { callbacks.push(callback); return true; }
        callback?.();
        if (request.id === undefined) return true;
        let result: unknown = {};
        if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true };
        if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: null, limitName: null,
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null,
          credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
          rateLimitsByLimitId: null, rateLimitResetCredits: null };
        if (request.method.startsWith('thread/')) result = safeThreadResponse('delivery-thread', cwd);
        queueMicrotask(() => respond(request.id, result));
        return true;
      }) as typeof stdin.write;
      const supervisor = new CodexAppServerSupervisor({
        runtime: { source: 'explicit', commandPath: 'fixture', version: '0.145.0', env: {}, diagnostics: [] },
        verifyContract: async () => {},
        clientFactory: (options) => new AppServerClient({ ...options, childFactory: () => child }),
      });
      t.after(async () => {
        await supervisor.close(); stdin.destroy(); stdout.destroy(); stderr.destroy();
        await rm(cwd, { recursive: true, force: true });
      });
      await supervisor.ensureTurnTransport();
      const events: AdapterEvent[] = [];
      const emit = (event: AdapterEvent) => { events.push(event); registry.apply(session.id, event); };
      const handle = createCodexAppServerAdapter(supervisor, session.id, '0.145.0')
        .start({ cwd, prompt: prompt('first'), promptId: firstId, env: {} }, emit);
      await waitFor(() => callbacks.length === 1);
      const otherId = registry.appendPrompt(session.id, 'queued second', 'queued');
      handle.send(prompt('queued second'), otherId);
      handle.stop();
      assert.equal(session.status, 'working', 'stop remains settling until the pending turn ownership resolves');
      assert.equal(events.some((event) => event.type === 'stopped'), false);
      callbacks[0](accepted ? null : new Error('private write failure'));
      if (accepted) {
        const request = requests.find((value) => value.method === 'turn/start')!;
        respond(request.id, { turn: turn('old-turn', 'inProgress') });
        await waitFor(() => requests.some((value) => value.method === 'turn/interrupt'));
      } else await new Promise((resolve) => setImmediate(resolve));
      await waitFor(() => events.some((event) => event.type === 'stopped'));
      const delivery = (id: string) => session.transcript.find((msg) => msg.kind === 'user' && msg.id === id);
      assert.equal((delivery(firstId) as { delivery: string }).delivery, accepted ? 'sent' : 'unsent');
      assert.equal((delivery(otherId) as { delivery: string }).delivery, 'unsent');
      assert.deepEqual({ status: session.status, reason: session.stoppedReason, code: session.stoppedCode }, {
        status: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped',
      });
      assert.equal(events.filter((event) => event.type === 'stopped').length, 1);
      const before = JSON.stringify(session);
      for (const event of [
        { type: 'status', status: 'working' }, { type: 'msg', msg: { kind: 'text', text: 'late' } },
        { type: 'stopped', reason: 'replacement', code: 'codex_stream_failed' },
        { type: 'prompt-delivery', id: 'unknown', delivery: 'sent' },
        { type: 'prompt-delivery', id: firstId, delivery: 'unsent' },
      ] as AdapterEvent[]) registry.apply(session.id, event);
      assert.equal(JSON.stringify(session), before);
      await registry.save();
      const loaded = await Registry.load(join(cwd, 'state.json'));
      assert.equal((loaded.get(session.id)!.transcript.find((msg) => msg.kind === 'user' && msg.id === firstId) as { delivery: string }).delivery,
        accepted ? 'sent' : 'unsent');
      if (accepted) {
        registry.revive(session.id);
        const resumeId = registry.appendPrompt(session.id, 'resume only', 'queued');
        const resumed = createCodexAppServerAdapter(supervisor, session.id, '0.145.0')
          .start({ cwd, prompt: prompt('resume only'), promptId: resumeId, resumeId: 'delivery-thread', env: {} }, emit);
        await waitFor(() => callbacks.length === 2);
        callbacks[1](null);
        const starts = requests.filter((value) => value.method === 'turn/start');
        respond(starts[1].id, { turn: turn('new-turn', 'inProgress') });
        assert.deepEqual(starts.map((value) => value.params.input[0].text), ['first', 'resume only']);
        assert.equal((delivery(otherId) as { delivery: string }).delivery, 'unsent');
        assert.equal((delivery(resumeId) as { delivery: string }).delivery, 'sent');
        resumed.stop();
      }
    });
  }
});

test('retryable error notifications retain the active turn, route, and image snapshot', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-retryable-error-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'retryable-error',
    '0.145.0',
  ).start({ cwd, prompt: await imagePrompt(cwd), promptId: 'retryable-image', env: {} }, (event) => events.push(event));
  handle.send(prompt('queued after retry'), 'after-retry');

  await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.id === 'retryable-image' && event.delivery === 'sent'));
  const firstStart = supervisor.requests.find(({ method }) => method === 'turn/start');
  const snapshotPath = ((firstStart?.params as { input: Array<{ type: string; path?: string }> }).input)
    .find((input) => input.type === 'localImage')?.path;
  assert.ok(snapshotPath);
  assert.equal(await pathExists(snapshotPath), true);

  supervisor.notify('error', {
    threadId: 'thread-new', turnId: 'turn-1', willRetry: true,
    error: { message: 'temporary transport error', codexErrorInfo: null, additionalDetails: null },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((event) => event.type === 'stopped'), false);
  assert.equal(supervisor.detached, 0);
  assert.ok(supervisor.route);
  assert.equal(await pathExists(snapshotPath), true, 'retry ownership keeps the image snapshot alive');
  assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/start').length, 1, 'the queued prompt still waits');

  supervisor.notify('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'completed') });
  await waitFor(() => supervisor.requests.filter(({ method }) => method === 'turn/start').length === 2, 'post-retry queued turn');
  await waitFor(async () => !await pathExists(snapshotPath), 'completed retry snapshot cleanup');
  supervisor.notify('error', {
    threadId: 'thread-new', turnId: 'turn-2', willRetry: false,
    error: { message: 'terminal transport error', codexErrorInfo: null, additionalDetails: null },
  });
  await waitFor(() => events.some((event) => event.type === 'stopped'), 'non-retryable terminal error');
  assert.equal(events.find((event) => event.type === 'stopped')?.code, 'codex_stream_failed');
  assert.equal(supervisor.detached, 1);
});

test('adapter plan and terminal error events scrub embedded absolute paths', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-event-paths-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'event-paths', '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'event-paths', env: {} }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));

  supervisor.notify('turn/plan/updated', {
    threadId: 'thread-new', turnId: 'turn-1',
    plan: [{ step: 'Inspect /private/worktree/result.txt and file:///private/worktree/plan.txt carefully', status: 'inProgress' }],
  });
  supervisor.notify('turn/completed', {
    threadId: 'thread-new',
    turn: turn('turn-1', 'failed', {
      message: 'Failed at /private/worktree/result.txt and file://localhost/private/worktree/error.txt: permission denied',
      codexErrorInfo: null,
      additionalDetails: 'file:%2F%2F%2Fprivate%2Fprovider%2Ferror.json',
    }),
  });
  await waitFor(() => events.some((event) => event.type === 'stopped'), 'path-scrubbed terminal event');

  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /\/private\/(?:worktree|provider)/);
  assert.doesNotMatch(serialized, /file:(?:\/|%2f|[A-Za-z]:|\\)/i);
  assert.match(serialized, /Inspect|carefully|permission denied/);
});

test('typed UsageLimitExceeded failures are classified internally on both terminal paths without recovery or details', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'sb-typed-turn-failure-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const path of ['notification', 'failed-turn'] as const) {
    for (const [codexErrorInfo, kind] of [
      ['usageLimitExceeded', 'UsageLimitExceeded'],
      [null, 'Other'],
      [{ httpConnectionFailed: { httpStatusCode: 429 } }, 'Other'],
      ['future-error', 'Other'],
    ] as const) {
      const failure = () => {
        let typedReads = 0;
        return {
          typedReads: () => typedReads,
          value: {
            message: 'Failure at /private/provider/data.txt',
            get codexErrorInfo(): unknown { typedReads += 1; return codexErrorInfo; },
            get additionalDetails(): never { throw new Error('additionalDetails must never be read'); },
          },
        };
      };
      const direct = failure();
      assert.deepEqual(appServerAdapter.classifyCodexAppServerTurnFailure(direct.value, {}), {
        kind, reason: 'Failure at [path omitted]',
      });
      assert.equal(direct.typedReads(), 1);
      const terminal = failure();
      const registry = new Registry(join(cwd, 'state.json'));
      const session = registry.create({ provider: 'codex', account: 'codex', repo: cwd, cwd,
        branch: 'failure', title: 'failure', codexTransport: 'app-server' });
      const firstId = registry.appendPrompt(session.id, 'first', 'queued');
      const supervisor = new ScriptedSupervisor();
      const events: AdapterEvent[] = [];
      const handle = createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, session.id, '0.145.0')
        .start({ cwd, prompt: prompt('first'), promptId: firstId, env: {} }, (event) => {
          events.push(event); registry.apply(session.id, event);
        });
      await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'));
      const queuedId = registry.appendPrompt(session.id, 'queued', 'queued');
      handle.send(prompt('queued'), queuedId);
      if (path === 'notification') supervisor.notify('error', {
        threadId: 'thread-new', turnId: 'turn-1', willRetry: false, error: terminal.value,
      });
      else supervisor.notify('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'failed', terminal.value) });
      await waitFor(() => session.status === 'stopped');
      assert.equal(terminal.typedReads(), 1, `${path} must retain the typed discriminator`);
      assert.equal(session.stoppedCode, 'codex_stream_failed');
      assert.equal(session.stoppedReason, 'Failure at [path omitted]');
      assert.equal(supervisor.detached, 1);
      assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/start').length, 1);
      assert.deepEqual(session.transcript.filter((msg) => msg.kind === 'user').map((msg) => msg.delivery), ['sent', 'unsent']);
      assert.equal(events.filter((event) => event.type === 'stopped').length, 1);
      await registry.save();
      for (const serialized of [JSON.stringify(events), JSON.stringify(registry.publicSessions()), await readFile(join(cwd, 'state.json'), 'utf8')]) {
        assert.doesNotMatch(serialized, /codex_usage_limited|UsageLimitExceeded|usageLimitExceeded|codexErrorInfo|additionalDetails|\/private\/provider/);
      }
    }
  }
});

test('thread safety mismatches fail closed before turn/start', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-safety-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const mismatches: Array<[string, (response: Record<string, unknown>) => void]> = [
    ['cwd', (response) => { response.cwd = `${cwd}-other`; }],
    ['thread cwd', (response) => { (response.thread as Record<string, unknown>).cwd = `${cwd}-other`; }],
    ['approval policy', (response) => { response.approvalPolicy = 'on-request'; }],
    ['sandbox', (response) => { response.sandbox = { type: 'dangerFullAccess' }; }],
  ];

  for (const [label, mutate] of mismatches) {
    const response = safeThreadResponse(`thread-${label}`, cwd);
    mutate(response);
    const supervisor = new ScriptedSupervisor(async ({ method }) => {
      if (method === 'thread/start') return response;
      assert.fail(`${label} mismatch must prevent ${method}`);
    });
    const events: AdapterEvent[] = [];
    createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor,
      `session-${label}`,
      '0.145.0',
    ).start({ cwd, prompt: prompt('inspect'), promptId: `prompt-${label}`, env: {} }, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'stopped'), `${label} safety stop`);
    assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);
    assert.ok(events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'unsent'));
    assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
  }
});

test('resume uses only the stored thread ID', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-resume-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'session-resume', '0.145.0')
    .start({ cwd, prompt: prompt('continue'), promptId: 'resume-prompt', env: {}, resumeId: 'stored-thread' },
      (event) => events.push(event));

  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'), 'resumed turn');
  assert.deepEqual(supervisor.requests.filter(({ method }) => method.startsWith('thread/')).map(({ method, params }) => ({ method, params })), [
    { method: 'thread/resume', params: {
      threadId: 'stored-thread', cwd, approvalPolicy: 'never', sandbox: 'workspace-write',
    } },
  ]);
  assert.deepEqual(supervisor.bound, { sessionId: 'session-resume', threadId: 'stored-thread' });
  assert.ok(events.some((event) => event.type === 'vendor-session-id' && event.id === 'stored-thread'));
});

test('reasoning effort is top-level per turn for start and resume, and omitted when inherited', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'sb-effort-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const resumeId of [undefined, 'stored-thread']) {
    for (const effort of [undefined, 'high'] as const) {
      const supervisor = new ScriptedSupervisor();
      const handle = createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'effort', '0.145.0')
        .start({ cwd, prompt: prompt('effort'), env: {}, resumeId,
          ...(effort ? { codexSettings: { modelReasoningEffort: effort } } : {}) }, () => {});
      await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'));
      const setup = supervisor.requests[0].params as Record<string, unknown>;
      assert.equal(Object.hasOwn(setup, 'config'), false);
      const request = supervisor.requests.find(({ method }) => method === 'turn/start')!.params as Record<string, unknown>;
      assert.equal(Object.hasOwn(request, 'effort'), effort !== undefined);
      assert.equal(request.effort, effort);
      assert.equal(Object.hasOwn(request, 'config'), false);
      handle.stop();
    }
  }
});

test('stop interrupts once, marks queued prompts unsent, and settles once despite late completion', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-stop-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-stop',
    '0.145.0',
  ).start({ cwd, prompt: prompt('hold'), promptId: 'active', env: {} }, (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.id === 'active'), 'active delivery');
  handle.send(prompt('queued one'), 'queued-1');
  handle.send(prompt('queued two'), 'queued-2');
  handle.stop();
  handle.stop();
  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/interrupt'), 'turn interrupt');
  supervisor.notify('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'interrupted') });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/interrupt').length, 1);
  assert.deepEqual(supervisor.requests.find(({ method }) => method === 'turn/interrupt')?.params, {
    threadId: 'thread-new', turnId: 'turn-1',
  });
  assert.deepEqual(events.filter((event) => event.type === 'prompt-delivery'), [
    { type: 'prompt-delivery', id: 'active', delivery: 'sent' },
    { type: 'prompt-delivery', id: 'queued-1', delivery: 'unsent' },
    { type: 'prompt-delivery', id: 'queued-2', delivery: 'unsent' },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'stopped'), [
    { type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped' },
  ]);
  assert.equal(supervisor.detached, 1);
});

test('handle quiescence waits for writer settlement and resolves once across a child-exit interrupt race', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-quiescence-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const interrupt = deferred<unknown>();
  const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
    if (method === 'thread/start') return safeThreadResponse('thread-quiescence', (params as { cwd: string }).cwd);
    if (method === 'turn/start') return { turn: turn('turn-quiescence', 'inProgress') };
    if (method === 'turn/interrupt') return interrupt.promise;
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-quiescence',
    '0.145.0',
  ).start({ cwd, prompt: prompt('hold'), promptId: 'active', env: {} }, (event) => events.push(event));

  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'), 'active turn');
  assert.ok(handle.quiescence, 'app-server handles expose writer quiescence');
  let settled = 0;
  void handle.quiescence.then(() => { settled += 1; });
  handle.stop();
  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/interrupt'), 'gated interrupt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 0, 'interrupt dispatch alone does not prove writer quiescence');

  supervisor.fatal('Codex app-server transport crashed. Retry the session manually.', 'codex_transport_crashed');
  await handle.quiescence;
  assert.equal(settled, 1, 'child exit proves the writer quiescent');
  assert.deepEqual(events.filter((event) => event.type === 'stopped'), [
    { type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped' },
  ]);
  assert.equal(supervisor.detached, 1);

  interrupt.resolve({});
  supervisor.notify('turn/completed', {
    threadId: 'thread-quiescence', turn: turn('turn-quiescence', 'interrupted'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 1);
  assert.equal(events.filter((event) => event.type === 'stopped').length, 1);
  assert.equal(supervisor.detached, 1);
});

test('handle quiescence joins an in-flight thread setup that may still access the worktree', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-setup-quiescence-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const setup = deferred<unknown>();
  t.after(() => setup.resolve(safeThreadResponse('setup-thread', cwd)));
  const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
    if (method === 'thread/start') return setup.promise;
    if (method === 'turn/start') return { turn: turn('unexpected-turn', 'inProgress') };
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-setup-quiescence',
    '0.145.0',
  ).start({ cwd, prompt: prompt('hold'), promptId: 'setup-prompt', env: {} }, (event) => events.push(event));

  await waitFor(() => supervisor.requests.some(({ method }) => method === 'thread/start'), 'gated thread setup');
  assert.ok(handle.quiescence);
  let settled = false;
  void handle.quiescence.then(() => { settled = true; });
  handle.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'quiescence must retain setup ownership until its worktree request settles');

  setup.resolve(safeThreadResponse('setup-thread', cwd));
  await handle.quiescence;
  assert.equal(settled, true);
  assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);
  assert.deepEqual(events.filter((event) => event.type === 'prompt-delivery'), [
    { type: 'prompt-delivery', id: 'setup-prompt', delivery: 'unsent' },
  ]);
});

test('handle quiescence releases setup ownership when validation fails before a request', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-validation-quiescence-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-validation-quiescence',
    '0.145.0',
  ).start({
    cwd,
    prompt: prompt('hold'),
    promptId: 'validation-prompt',
    env: {},
    codexSettings: { modelReasoningEffort: 7 as unknown as string },
  }, (event) => events.push(event));

  let settled = false;
  void handle.quiescence?.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'a pre-request setup failure must not retain worktree ownership');
  assert.equal(supervisor.requests.length, 0);
  assert.equal(events.filter((event) => event.type === 'stopped').length, 1);
});

test('handle quiescence joins an in-flight image snapshot read before worktree removal', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-snapshot-quiescence-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const queuedPrompt = await imagePrompt(cwd);
  const imagePath = await realpath(queuedPrompt.attachments[0].absolutePath);
  const readEntered = deferred<void>();
  const releaseRead = deferred<void>();
  const originalOpen = fs.promises.open;
  let gated = false;
  (fs.promises as any).open = async (...args: any[]) => {
    if (!gated && String(args[0]) === imagePath && typeof args[1] === 'number') {
      gated = true;
      readEntered.resolve();
      await releaseRead.promise;
    }
    return originalOpen(...args as Parameters<typeof originalOpen>);
  };
  syncBuiltinESMExports();
  t.after(() => {
    releaseRead.resolve();
    (fs.promises as any).open = originalOpen;
    syncBuiltinESMExports();
  });

  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-snapshot-quiescence',
    '0.145.0',
  ).start({ cwd, prompt: queuedPrompt, promptId: 'snapshot-prompt', env: {} }, (event) => events.push(event));

  await waitFor(
    () => gated || supervisor.requests.some(({ method }) => method === 'turn/start'),
    'gated snapshot read',
  );
  assert.equal(gated, true, 'the test must pause the production worktree read before turn dispatch');
  assert.ok(handle.quiescence);
  let settled = false;
  void handle.quiescence.then(() => { settled = true; });
  handle.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'quiescence must retain ownership while snapshotting reads the worktree');
  assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);

  releaseRead.resolve();
  await handle.quiescence;
  assert.equal(settled, true);
  assert.equal(supervisor.requests.some(({ method }) => method === 'turn/start'), false);
  assert.deepEqual(events.filter((event) => event.type === 'prompt-delivery'), [
    { type: 'prompt-delivery', id: 'snapshot-prompt', delivery: 'unsent' },
  ]);
});

test('a rejected established interrupt retires the shared generation and every sibling route before restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-rejected-interrupt-'));
  const cwdA = join(root, 'a');
  const cwdB = join(root, 'b');
  await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
  const scheduled: Array<() => void> = [];
  const protocols: AppServerClientOptions[] = [];
  const closed: boolean[] = [];
  const turnInputs: string[] = [];
  let turnNumber = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtime: { source: 'explicit', commandPath: 'fixture', version: '0.145.0', env: {}, diagnostics: [] },
    verifyContract: async () => {},
    clientFactory: (options) => {
      const generation = protocols.push(options) - 1;
      closed[generation] = false;
      return {
        request: async <T>(method: string, params?: unknown, onDispatched?: () => void): Promise<T> => {
          if (method === 'initialize') return { initialized: true } as T;
          if (method === 'account/read') {
            return { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true } as T;
          }
          if (method === 'account/rateLimits/read') {
            return { rateLimits: { limitId: null, limitName: null,
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null,
              credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
            rateLimitsByLimitId: null, rateLimitResetCredits: null } as T;
          }
          if (method === 'thread/start' || method === 'thread/resume') {
            const value = params as { cwd: string; threadId?: string };
            const id = value.threadId ?? (value.cwd === cwdA ? 'thread-a' : 'thread-b');
            return safeThreadResponse(id, value.cwd) as T;
          }
          if (method === 'turn/start') {
            onDispatched?.();
            const input = (params as { input: Array<{ type: string; text?: string }> }).input;
            turnInputs.push(input.find((item) => item.type === 'text')?.text ?? '');
            return { turn: turn(`turn-${++turnNumber}`, 'inProgress') } as T;
          }
          if (method === 'turn/interrupt') {
            throw new Error('private interrupt rejection at /private/provider/token.json');
          }
          throw new Error(`unexpected ${method}`);
        },
        notify: () => {},
        respondError: () => {},
        close: async () => { closed[generation] = true; },
      };
    },
    setTimer: (callback) => { scheduled.push(callback); return callback; },
    clearTimer: () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.ensureTurnTransport();

  const eventsA: AdapterEvent[] = [];
  const eventsB: AdapterEvent[] = [];
  const handleA = createCodexAppServerAdapter(supervisor, 'rejected-a', '0.145.0')
    .start({ cwd: cwdA, prompt: prompt('first-a'), promptId: 'first-a', env: {} }, (event) => eventsA.push(event));
  createCodexAppServerAdapter(supervisor, 'rejected-b', '0.145.0')
    .start({ cwd: cwdB, prompt: prompt('first-b'), promptId: 'first-b', env: {} }, (event) => eventsB.push(event));
  await waitFor(() => turnInputs.length === 2, 'two established turns');

  handleA.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed[0], true, 'the rejected interrupt must terminate the writer generation');
  assert.equal(eventsA.filter((event) => event.type === 'stopped').length, 1);
  assert.equal(eventsB.filter((event) => event.type === 'stopped').length, 1);
  assert.ok(eventsA.some((event) => event.type === 'stopped' && event.code === 'codex_user_stopped'));
  assert.ok(eventsB.some((event) => event.type === 'stopped' && event.code === 'codex_transport_crashed'));
  assert.equal(JSON.stringify([...eventsA, ...eventsB]).includes('/private/provider/token.json'), false);
  assert.deepEqual(eventsA.filter((event) => event.type === 'prompt-delivery'), [
    { type: 'prompt-delivery', id: 'first-a', delivery: 'sent' },
  ]);
  assert.deepEqual(eventsB.filter((event) => event.type === 'prompt-delivery'), [
    { type: 'prompt-delivery', id: 'first-b', delivery: 'sent' },
  ]);
  assert.equal(scheduled.length, 1, 'generation retirement keeps the existing restart policy');

  scheduled[0]();
  await waitFor(() => protocols.length === 2, 'replacement generation');
  const resumedEvents: AdapterEvent[] = [];
  createCodexAppServerAdapter(supervisor, 'rejected-a', '0.145.0')
    .start({ cwd: cwdA, prompt: prompt('later-a'), promptId: 'later-a', env: {}, resumeId: 'thread-a' },
      (event) => resumedEvents.push(event));
  await waitFor(() => resumedEvents.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));
  assert.deepEqual(turnInputs.slice(0, 2).sort(), ['first-a', 'first-b']);
  assert.equal(turnInputs[2], 'later-a', 'restart never replays an accepted prompt');
});

test('post-dispatch protocol failures retire the exact generation before terminal publication and settle siblings once', async (t) => {
  for (const scenario of ['unsafe response', 'response/start mismatch', 'unsafe routed turn', 'unsafe nested item'] as const) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-protocol-retire-'));
      const cwdA = join(root, 'a');
      const cwdB = join(root, 'b');
      await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
      const responseA = deferred<unknown>();
      const responseB = deferred<unknown>();
      const closeGate = deferred<void>();
      const scheduled: Array<() => void> = [];
      const trace: string[] = [];
      let protocol!: AppServerClientOptions;
      let closeStarts = 0;
      let turnStarts = 0;
      const supervisor = new CodexAppServerSupervisor({
        runtime: { source: 'explicit', commandPath: 'fixture', version: '0.145.0', env: {}, diagnostics: [] },
        verifyContract: async () => {},
        clientFactory: (options) => {
          protocol = options;
          return {
            request: async <T>(method: string, params?: unknown, onDispatched?: () => void): Promise<T> => {
              if (method === 'initialize') return { initialized: true } as T;
              if (method === 'account/read') {
                return { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true } as T;
              }
              if (method === 'account/rateLimits/read') {
                return { rateLimits: { limitId: null, limitName: null,
                  primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null,
                  credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
                rateLimitsByLimitId: null, rateLimitResetCredits: null } as T;
              }
              if (method === 'thread/start') {
                const value = params as { cwd: string };
                return safeThreadResponse(value.cwd === cwdA ? 'thread-a' : 'thread-b', value.cwd) as T;
              }
              if (method === 'turn/start') {
                onDispatched?.();
                turnStarts += 1;
                const threadId = (params as { threadId: string }).threadId;
                return (threadId === 'thread-a' ? responseA.promise : responseB.promise) as Promise<T>;
              }
              throw new Error(`unexpected ${method}`);
            },
            notify: () => {},
            respondError: () => {},
            close: async () => {
              closeStarts += 1;
              trace.push('close:start');
              await closeGate.promise;
              trace.push('close:done');
            },
          };
        },
        setTimer: (callback) => { scheduled.push(callback); return callback; },
        clearTimer: () => {},
      });
      t.after(async () => {
        closeGate.resolve();
        await supervisor.close();
        await rm(root, { recursive: true, force: true });
      });
      await supervisor.ensureTurnTransport();

      const eventsA: AdapterEvent[] = [];
      const eventsB: AdapterEvent[] = [];
      createCodexAppServerAdapter(supervisor, `protocol-a-${scenario}`, '0.145.0')
        .start({ cwd: cwdA, prompt: prompt('first-a'), promptId: 'first-a', env: {} }, (event) => {
          eventsA.push(event);
          if (event.type === 'stopped') trace.push(`a:stopped:${event.code}`);
        });
      createCodexAppServerAdapter(supervisor, `protocol-b-${scenario}`, '0.145.0')
        .start({ cwd: cwdB, prompt: prompt('first-b'), promptId: 'first-b', env: {} }, (event) => {
          eventsB.push(event);
          if (event.type === 'stopped') trace.push(`b:stopped:${event.code}`);
        });
      await waitFor(() => turnStarts === 2, 'two accepted protocol test turns');

      responseB.resolve({ turn: turn('turn-b', 'inProgress') });
      if (scenario === 'unsafe response') {
        responseA.resolve({ turn: turn('turn:file:///private/provider/secret.json', 'inProgress') });
      } else if (scenario === 'response/start mismatch') {
        protocol.onNotification('turn/started', {
          threadId: 'thread-a', turn: turn('notification-turn-a', 'inProgress'),
        });
        responseA.resolve({ turn: turn('response-turn-a', 'inProgress') });
      } else {
        responseA.resolve({ turn: turn('turn-a', 'inProgress') });
        await new Promise((resolve) => setImmediate(resolve));
        if (scenario === 'unsafe routed turn') {
          protocol.onNotification('item/started', {
            threadId: 'thread-a', turnId: 'turn:file:///private/provider/secret.json',
            item: { type: 'commandExecution', id: 'safe-item', command: 'true', status: 'inProgress' },
          });
        } else {
          protocol.onNotification('item/started', {
            threadId: 'thread-a', turnId: 'turn-a',
            item: {
              type: 'commandExecution', id: 'item:file:///private/provider/secret.json',
              command: 'true', status: 'inProgress', aggregatedOutput: null,
            },
          });
        }
      }
      await new Promise((resolve) => setImmediate(resolve));

      try {
        assert.equal(closeStarts, 1, 'the exact writer generation begins retirement');
        assert.equal(eventsA.some((event) => event.type === 'stopped'), false,
          'the affected route cannot publish terminal state before child retirement');
        assert.equal(eventsB.some((event) => event.type === 'stopped'), false,
          'the sibling route remains owned until child retirement');
        assert.throws(
          () => supervisor.registerSession(`protocol-a-${scenario}`, { onNotification() {}, onFatal() {} }),
          /already registered/i,
          'resume registration remains unavailable during retirement',
        );
      } finally {
        closeGate.resolve();
      }

      await waitFor(() => eventsA.some((event) => event.type === 'stopped')
        && eventsB.some((event) => event.type === 'stopped'), 'protocol generation settlement');
      protocol.onNotification('item/started', {
        threadId: 'thread-a', turnId: 'turn-a', item: { type: 'commandExecution', id: 'late-item' },
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(eventsA.filter((event) => event.type === 'stopped').length, 1);
      assert.equal(eventsB.filter((event) => event.type === 'stopped').length, 1);
      assert.ok(eventsA.some((event) => event.type === 'stopped' && event.code === 'codex_protocol_mismatch'));
      assert.ok(eventsB.some((event) => event.type === 'stopped' && event.code === 'codex_transport_crashed'));
      assert.ok(trace.indexOf('close:done') < trace.findIndex((entry) => entry.startsWith('a:stopped:')));
      assert.ok(trace.indexOf('close:done') < trace.findIndex((entry) => entry.startsWith('b:stopped:')));
      assert.equal(scheduled.length, 1, 'retirement retains the existing bounded restart policy');
      assert.doesNotMatch(JSON.stringify([...eventsA, ...eventsB]), /private\/provider|secret\.json/);
    });
  }
});

test('a typed supervisor protocol mismatch stays typed and sanitized through the production adapter', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-typed-protocol-'));
  let closes = 0;
  const supervisor = new CodexAppServerSupervisor({
    runtime: { source: 'explicit', commandPath: 'fixture', version: '0.145.0', env: {}, diagnostics: [] },
    verifyContract: async () => {},
    clientFactory: () => ({
      request: async <T>(method: string, params?: unknown, onDispatched?: () => void): Promise<T> => {
        if (method === 'initialize') return { initialized: true } as T;
        if (method === 'account/read') {
          return { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true } as T;
        }
        if (method === 'account/rateLimits/read') {
          return { rateLimits: { limitId: null, limitName: null,
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: null,
            credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null },
          rateLimitsByLimitId: null, rateLimitResetCredits: null } as T;
        }
        if (method === 'thread/start') return safeThreadResponse('typed-thread', (params as { cwd: string }).cwd) as T;
        if (method === 'turn/start') {
          onDispatched?.();
          return { turn: turn('turn:file:///private/provider/typed-secret.json', 'inProgress') } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
      notify: () => {},
      respondError: () => {},
      close: async () => { closes += 1; },
    }),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await supervisor.ensureTurnTransport();
  const events: AdapterEvent[] = [];

  createCodexAppServerAdapter(supervisor, 'typed-protocol', '0.145.0')
    .start({ cwd, prompt: prompt('inspect'), promptId: 'typed-prompt', env: {} }, (event) => events.push(event));
  await waitFor(() => events.some((event) => event.type === 'stopped'), 'typed protocol stop');

  assert.equal(closes, 1);
  assert.deepEqual(events.filter((event) => event.type === 'stopped'), [{
    type: 'stopped', reason: 'Codex turn identifier is invalid.', code: 'codex_protocol_mismatch',
  }]);
  assert.doesNotMatch(JSON.stringify(events), /private\/provider|typed-secret/);
});

test('stop interrupts a turn accepted just before its response returns', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-stop-pending-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const accepted = deferred<unknown>();
  const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
    if (method === 'thread/start') return safeThreadResponse('thread-pending-stop', (params as { cwd: string }).cwd);
    if (method === 'turn/start') return accepted.promise;
    if (method === 'turn/interrupt') return {};
    throw new Error(`unexpected ${method}`);
  });
  const events: AdapterEvent[] = [];
  const handle = createCodexAppServerAdapter(
    supervisor as unknown as CodexAppServerSupervisor,
    'session-pending-stop',
    '0.145.0',
  ).start({ cwd, prompt: prompt('hold'), promptId: 'active', env: {} }, (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'), 'pending turn delivery');
  handle.stop();
  accepted.resolve({ turn: turn('turn-pending-stop', 'inProgress') });
  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/interrupt'), 'late turn interrupt');

  assert.deepEqual(supervisor.requests.filter(({ method }) => method === 'turn/interrupt').map(({ params }) => params), [{
    threadId: 'thread-pending-stop', turnId: 'turn-pending-stop',
  }]);
  assert.deepEqual(events.filter((event) => event.type === 'stopped'), [{
    type: 'stopped', reason: 'Stopped by user.', code: 'codex_user_stopped',
  }]);
});

test('a stopped pending turn detaches after rejected or invalid responses so resume can register again', async (t) => {
  for (const outcome of ['reject', 'invalid'] as const) {
    const cwd = await mkdtemp(join(tmpdir(), `switchboard-app-adapter-detach-${outcome}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const accepted = deferred<unknown>();
    let turnStarts = 0;
    const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
      if (method === 'thread/start') return safeThreadResponse(`thread-${outcome}`, (params as { cwd: string }).cwd);
      if (method === 'thread/resume') {
        const value = params as { threadId: string; cwd: string };
        return safeThreadResponse(value.threadId, value.cwd);
      }
      if (method === 'turn/start' && turnStarts++ === 0) return accepted.promise;
      if (method === 'turn/start') return { turn: turn(`resumed-turn-${outcome}`, 'inProgress') };
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected ${method}`);
    });
    const firstEvents: AdapterEvent[] = [];
    const first = createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor, `session-${outcome}`, '0.145.0',
    ).start({ cwd, prompt: prompt('first'), promptId: `first-${outcome}`, env: {} }, (event) => firstEvents.push(event));

    await waitFor(() => firstEvents.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));
    first.stop();
    if (outcome === 'reject') accepted.reject(new Error('turn/start rejected'));
    else accepted.resolve({ turn: { status: 'inProgress' } });
    await waitFor(() => supervisor.detached === 1, `${outcome} pending route detach`);

    const resumedEvents: AdapterEvent[] = [];
    createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor, `session-${outcome}`, '0.145.0',
    ).start({
      cwd, prompt: prompt('resume'), promptId: `resume-${outcome}`, env: {}, resumeId: `thread-${outcome}`,
    }, (event) => resumedEvents.push(event));
    await waitFor(() => supervisor.requests.some(({ method }) => method === 'thread/resume'), `${outcome} resume registration`);
    await waitFor(() => resumedEvents.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'));
  }
});

test('image snapshots remain readable for the active turn and clean after completion', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-image-complete-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const supervisor = new ScriptedSupervisor();
  const events: AdapterEvent[] = [];
  createCodexAppServerAdapter(supervisor as unknown as CodexAppServerSupervisor, 'image-complete', '0.145.0')
    .start({ cwd, prompt: await imagePrompt(cwd), promptId: 'image-complete', env: {} }, (event) => events.push(event));

  await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'), 'image turn/start');
  const input = (supervisor.requests.find(({ method }) => method === 'turn/start')?.params as { input: unknown[] }).input;
  const snapshotPath = (input.find((item) => (item as { type?: string }).type === 'localImage') as { path: string }).path;
  assert.equal(await pathExists(snapshotPath), true, 'snapshot remains through the active turn');

  supervisor.notify('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'completed') });
  await waitFor(() => events.some((event) => event.type === 'status' && event.status === 'done'), 'image completion');
  await waitFor(async () => !await pathExists(snapshotPath), 'completed snapshot cleanup');
});

test('image snapshots clean on stop, crash, and turn/start rejection while queued images remain unsent', async (t) => {
  for (const terminal of ['stop', 'crash', 'reject'] as const) {
    const cwd = await mkdtemp(join(tmpdir(), `switchboard-app-adapter-image-${terminal}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const accepted = deferred<unknown>();
    const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
      if (method === 'thread/start') return safeThreadResponse(`thread-image-${terminal}`, (params as { cwd: string }).cwd);
      if (method === 'turn/start') return terminal === 'reject' ? accepted.promise : { turn: turn(`turn-image-${terminal}`, 'inProgress') };
      if (method === 'turn/interrupt') return {};
      throw new Error(`unexpected ${method}`);
    });
    const events: AdapterEvent[] = [];
    const handle = createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor, `image-${terminal}`, '0.145.0',
    ).start({ cwd, prompt: await imagePrompt(cwd), promptId: `active-${terminal}`, env: {} }, (event) => events.push(event));
    await waitFor(() => supervisor.requests.some(({ method }) => method === 'turn/start'), `${terminal} image turn/start`);
    const input = (supervisor.requests.find(({ method }) => method === 'turn/start')?.params as { input: unknown[] }).input;
    const snapshotPath = (input.find((item) => (item as { type?: string }).type === 'localImage') as { path: string }).path;
    assert.equal(await pathExists(snapshotPath), true, `${terminal} retains active snapshot before terminal state`);

    if (terminal === 'stop') {
      handle.send(await imagePrompt(cwd, 'queued image'), 'queued-image');
      handle.stop();
    } else if (terminal === 'crash') {
      supervisor.fatal('transport crashed', 'codex_transport_crashed');
    } else {
      accepted.reject(new Error('Codex app-server request turn/start timed out after 5ms.'));
    }
    await waitFor(() => events.some((event) => event.type === 'stopped'), `${terminal} image terminal event`);
    await waitFor(async () => !await pathExists(snapshotPath), `${terminal} snapshot cleanup`);
    if (terminal === 'stop') {
      assert.ok(events.some((event) => event.type === 'prompt-delivery'
        && event.id === 'queued-image' && event.delivery === 'unsent'));
      assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/start').length, 1);
    }
  }
});

test('crash and timeout are terminal without replaying active or queued work', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-failure-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await t.test('crash', async () => {
    const supervisor = new ScriptedSupervisor();
    const events: AdapterEvent[] = [];
    const handle = createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor,
      'session-crash',
      '0.145.0',
    ).start({ cwd, prompt: prompt('active'), promptId: 'active', env: {} }, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'prompt-delivery' && event.delivery === 'sent'), 'active turn');
    handle.send(prompt('queued'), 'queued');
    const turnStarts = supervisor.requests.filter(({ method }) => method === 'turn/start').length;
    supervisor.fatal('private child stderr /private/provider/thread.json', 'codex_transport_crashed');
    await waitFor(() => events.some((event) => event.type === 'stopped'), 'crash stop');
    supervisor.notify('turn/completed', { threadId: 'thread-new', turn: turn('turn-1', 'completed') });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(supervisor.requests.filter(({ method }) => method === 'turn/start').length, turnStarts);
    assert.ok(events.some((event) => event.type === 'prompt-delivery' && event.id === 'queued' && event.delivery === 'unsent'));
    assert.deepEqual(events.filter((event) => event.type === 'stopped'), [{
      type: 'stopped',
      reason: 'Codex app-server transport crashed. Retry the session manually.',
      code: 'codex_transport_crashed',
    }]);
    assert.doesNotMatch(JSON.stringify(events), /private child stderr|private\/provider/);
    assert.equal(supervisor.detached, 1);
  });

  await t.test('request timeout', async () => {
    const supervisor = new ScriptedSupervisor(async ({ method, params }) => {
      if (method === 'thread/start') return safeThreadResponse('thread-timeout', (params as { cwd: string }).cwd);
      if (method === 'turn/start') throw new Error('Codex app-server request turn/start timed out after 5ms.');
      return {};
    });
    const events: AdapterEvent[] = [];
    createCodexAppServerAdapter(
      supervisor as unknown as CodexAppServerSupervisor,
      'session-timeout',
      '0.145.0',
    ).start({ cwd, prompt: prompt('time out'), promptId: 'timeout', env: {} }, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'stopped'), 'timeout stop');
    assert.ok(events.some((event) => event.type === 'stopped' && event.code === 'codex_request_timed_out'));
  });
});

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...overrides,
  };
}

function runtime(overrides: Record<string, string> = {}): PreparedCodexRuntime {
  return {
    source: 'explicit',
    commandPath: fakeCommand,
    version: '0.145.0',
    env: environment(overrides),
    diagnostics: [],
  };
}

test('real app-server request timeout reaches the active route as codex_request_timed_out', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-real-timeout-'));
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'turn-request-timeout' }),
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await supervisor.ensureTurnTransport();
  const events: AdapterEvent[] = [];
  createCodexAppServerAdapter(supervisor, 'real-timeout', '0.145.0')
    .start({ cwd, prompt: prompt('time out'), promptId: 'real-timeout', env: {} }, (event) => events.push(event));

  await waitFor(() => events.some((event) => event.type === 'stopped'), 'real request timeout', 7_000);
  assert.deepEqual(events.filter((event) => event.type === 'stopped').map((event) => event.code), [
    'codex_request_timed_out',
  ]);
  assert.equal(events.some((event) => event.type === 'stopped' && event.code === 'codex_transport_crashed'), false);
});

test('two adapters share the real fake child without cross-routing turns or stopping telemetry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-app-adapter-multi-'));
  const cwdA = join(root, 'a');
  const cwdB = join(root, 'b');
  await Promise.all([import('node:fs/promises').then(({ mkdir }) => mkdir(cwdA)), import('node:fs/promises').then(({ mkdir }) => mkdir(cwdB))]);
  const supervisor = new CodexAppServerSupervisor({
    runtime: runtime({ FAKE_APP_SERVER_MODE: 'turn-multi-session' }),
    verifyContract: async () => {},
  });
  t.after(async () => {
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.ensureTurnTransport();

  const eventsA: AdapterEvent[] = [];
  const eventsB: AdapterEvent[] = [];
  const handleA = createCodexAppServerAdapter(supervisor, 'multi-a', '0.145.0')
    .start({ cwd: cwdA, prompt: prompt('session-a'), promptId: 'a-1', env: {} }, (event) => eventsA.push(event));
  createCodexAppServerAdapter(supervisor, 'multi-b', '0.145.0')
    .start({ cwd: cwdB, prompt: prompt('session-b'), promptId: 'b-1', env: {} }, (event) => eventsB.push(event));

  await waitFor(() => eventsA.some((event) => event.type === 'status' && event.status === 'done')
    && eventsB.some((event) => event.type === 'status' && event.status === 'done'), 'two completed sessions', 4_000);
  assert.match(JSON.stringify(eventsA), /reply:session-a/);
  assert.doesNotMatch(JSON.stringify(eventsA), /reply:session-b/);
  assert.match(JSON.stringify(eventsB), /reply:session-b/);
  assert.doesNotMatch(JSON.stringify(eventsB), /reply:session-a/);
  assert.ok(eventsA.some((event) => event.type === 'usage' && event.inputTokens === 11));
  assert.ok(eventsB.some((event) => event.type === 'usage' && event.inputTokens === 12));
  assert.ok(eventsA.some((event) => event.type === 'upsert-msg' && event.msg.kind === 'todo'));
  assert.ok(eventsB.some((event) => event.type === 'upsert-msg' && event.msg.kind === 'todo'));

  handleA.send(prompt('hold-session-a'), 'a-hold');
  await waitFor(() => eventsA.some((event) => event.type === 'prompt-delivery' && event.id === 'a-hold' && event.delivery === 'sent'), 'held A turn');
  handleA.stop();
  await waitFor(() => eventsA.some((event) => event.type === 'stopped' && event.code === 'codex_user_stopped'), 'stopped A');
  const snapshot = await supervisor.reconcile();
  assert.equal(snapshot.fresh, true, 'account telemetry remains available after one session stops');
  assert.equal(eventsB.filter((event) => event.type === 'stopped').length, 0);
});
