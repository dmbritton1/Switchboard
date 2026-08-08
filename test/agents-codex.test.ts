import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeCodex } from '../src/agents/codex.ts';

test('thread.started reports the vendor session id', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'thread.started', thread_id: 'th_1' } as never),
    [{ type: 'vendor-session-id', id: 'th_1' }],
  );
});

test('turn.started sets working', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.started' } as never),
    [{ type: 'status', status: 'working' }],
  );
});

test('a command lifecycle upserts one stable row from running through completion', () => {
  const events = [
    {
      type: 'item.started',
      item: {
        id: 'cmd-1', type: 'command_execution', command: 'npm test',
        aggregated_output: '', status: 'in_progress',
      },
    },
    {
      type: 'item.updated',
      item: {
        id: 'cmd-1', type: 'command_execution', command: 'npm test',
        aggregated_output: 'running output', status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1', type: 'command_execution', command: 'npm test',
        aggregated_output: 'all passed', exit_code: 0, status: 'completed',
      },
    },
  ] as const;

  assert.deepEqual(events.flatMap((event) => normalizeCodex(event as never)), [
    { type: 'upsert-msg', msg: {
      kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'running',
    } },
    { type: 'upsert-msg', msg: {
      kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'running',
      detail: 'running output', detailTruncated: false,
    } },
    { type: 'upsert-msg', msg: {
      kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'ok',
      detail: 'all passed', detailTruncated: false,
    } },
  ]);
});

test('a failed command upsert keeps its terminal error and bounded detail', () => {
  assert.deepEqual(normalizeCodex({
    type: 'item.completed',
    item: {
      id: 'cmd-failed', type: 'command_execution', command: 'false',
      aggregated_output: 'command failed', exit_code: 1, status: 'failed',
    },
  } as never), [{ type: 'upsert-msg', msg: {
    kind: 'tool', id: 'cmd-failed', name: 'shell', summary: 'false', status: 'error',
    detail: 'command failed', detailTruncated: false,
  } }]);
});

test('file changes expose an exact count instead of absolute paths while retaining detail', () => {
  const changes = [
    { path: '/Users/operator/project/a,with-comma.ts', kind: 'update' },
    { path: '/private/tmp/project/b.ts', kind: 'add' },
  ];
  const [event] = normalizeCodex({
    type: 'item.completed',
    item: { id: 'file-1', type: 'file_change', status: 'failed', changes },
  } as never);
  assert.equal(event.type, 'upsert-msg');
  assert.ok(event.type === 'upsert-msg' && event.msg.kind === 'tool');
  assert.deepEqual({ ...event.msg, detail: undefined }, {
    kind: 'tool', id: 'file-1', name: 'edit', summary: '2 files', status: 'error',
    detail: undefined, detailTruncated: false,
  });
  assert.doesNotMatch(event.msg.summary, /Users|private|with-comma/);
  assert.match(event.msg.detail ?? '', /a,with-comma\.ts/);
  assert.match(event.msg.detail ?? '', /\/private\/tmp\/project\/b\.ts/);
});

test('one file change uses the singular summary without exposing its path', () => {
  const [event] = normalizeCodex({
    type: 'item.started',
    item: {
      id: 'file-one', type: 'file_change', status: 'in_progress',
      changes: [{ path: '/Users/operator/private.ts', kind: 'update' }],
    },
  } as never);
  assert.equal(event.type, 'upsert-msg');
  assert.ok(event.type === 'upsert-msg' && event.msg.kind === 'tool');
  assert.equal(event.msg.summary, '1 file');
  assert.doesNotMatch(event.msg.summary, /Users|operator|private\.ts/);
});

test('MCP upserts serialize arguments and result while redacting launch secrets', () => {
  const env = { FAKE_TOKEN: 'abcdefghijklmnop' };
  const started = normalizeCodex({
    type: 'item.started',
    item: {
      id: 'mcp-1', type: 'mcp_tool_call', server: 'files', tool: 'read',
      arguments: { path: '/tmp/example', token: 'abcdefghijklmnop' }, status: 'in_progress',
    },
  } as never, env);
  const completed = normalizeCodex({
    type: 'item.completed',
    item: {
      id: 'mcp-1', type: 'mcp_tool_call', server: 'files', tool: 'read',
      arguments: { path: '/tmp/example' },
      result: { content: [], structured_content: { value: 'done' } },
      status: 'completed',
    },
  } as never, env);

  assert.equal(started[0].type, 'upsert-msg');
  assert.ok(started[0].type === 'upsert-msg' && started[0].msg.kind === 'tool');
  assert.equal(started[0].msg.status, 'running');
  assert.match(started[0].msg.detail ?? '', /\[REDACTED\]/);
  assert.doesNotMatch(started[0].msg.detail ?? '', /abcdefghijklmnop/);
  assert.deepEqual(completed, [{ type: 'upsert-msg', msg: {
    kind: 'tool', id: 'mcp-1', name: 'read', summary: 'files.read', status: 'ok',
    detail: '{\n  "arguments": {\n    "path": "/tmp/example"\n  },\n  "result": {\n    "content": [],\n    "structured_content": {\n      "value": "done"\n    }\n  }\n}',
    detailTruncated: false,
  } }]);
});

