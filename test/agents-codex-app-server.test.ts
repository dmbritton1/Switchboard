import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
import type { PreparedCodexRuntime } from '../src/agents/codex-runtime.ts';
import type { AdapterEvent, AgentPrompt, CodexFailureCode } from '../src/types.ts';

const fakeCommand = fileURLToPath(new URL('./helpers/fake-app-server.ts', import.meta.url));

function prompt(text: string): AgentPrompt {
  return { text, attachments: [] };
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

async function waitFor(check: () => boolean, message = 'adapter state', milliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type Request = { sessionId: string; method: string; params: unknown };

class ScriptedSupervisor {
  readonly requests: Request[] = [];
  readonly trace: string[] = [];
  route: CodexSessionRoute | null = null;
  bound: { sessionId: string; threadId: string } | null = null;
  detached = 0;
  request: (request: Request) => Promise<unknown>;

  constructor(request?: (request: Request) => Promise<unknown>) {
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

  registerSession(_sessionId: string, route: CodexSessionRoute): () => void {
    assert.equal(this.route, null, 'the adapter registers exactly one route');
    this.trace.push('route:registered');
    this.route = route;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.detached += 1;
      this.route = null;
    };
  }

  bindThread(sessionId: string, threadId: string): void {
    assert.equal(this.bound, null, 'the adapter binds exactly one thread');
    this.bound = { sessionId, threadId };
    this.trace.push(`thread:bound:${threadId}`);
  }

  async requestForSession<T>(sessionId: string, method: Request['method'], params: unknown): Promise<T> {
    const value = { sessionId, method, params };
    this.requests.push(value);
    this.trace.push(`request:${method}`);
    return this.request(value) as Promise<T>;
  }

  notify(method: string, params: unknown): void {
    this.route?.onNotification(method, params);
  }

  fatal(reason: string, code: CodexFailureCode): void {
    this.route?.onFatal(reason, code);
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
        effort: 'high',
        web_search: 'live',
        sandbox_workspace_write: { network_access: true },
      },
    },
  });

  threadStart.resolve(safeThreadResponse('thread-fifo', cwd));
  await waitFor(() => supervisor.requests.filter(({ method }) => method === 'turn/start').length === 1, 'first turn/start');
  assert.deepEqual(supervisor.bound, { sessionId: 'session-fifo', threadId: 'thread-fifo' });
  assert.ok(events.some((event) => event.type === 'vendor-session-id' && event.id === 'thread-fifo'));
  assert.ok(supervisor.trace.indexOf('delivery:prompt-1:sent') < supervisor.trace.indexOf('request:turn/start'));
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
  const planEvents = events.filter((event) => event.type === 'upsert-msg' && event.msg.kind === 'todo');
  assert.equal(planEvents.length, 1);
  assert.deepEqual(planEvents[0], { type: 'upsert-msg', msg: {
    kind: 'todo', id: 'codex-plan:turn-1',
    items: [{ text: 'Inspect', completed: true }, { text: 'Test', completed: false }],
  } });
  const usageIndex = supervisor.trace.indexOf('usage');
  const doneIndex = supervisor.trace.indexOf('status:done');
  const nextWorkingIndex = supervisor.trace.indexOf('status:working', doneIndex + 1);
  const nextDeliveryIndex = supervisor.trace.indexOf('delivery:prompt-2:sent');
  assert.ok(usageIndex !== -1 && usageIndex < doneIndex);
  assert.ok(doneIndex < nextWorkingIndex && nextWorkingIndex < nextDeliveryIndex);
  assert.ok(nextDeliveryIndex < supervisor.trace.lastIndexOf('request:turn/start'));
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', inputTokens: 10, outputTokens: 9, cachedInputTokens: 3,
    cacheWriteInputTokens: 2, reasoningOutputTokens: 4,
  });
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
