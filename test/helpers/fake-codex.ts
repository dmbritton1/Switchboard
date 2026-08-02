import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeFakeCodex(
  dir: string,
  options: {
    version?: string;
    login?: 'ready' | 'logged-out' | 'unsupported';
  } = {},
): Promise<string> {
  const path = join(dir, 'fake-codex');
  const version = options.version ?? '0.145.0';
  const login = options.login ?? 'ready';
  const source = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const mode = ${JSON.stringify(login)};
  if (mode === 'ready') {
    process.stdout.write('Logged in using ChatGPT\\n');
    process.exit(0);
  }
  if (mode === 'unsupported') {
    process.stderr.write('error: unrecognized subcommand status\\n');
    process.exit(2);
  }
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
if (args[0] !== 'exec' || !args.includes('--experimental-json')) {
  process.stderr.write('unexpected invocation: ' + args.join(' ') + '\\n');
  process.exit(2);
}
const cd = args.indexOf('--cd');
const sandbox = args.indexOf('--sandbox');
if (cd === -1 || sandbox === -1) {
  process.stderr.write('missing required exec options\\n');
  process.exit(2);
}
const configs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '-c' || args[index] === '--config') configs.push(args[index + 1]);
}
const resume = args.indexOf('resume');
if (resume !== -1 && !args[resume + 1]) {
  process.stderr.write('resume requires a thread id\\n');
  process.exit(2);
}
const cwd = args[cd + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
      argv: args,
      prompt,
      cwd,
      codexHome: process.env.CODEX_HOME ?? null,
    }) + '\\n');
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  if (prompt === 'startup-failure') {
    process.stderr.write('startup failure: ' + (process.env.FAKE_CODEX_SECRET ?? '') + '\\n');
    process.exitCode = 7;
    return;
  }
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.started' });
  if (prompt === 'hold') {
    const lifecycleLog = process.env.FAKE_CODEX_HOLD_LOG;
    const note = (state) => {
      if (lifecycleLog) appendFileSync(lifecycleLog, state + '\\n');
    };
    note('started');
    const alive = setTimeout(() => note('alive'), 25);
    const keepAlive = setInterval(() => {}, 1_000);
    process.once('SIGTERM', () => {
      clearTimeout(alive);
      clearInterval(keepAlive);
      note('aborted');
      process.exit(0);
    });
    return;
  }
  if (prompt === 'releasable-hold') {
    const releaseFile = process.env.FAKE_CODEX_RELEASE_FILE;
    const wait = setInterval(() => {
      if (releaseFile && !existsSync(releaseFile)) return;
      clearInterval(wait);
      emit({ type: 'item.completed', item: {
        id: 'message-1', type: 'agent_message', text: 'released',
      }});
      emit({ type: 'turn.completed', usage: {
        input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 1, reasoning_output_tokens: 0,
      }});
    }, 10);
    return;
  }
  if (prompt === 'malformed-json') {
    process.stdout.write('{not json}\\n');
    return;
  }
  if (prompt === 'unknown-event') {
    emit({ type: 'future.event', payload: { credential: 'do-not-log-me' } });
  }
  if (prompt === 'sandbox-denied') {
    emit({ type: 'item.completed', item: {
      id: 'command-1', type: 'command_execution', command: 'touch denied',
      aggregated_output: '', exit_code: 1, status: 'failed',
    }});
    emit({ type: 'turn.failed', error: { message: 'Operation not permitted by sandbox' } });
    return;
  }
  if (prompt === 'fail-stream') {
    emit({ type: 'turn.failed', error: { message: 'fake stream failure' } });
    return;
  }
  if (prompt === 'non-credential-env-echo') {
    emit({ type: 'item.completed', item: {
      id: 'error-1', type: 'error',
      message: 'fake backend error for workspace ' + (process.env.WORKSPACE_LABEL ?? ''),
    }});
  }
  if (prompt === 'nonzero-exit') {
    process.stderr.write('unexpected process failure: ' + (process.env.FAKE_CODEX_SECRET ?? '') + '\\n');
    process.exitCode = 7;
    return;
  }
  if (prompt === 'rich-lifecycle') {
    const lifecycleSecret = process.env.FAKE_CODEX_SECRET ?? '';
    emit({ type: 'item.started', item: {
      id: 'rich-command', type: 'command_execution', command: 'npm test ' + lifecycleSecret,
      aggregated_output: '', status: 'in_progress',
    }});
    emit({ type: 'item.updated', item: {
      id: 'rich-command', type: 'command_execution', command: 'npm test ' + lifecycleSecret,
      aggregated_output: 'running command output ' + lifecycleSecret, status: 'in_progress',
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-command', type: 'command_execution', command: 'npm test ' + lifecycleSecret,
      aggregated_output: 'all command output ' + lifecycleSecret, exit_code: 0, status: 'completed',
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-mcp', type: 'mcp_tool_call', server: 'fake-' + lifecycleSecret,
      tool: 'rich-' + lifecycleSecret,
      arguments: { note: lifecycleSecret }, status: 'in_progress',
    }});
    emit({ type: 'item.updated', item: {
      id: 'rich-mcp', type: 'mcp_tool_call', server: 'fake-' + lifecycleSecret,
      tool: 'rich-' + lifecycleSecret,
      arguments: { note: lifecycleSecret },
      result: { content: [], structured_content: { progress: 'working' } }, status: 'in_progress',
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-mcp', type: 'mcp_tool_call', server: 'fake-' + lifecycleSecret,
      tool: 'rich-' + lifecycleSecret,
      arguments: { note: lifecycleSecret },
      result: { content: [], structured_content: { output: 'x'.repeat(40 * 1024) } }, status: 'completed',
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-file', type: 'file_change', status: 'completed',
      changes: [{ path: 'rich-' + lifecycleSecret + '.ts', kind: 'update' }],
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-file', type: 'file_change', status: 'completed',
      changes: [{ path: 'rich-' + lifecycleSecret + '.ts', kind: 'update' }],
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-search', type: 'web_search', query: 'Codex lifecycle ' + lifecycleSecret,
    }});
    emit({ type: 'item.updated', item: {
      id: 'rich-search', type: 'web_search', query: 'Codex lifecycle ' + lifecycleSecret,
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-search', type: 'web_search', query: 'Codex lifecycle ' + lifecycleSecret,
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-reasoning', type: 'reasoning', text: 'Checking the lifecycle ' + lifecycleSecret,
    }});
    emit({ type: 'item.updated', item: {
      id: 'rich-reasoning', type: 'reasoning', text: 'Verified the lifecycle ' + lifecycleSecret,
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-todo', type: 'todo_list', items: [
        { text: 'Inspect events ' + lifecycleSecret, completed: false },
        { text: 'Run tests ' + lifecycleSecret, completed: false },
      ],
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-todo', type: 'todo_list', items: [
        { text: 'Inspect events ' + lifecycleSecret, completed: true },
        { text: 'Run tests ' + lifecycleSecret, completed: true },
      ],
    }});
    emit({ type: 'item.started', item: {
      id: 'rich-message', type: 'agent_message', text: 'partial response',
    }});
    emit({ type: 'item.updated', item: {
      id: 'rich-message', type: 'agent_message', text: 'updated response',
    }});
    emit({ type: 'item.completed', item: {
      id: 'rich-message', type: 'agent_message', text: 'rich lifecycle response',
    }});
    emit({ type: 'turn.completed', usage: {
      input_tokens: 21, cached_input_tokens: 4, cache_write_input_tokens: 6,
      output_tokens: 13, reasoning_output_tokens: 3,
    }});
    return;
  }
  emit({ type: 'item.completed', item: {
    id: 'message-1', type: 'agent_message', text: 'fake response: ' + prompt,
  }});
  emit({ type: 'item.completed', item: {
    id: 'command-1', type: 'command_execution', command: 'echo shell',
    aggregated_output: 'shell output', exit_code: 0, status: 'completed',
  }});
  emit({ type: 'item.completed', item: {
    id: 'file-1', type: 'file_change', status: 'completed',
    changes: [{ path: 'fake.ts', kind: 'update' }],
  }});
  emit({ type: 'item.completed', item: {
    id: 'mcp-1', type: 'mcp_tool_call', server: 'fake-server', tool: 'fake-tool',
    arguments: { secret: 'not-retained' }, result: { content: [], structured_content: {} }, status: 'completed',
  }});
  emit({ type: 'item.completed', item: {
    id: 'search-1', type: 'web_search', query: 'fake search',
  }});
  emit({ type: 'turn.completed', usage: {
    input_tokens: 11, cached_input_tokens: 2, cache_write_input_tokens: 3,
    output_tokens: 5, reasoning_output_tokens: 1,
  }});
});
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
