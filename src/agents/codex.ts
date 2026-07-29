import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { Adapter, AdapterEvent, AgentHandle, Msg, StartOpts } from '../types.ts';

function itemToMsg(item: ThreadItem): Msg | null {
  switch (item.type) {
    case 'agent_message':
      return { kind: 'text', text: item.text };
    case 'command_execution':
      return {
        kind: 'tool', name: 'shell', summary: item.command,
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'file_change':
      return {
        kind: 'tool', name: 'edit',
        summary: item.changes.map((c) => c.path).join(', '),
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'mcp_tool_call':
      return {
        kind: 'tool', name: item.tool, summary: `${item.server}.${item.tool}`,
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    case 'web_search':
      return { kind: 'tool', name: 'search', summary: item.query, status: 'ok' };
    case 'error':
      return { kind: 'error', text: item.message };
    // Reasoning and todo lists are noise in a card grid.
    case 'reasoning':
    case 'todo_list':
      return null;
  }
}

/** Pure: one Codex thread event in, zero or more normalized events out. */
export function normalizeCodex(e: ThreadEvent): AdapterEvent[] {
  switch (e.type) {
    case 'thread.started':
      return [{ type: 'vendor-session-id', id: e.thread_id }];
    case 'turn.started':
      return [{ type: 'status', status: 'working' }];
    case 'turn.completed':
      return [
        {
          type: 'usage',
          // OpenAI's Usage documents cached_input_tokens / reasoning_output_tokens
          // as counts "used during the turn" alongside input_tokens/output_tokens,
          // matching the Responses API convention where those are *subsets* of the
          // input/output totals, not additions to them (unlike Anthropic's cache
          // fields, which are separate counters that must be summed). Assumption,
          // not confirmed by an explicit "subset of" statement in the SDK's doc
          // comments — flagged for a future reader rather than silently folded in.
          inputTokens: e.usage.input_tokens,
          outputTokens: e.usage.output_tokens,
        },
        { type: 'status', status: 'done' },
      ];
    case 'turn.failed':
      return [{ type: 'stopped', reason: e.error.message }];
    case 'error':
      return [{ type: 'stopped', reason: e.message }];
    case 'item.completed': {
      const msg = itemToMsg(e.item);
      return msg ? [{ type: 'msg', msg }] : [];
    }
    // Only completed items are rendered, so an item never appears twice.
    case 'item.started':
    case 'item.updated':
      return [];
  }
}

const CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

export const codexAdapter: Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const codex = new Codex({
      codexPathOverride: CODEX_BIN,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    const threadOptions = {
      workingDirectory: opts.cwd,
      sandboxMode: 'workspace-write' as const,
      // The SDK has no interactive approval callback; the sandbox is the boundary.
      approvalPolicy: 'never' as const,
    };

    const thread = opts.resumeId
      ? codex.resumeThread(opts.resumeId, threadOptions)
      : codex.startThread(threadOptions);

    const queue: string[] = [];
    // Cancels the in-flight Codex turn on stop(); see TurnOptions.signal in the SDK's
    // .d.ts. One controller for the adapter's lifetime — stop() is terminal, like the
    // Claude adapter's q.interrupt().
    const abortController = new AbortController();
    let running = false;
    let stopped = false;

    async function drain(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        while (queue.length && !stopped) {
          const text = queue.shift()!;
          const { events } = await thread.runStreamed(text, { signal: abortController.signal });
          for await (const e of events) {
            if (stopped) break;
            for (const ev of normalizeCodex(e)) emit(ev);
          }
        }
      } catch (err) {
        // stop() sets `stopped` before calling abort(), so if we land here with
        // `stopped` already true, this throw is the abort unwinding — stop() already
        // emitted its own 'stopped' event and this is not a session failure to report.
        if (stopped) return;
        stopped = true;
        emit({ type: 'stopped', reason: String((err as Error).message ?? err) });
      } finally {
        running = false;
      }
    }

    queue.push(opts.prompt);
    void drain();

    return {
      send(text: string) {
        emit({ type: 'status', status: 'working' });
        queue.push(text);
        void drain();
      },
      // Codex approvals are policy, not interactive. Nothing to decide.
      decide() {},
      stop() {
        stopped = true;
        queue.length = 0;
        abortController.abort();
        emit({ type: 'stopped', reason: 'stopped from switchboard' });
      },
    };
  },
};
