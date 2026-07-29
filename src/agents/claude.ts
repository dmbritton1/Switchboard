import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options, PermissionResult, SDKMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Adapter, AdapterEvent, AgentHandle, StartOpts } from '../types.ts';

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
            },
          });
        }
      }
    }
    return out;
  }

  if (m.type === 'result') {
    const r = m as unknown as {
      is_error?: boolean; result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (r.usage) {
      out.push({
        type: 'usage',
        inputTokens: r.usage.input_tokens ?? 0,
        outputTokens: r.usage.output_tokens ?? 0,
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

export const claudeAdapter: Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle {
    const input = inputQueue();
    let resolveApproval: ((r: PermissionResult) => void) | null = null;
    let approvalSeq = 0;

    const canUseTool = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const id = `a${++approvalSeq}`;
      emit({
        type: 'approval',
        request: { id, tool: toolName, summary: summarize(toolName, toolInput) },
      });
      return new Promise<PermissionResult>((resolve) => { resolveApproval = resolve; });
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
        const resolve = resolveApproval;
        resolveApproval = null;
        if (!resolve) return;
        emit({ type: 'approval-resolved' });
        resolve(allow
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'denied from switchboard' });
      },
      stop() {
        input.close();
        void q.interrupt().catch(() => {});
      },
    };
  },
};
