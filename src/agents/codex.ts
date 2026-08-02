import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { redactCodexText } from './codex-runtime.ts';
import type { PreparedCodexRuntime } from './codex-runtime.ts';
import type {
  Adapter, AdapterEvent, AgentHandle, CodexFailureCode, Msg, StartOpts,
} from '../types.ts';

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
      return [{ type: 'stopped', reason: e.error.message, code: 'codex_stream_failed' }];
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
    default:
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[codex] ignored event type: ${String((e as { type?: unknown }).type)}`);
      }
      return [];
  }
}

export function classifyCodexFailure(
  reason: string,
  fallback: 'codex_start_failed' | 'codex_resume_failed' | 'codex_stream_failed',
): CodexFailureCode {
  if (/not logged in|authentication|unauthorized|\b401\b/i.test(reason)) {
    return 'codex_auth_unavailable';
  }
  if (/sandbox|permission denied|operation not permitted|read-only file system/i.test(reason)) {
    return 'codex_sandbox_denied';
  }
  return fallback;
}

export function createCodexAdapter(runtime: PreparedCodexRuntime): Adapter {
  return {
    start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const codex = new Codex({
      ...(runtime.codexPathOverride ? { codexPathOverride: runtime.codexPathOverride } : {}),
      env: runtime.env,
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
    let aborted = false;
    let turnStarted = false;

    function finish(reason: string, code: CodexFailureCode, abort = true): void {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      if (abort && !aborted) {
        aborted = true;
        abortController.abort();
      }
      const safeReason = redactCodexText(reason, runtime.env);
      const stableCode = code === 'codex_start_failed'
        || code === 'codex_resume_failed'
        || code === 'codex_stream_failed'
        ? classifyCodexFailure(safeReason, code)
        : code;
      emit({ type: 'stopped', reason: safeReason, code: stableCode });
    }

    async function drain(): Promise<void> {
      if (running || stopped) return;
      running = true;
      try {
        while (queue.length && !stopped) {
          const text = queue.shift()!;
          const { events } = await thread.runStreamed(text, { signal: abortController.signal });
          for await (const e of events) {
            if (stopped) break;
            if (e.type === 'turn.started') turnStarted = true;
            for (const ev of normalizeCodex(e)) {
              if (ev.type === 'stopped') {
                finish(ev.reason, ev.code ?? (turnStarted ? 'codex_stream_failed' : opts.resumeId ? 'codex_resume_failed' : 'codex_start_failed'));
                break;
              }
              emit(ev);
            }
          }
        }
      } catch (err) {
        // stop() sets `stopped` before calling abort(), so if we land here with
        // `stopped` already true, this throw is the abort unwinding — stop() already
        // emitted its own 'stopped' event and this is not a session failure to report.
        if (stopped) return;
        finish(
          String((err as Error).message ?? err),
          turnStarted ? 'codex_stream_failed' : opts.resumeId ? 'codex_resume_failed' : 'codex_start_failed',
          false,
        );
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
      // Already effectively auto — approvalPolicy 'never' above. The toggle has
      // nothing to switch, but the handle must satisfy AgentHandle.
      setAuto() {},
      // Idempotent, and load-bearing so: the server calls stop() from its own
      // `stopped` handler, and this stop() emits `stopped` — without the early
      // return a UI double-click, or drain()'s failure path, would re-enter.
      stop() {
        finish('stopped from switchboard', 'codex_user_stopped');
      },
    };
    },
  };
}
