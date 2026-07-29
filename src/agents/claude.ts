import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options, PermissionResult, SDKMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Adapter, AdapterEvent, AgentHandle, ApprovalRequest, StartOpts } from '../types.ts';

/** One line describing a tool call, for the transcript. */
function summarize(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  return name;
}

/** Pure: one SDK message in, zero or more normalized events out. */
export function normalizeClaude(m: SDKMessage): AdapterEvent[] {
  const out: AdapterEvent[] = [];

  // Deviation from brief: gated on subtype === 'init', not just `type === 'system'`.
  // A recorded fixture showed `type: 'system'` is shared by several distinct SDK
  // message shapes (hook_started, hook_response, post_turn_summary, init) and ALL
  // of them carry `session_id`. The brief's original check fired on every one of
  // those, emitting the same vendor-session-id repeatedly per turn. Only
  // `subtype: 'init'` is the SDK's actual `SDKSystemMessage` type (see sdk.d.ts);
  // that's the one meant to report session identity.
  if (m.type === 'system' && m.subtype === 'init' && 'session_id' in m && m.session_id) {
    out.push({ type: 'vendor-session-id', id: m.session_id as string });
    return out;
  }

  if (m.type === 'assistant') {
    const content = (m as { message: { content: unknown } }).message.content;
    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ type: 'msg', msg: { kind: 'text', text: block.text } });
        } else if (block.type === 'tool_use') {
          const name = String(block.name);
          out.push({
            type: 'msg',
            msg: {
              kind: 'tool',
              name,
              summary: summarize(name, (block.input ?? {}) as Record<string, unknown>),
              status: 'running',
              id: typeof block.id === 'string' ? block.id : undefined,
            },
          });
        }
      }
    }
    return out;
  }

  // Deviation (round 2, finding 3): the brief has no `user` branch, so tool_result
  // blocks were silently dropped and every tool message stayed 'running' forever.
  // normalizeClaude stays pure/per-message: it only reports the result here; the
  // registry (src/sessions.ts) does the id correlation against the transcript.
  if (m.type === 'user') {
    const content = (m as { message: { content: unknown } }).message.content;
    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          out.push({ type: 'tool-result', id: block.tool_use_id, ok: !block.is_error });
        }
      }
    }
    return out;
  }

  if (m.type === 'result') {
    const r = m as unknown as {
      is_error?: boolean; result?: string;
      usage?: {
        input_tokens?: number; output_tokens?: number;
        cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
      };
    };
    if (r.usage) {
      // Deviation (round 2, finding 1): the brief summed only input_tokens +
      // output_tokens. The real fixture's result.usage carries the bulk of actual
      // spend in cache_creation_input_tokens/cache_read_input_tokens (prompt
      // caching, on by default) — those are real input-side cost and were being
      // dropped, undercounting usage by ~442x on this recording. Both cache
      // fields are folded into inputTokens; the AdapterEvent shape is unchanged.
      const u = r.usage;
      out.push({
        type: 'usage',
        inputTokens: (u.input_tokens ?? 0)
          + (u.cache_creation_input_tokens ?? 0)
          + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      });
    }
    if (r.is_error) out.push({ type: 'stopped', reason: r.result ?? 'error' });
    else out.push({ type: 'status', status: 'done' });
    return out;
  }

  return out;
}

/** Async-iterable queue: the SDK pulls from this whenever we push a prompt. */
function inputQueue() {
  const buffer: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(text: string) {
      buffer.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (buffer.length) yield buffer.shift()!;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
}

/**
 * FIFO queue of pending tool-approval requests.
 *
 * Deviation (round 2, finding 2): the brief kept one `resolveApproval` slot. Two
 * concurrent `canUseTool` calls (two `tool_use` blocks in one assistant turn)
 * overwrote that slot, permanently orphaning the first request's promise — that
 * tool call, and the agent turn waiting on it, hung forever with no error. This
 * queue holds every unresolved request; `resolve()` always settles the oldest
 * one and hands back the next request so the caller can re-surface it.
 * Exported so it can be tested directly — `claudeAdapter.start` stays untested
 * plumbing, but the FIFO logic itself is pure and worth covering.
 */
export function approvalQueue() {
  const pending: { request: ApprovalRequest; resolve: (r: PermissionResult) => void }[] = [];

  return {
    wait(request: ApprovalRequest): Promise<PermissionResult> {
      return new Promise((resolve) => { pending.push({ request, resolve }); });
    },
    /** Resolves the oldest pending request. Returns null if nothing was pending,
     *  otherwise the next pending request (or null if the queue is now empty). */
    resolve(result: PermissionResult): { next: ApprovalRequest | null } | null {
      const entry = pending.shift();
      if (!entry) return null;
      entry.resolve(result);
      return { next: pending[0]?.request ?? null };
    },
  };
}

export const claudeAdapter: Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const input = inputQueue();
    const approvals = approvalQueue();
    let approvalSeq = 0;

    const canUseTool = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const request = { id: `a${++approvalSeq}`, tool: toolName, summary: summarize(toolName, toolInput) };
      emit({ type: 'approval', request });
      return approvals.wait(request);
    };

    const options: Options = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Options['env'],
      canUseTool,
      ...(opts.resumeId ? { resume: opts.resumeId } : {}),
    };

    const q = query({ prompt: input.stream(), options });
    input.push(opts.prompt);

    (async () => {
      try {
        for await (const m of q) {
          emit({ type: 'status', status: 'working' });
          for (const e of normalizeClaude(m)) emit(e);
        }
        emit({ type: 'stopped', reason: 'session ended' });
      } catch (err) {
        emit({ type: 'stopped', reason: String((err as Error).message ?? err) });
      }
    })();

    return {
      send(text: string) {
        emit({ type: 'status', status: 'working' });
        input.push(text);
      },
      decide(allow: boolean) {
        const outcome = approvals.resolve(allow
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'denied from switchboard' });
        if (!outcome) return;
        emit({ type: 'approval-resolved' });
        if (outcome.next) emit({ type: 'approval', request: outcome.next });
      },
      stop() {
        input.close();
        void q.interrupt().catch(() => {});
      },
    };
  },
};