test('a failed MCP upsert serializes its error without retaining the vendor object', () => {
  assert.deepEqual(normalizeCodex({
    type: 'item.completed',
    item: {
      id: 'mcp-failed', type: 'mcp_tool_call', server: 'files', tool: 'write',
      arguments: { path: 'x' }, error: { message: 'denied' }, status: 'failed',
    },
  } as never), [{ type: 'upsert-msg', msg: {
    kind: 'tool', id: 'mcp-failed', name: 'write', summary: 'files.write', status: 'error',
    detail: '{\n  "arguments": {\n    "path": "x"\n  },\n  "error": {\n    "message": "denied"\n  }\n}',
    detailTruncated: false,
  } }]);
});

test('web searches upsert from running to completed using the SDK id', () => {
  assert.deepEqual([
    ...normalizeCodex({ type: 'item.started', item: {
      id: 'search-1', type: 'web_search', query: 'Codex SDK',
    } } as never),
    ...normalizeCodex({ type: 'item.completed', item: {
      id: 'search-1', type: 'web_search', query: 'Codex SDK',
    } } as never),
  ], [
    { type: 'upsert-msg', msg: {
      kind: 'tool', id: 'search-1', name: 'search', summary: 'Codex SDK', status: 'running',
    } },
    { type: 'upsert-msg', msg: {
      kind: 'tool', id: 'search-1', name: 'search', summary: 'Codex SDK', status: 'ok',
    } },
  ]);
});

test('reasoning emits only the SDK reasoning summary text as an upsert', () => {
  assert.deepEqual(normalizeCodex({
    type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: 'Checking the tests' },
  } as never), [{ type: 'upsert-msg', msg: {
    kind: 'reasoning', id: 'reason-1', text: 'Checking the tests',
  } }]);
});

test('todo updates replace the same SDK id without fabricated status', () => {
  assert.deepEqual(normalizeCodex({
    type: 'item.completed', item: { id: 'todo-1', type: 'todo_list', items: [
      { text: 'Inspect', completed: true }, { text: 'Test', completed: false },
    ] },
  } as never), [{ type: 'upsert-msg', msg: {
    kind: 'todo', id: 'todo-1', items: [
      { text: 'Inspect', completed: true }, { text: 'Test', completed: false },
    ],
  } }]);
});

