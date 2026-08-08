import { Codex } from '@openai/codex-sdk';
import type { Input, ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { safeCodexDetail } from './codex-detail.ts';
import { redactCodexText } from './codex-runtime.ts';
import type { PreparedCodexRuntime } from './codex-runtime.ts';
import { revalidateAgentPrompt } from '../prompt-input.ts';
import type {
  Adapter, AdapterEvent, AgentHandle, AgentPrompt, CodexFailureCode, StartOpts, ToolMsg,
} from '../types.ts';

export function codexPromptInput(prompt: AgentPrompt): Input {
  const files = prompt.attachments.filter((attachment) => attachment.kind === 'file');
  const images = prompt.attachments.filter((attachment) => attachment.kind === 'image');
  const text = [
    prompt.text,
    ...files.map((attachment) => `Attached file: ${attachment.relativePath}`),
  ].filter(Boolean).join('\n');
  return images.length
    ? [
      { type: 'text', text },
      ...images.map((attachment) => ({ type: 'local_image' as const, path: attachment.absolutePath })),
    ]
    : text;
}

type ItemPhase = 'started' | 'updated' | 'completed';

function itemStatus(status: 'in_progress' | 'completed' | 'failed'): ToolMsg['status'] {
  switch (status) {
    case 'in_progress': return 'running';
    case 'completed': return 'ok';
    case 'failed': return 'error';
  }
}

function withDetail(
  msg: ToolMsg & { id: string },
  value: unknown,
  env: Record<string, string>,
): AdapterEvent[] {
  const detail = safeCodexDetail(value, env);
  return [{
    type: 'upsert-msg',
    msg: detail && detail.text.length > 0
      ? { ...msg, detail: detail.text, detailTruncated: detail.truncated }
      : msg,
  }];
}

function normalizeItem(
  phase: ItemPhase,
  item: ThreadItem,
  env: Record<string, string>,
): AdapterEvent[] {
  switch (item.type) {
    case 'agent_message':
      return phase === 'completed'
        ? [{ type: 'msg', msg: { kind: 'text', text: redactCodexText(item.text, env) } }]
        : [];
    case 'command_execution':
      return withDetail({
        kind: 'tool', id: item.id, name: 'shell', summary: redactCodexText(item.command, env),
        status: itemStatus(item.status),
      }, item.aggregated_output, env);
    case 'file_change':
      return withDetail({
        kind: 'tool', id: item.id, name: 'edit',
        summary: `${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`,
        status: itemStatus(item.status),
      }, { changes: item.changes }, env);
    case 'mcp_tool_call': {
      const server = redactCodexText(item.server, env);
      const tool = redactCodexText(item.tool, env);
      return withDetail({
        kind: 'tool', id: item.id, name: tool, summary: `${server}.${tool}`,
        status: itemStatus(item.status),
      }, { arguments: item.arguments, result: item.result, error: item.error }, env);
    }
    case 'web_search':
      return [{ type: 'upsert-msg', msg: {
        kind: 'tool', id: item.id, name: 'search', summary: redactCodexText(item.query, env),
        status: phase === 'completed' ? 'ok' : 'running',
      } }];
    case 'reasoning':
      return [{ type: 'upsert-msg', msg: {
        kind: 'reasoning', id: item.id, text: redactCodexText(item.text, env),
      } }];
    case 'todo_list':
      return [{ type: 'upsert-msg', msg: {
        kind: 'todo', id: item.id,
        items: item.items.map((todo) => ({
          text: redactCodexText(todo.text, env), completed: todo.completed,
        })),
      } }];
    case 'error':
      return phase === 'completed'
        ? [{ type: 'msg', msg: { kind: 'error', text: redactCodexText(item.message, env) } }]
        : [];
    default:
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[codex] ignored item type: ${String((item as { type?: unknown }).type)}`);
      }
      return [];
  }
}

/** Pure: one Codex thread event in, zero or more normalized events out. */
export function normalizeCodex(
  e: ThreadEvent,
  env: Record<string, string> = {},
): AdapterEvent[] {
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
          cachedInputTokens: e.usage.cached_input_tokens,
          cacheWriteInputTokens: e.usage.cache_write_input_tokens,
          reasoningOutputTokens: e.usage.reasoning_output_tokens,
        },
        { type: 'status', status: 'done' },
      ];
    case 'turn.failed':
      return [{ type: 'stopped', reason: e.error.message, code: 'codex_stream_failed' }];
    case 'error':
      return [{ type: 'stopped', reason: e.message }];
    case 'item.started': return normalizeItem('started', e.item, env);
    case 'item.updated': return normalizeItem('updated', e.item, env);
    case 'item.completed': return normalizeItem('completed', e.item, env);
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

    const settings = opts.codexSettings;
    const threadOptions = {
      ...(settings?.model !== undefined ? { model: settings.model } : {}),
      ...(settings?.modelReasoningEffort !== undefined
        ? { modelReasoningEffort: settings.modelReasoningEffort } : {}),
      ...(settings?.webSearchMode !== undefined ? { webSearchMode: settings.webSearchMode } : {}),
      ...(settings?.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: settings.networkAccessEnabled } : {}),
      workingDirectory: opts.cwd,
      sandboxMode: 'workspace-write' as const,
      // The SDK has no interactive approval callback; the sandbox is the boundary.
      approvalPolicy: 'never' as const,
    };

    const thread = opts.resumeId
      ? codex.resumeThread(opts.resumeId, threadOptions)
      : codex.startThread(threadOptions);

    const queue: { prompt: AgentPrompt; promptId?: string }[] = [];
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
      const unsent = queue.splice(0);
      for (const prompt of unsent) {
        if (prompt.promptId) emit({ type: 'prompt-delivery', id: prompt.promptId, delivery: 'unsent' });
      }
      if (unsent.length) {
        const noun = unsent.length === 1 ? 'prompt was' : 'prompts were';
        emit({
          type: 'msg',
          msg: {
            kind: 'error',
            text: `${unsent.length} queued ${noun} not sent. Resend ${unsent.length === 1 ? 'it' : 'them'} manually if still needed.`,
          },
        });
      }
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
          // Keep the entry in the queue until its filesystem paths have been
          // rebuilt. If validation fails, finish() can still mark this prompt
          // unsent, and no stale absolute path reaches the SDK.
          const queued = queue[0];
          const prompt = await revalidateAgentPrompt(opts.cwd, queued.prompt);
          if (stopped || queue[0] !== queued) return;
          queue.shift();
          if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'sent' });
          const { events } = await thread.runStreamed(codexPromptInput(prompt), {
            signal: abortController.signal,
          });
          for await (const e of events) {
            if (stopped) break;
            if (e.type === 'turn.started') turnStarted = true;
            for (const ev of normalizeCodex(e, runtime.env)) {
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

    queue.push({ prompt: opts.prompt, promptId: opts.promptId });
    void drain();

    return {
      send(prompt: AgentPrompt, promptId?: string) {
        emit({ type: 'status', status: 'working' });
        queue.push({ prompt, promptId });
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
        finish('Stopped by user.', 'codex_user_stopped');
      },
    };
    },
  };
}