test('lifecycle upserts redact every displayed SDK string while preserving item ids', () => {
  const secret = 'never-expose-me';
  const env = { FAKE_CODEX_SECRET: secret };
  const events = [
    normalizeCodex({ type: 'item.completed', item: {
      id: 'command-id', type: 'command_execution', command: `echo ${secret}`,
      aggregated_output: `output ${secret}`, exit_code: 0, status: 'completed',
    } } as never, env)[0],
    normalizeCodex({ type: 'item.completed', item: {
      id: 'file-id', type: 'file_change', status: 'completed',
      changes: [{ path: `src/${secret}.ts`, kind: 'update' }],
    } } as never, env)[0],
    normalizeCodex({ type: 'item.completed', item: {
      id: 'mcp-id', type: 'mcp_tool_call', server: `server-${secret}`, tool: `tool-${secret}`,
      arguments: { note: secret }, result: { content: [], structured_content: {} },
      status: 'completed',
    } } as never, env)[0],
    normalizeCodex({ type: 'item.completed', item: {
      id: 'search-id', type: 'web_search', query: `find ${secret}`,
    } } as never, env)[0],
    normalizeCodex({ type: 'item.updated', item: {
      id: 'reasoning-id', type: 'reasoning', text: `Checking ${secret}`,
    } } as never, env)[0],
    normalizeCodex({ type: 'item.completed', item: {
      id: 'todo-id', type: 'todo_list', items: [
        { text: `Remove ${secret}`, completed: true },
      ],
    } } as never, env)[0],
  ];

  assert.deepEqual(events.map((event) => event.type === 'upsert-msg' ? event.msg.id : null), [
    'command-id', 'file-id', 'mcp-id', 'search-id', 'reasoning-id', 'todo-id',
  ]);
  assert.deepEqual(events.map((event) => {
    if (event.type !== 'upsert-msg') return null;
    if (event.msg.kind === 'tool') {
      return { id: event.msg.id, name: event.msg.name, summary: event.msg.summary };
    }
    if (event.msg.kind === 'reasoning') {
      return { id: event.msg.id, text: event.msg.text };
    }
    return { id: event.msg.id, items: event.msg.items };
  }), [
    { id: 'command-id', name: 'shell', summary: 'echo [REDACTED]' },
    { id: 'file-id', name: 'edit', summary: '1 file' },
    { id: 'mcp-id', name: 'tool-[REDACTED]', summary: 'server-[REDACTED].tool-[REDACTED]' },
    { id: 'search-id', name: 'search', summary: 'find [REDACTED]' },
    { id: 'reasoning-id', text: 'Checking [REDACTED]' },
    { id: 'todo-id', items: [{ text: 'Remove [REDACTED]', completed: true }] },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /never-expose-me/);
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
});

test('assistant text and item errors remain append-only and emit only when completed', () => {
  const agent = { id: 'message-1', type: 'agent_message', text: 'hello' };
  const error = { id: 'error-1', type: 'error', message: 'recoverable failure' };

  assert.deepEqual(normalizeCodex({ type: 'item.started', item: agent } as never), []);
  assert.deepEqual(normalizeCodex({ type: 'item.updated', item: agent } as never), []);
  assert.deepEqual(normalizeCodex({ type: 'item.completed', item: agent } as never), [
    { type: 'msg', msg: { kind: 'text', text: 'hello' } },
  ]);
  assert.deepEqual(normalizeCodex({ type: 'item.started', item: error } as never), []);
  assert.deepEqual(normalizeCodex({ type: 'item.updated', item: error } as never), []);
  assert.deepEqual(normalizeCodex({ type: 'item.completed', item: error } as never), [
    { type: 'msg', msg: { kind: 'error', text: 'recoverable failure' } },
  ]);
});

test('an unknown future item reports only its type during development', (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  process.env.NODE_ENV = 'development';
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => {
    console.warn = previousWarn;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });

  assert.deepEqual(normalizeCodex({ type: 'item.completed', item: {
    id: 'future-1', type: 'future_item', credential: 'do-not-log-me',
  } } as never), []);
  assert.deepEqual(warnings, [['[codex] ignored item type: future_item']]);
});

// Pins the decision this task exists to get right: cached_input_tokens,
// cache_write_input_tokens, and reasoning_output_tokens are subsets of
// input_tokens/output_tokens under the Responses API convention, not additions to
// them (unlike Anthropic's cache fields, which the Claude adapter correctly sums).
// Every cache field below is nonzero and distinct so any wrong summation — folding
// in one field, two, or all three — produces a total other than 10 or 5 and fails
// this assertion. Do not "fix" a failure here by summing the fields in; that is
// the regression this test exists to catch.
test('turn.completed reports every SDK usage field and sets done', () => {
  assert.deepEqual(
    normalizeCodex({
      type: 'turn.completed',
      usage: {
        input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 7,
        output_tokens: 5, reasoning_output_tokens: 2,
      },
    } as never),
    [
      {
        type: 'usage',
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 7,
        reasoningOutputTokens: 2,
      },
      { type: 'status', status: 'done' },
    ],
  );
});

test('turn.failed stops the session with the error message', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.failed', error: { message: 'nope' } } as never),
    [{ type: 'stopped', reason: 'nope', code: 'codex_stream_failed' }],
  );
});

test('an unknown future event is ignored', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'future.event', payload: { value: 1 } } as never),
    [],
  );
});

test('an unknown future event reports only its type during development', (t) => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  process.env.NODE_ENV = 'development';
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => {
    console.warn = previousWarn;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });

  assert.deepEqual(
    normalizeCodex({ type: 'future.event', payload: { credential: 'do-not-log-me' } } as never),
    [],
  );
  assert.deepEqual(warnings, [['[codex] ignored event type: future.event']]);
});

test('turn.failed is assigned a stable stream failure code', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'turn.failed', error: { message: 'nope' } } as never),
    [{ type: 'stopped', reason: 'nope', code: 'codex_stream_failed' }],
  );
});

test('a fatal error event stops the session', () => {
  assert.deepEqual(
    normalizeCodex({ type: 'error', message: 'fatal' } as never),
    [{ type: 'stopped', reason: 'fatal' }],
  );
});
