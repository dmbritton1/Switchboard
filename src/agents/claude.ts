import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options, PermissionResult, SDKMessage, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountLimits, Adapter, AdapterEvent, AgentHandle, ApprovalRequest, QuestionOption,
  StartOpts,
} from '../types.ts';

/**
 * One line describing a tool call. `listOptions` is off for the approval card,
 * which renders the choices as buttons right underneath and would otherwise
 * print each label twice; the transcript has no buttons and keeps them.
 */
function summarize(name: string, input: Record<string, unknown>, listOptions = true): string {
  // AskUserQuestion carries none of the fields below, so it used to render as
  // the bare tool name — the question itself never reached the UI. The SDK has
  // no interactive terminal, so allowing it returns "The user did not answer";
  // showing the text at least lets the answer be typed into the composer.
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    type Q = { question?: string; options?: { label?: string }[] };
    return (input.questions as Q[])
      .map((q) => (listOptions
        ? `${q.question ?? ''} [${(q.options ?? []).map((o) => o.label).join(' / ')}]`
        : q.question ?? ''))
      .join(' | ');
  }
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  return name;
}

/**
 * Choices to render as answer buttons, or null for any tool that is not a
 * question. Only the first question's options: the tool allows up to four
 * questions, but one flat row of buttons cannot say which question an answer
 * belongs to. Multi-question calls still show every question in the summary and
 * can be answered by typing into the composer.
 * ponytail: first question only — widen to a per-question row if that turns
 * out to be common.
 */
export function questionOptions(
  name: string,
  input: Record<string, unknown>,
): QuestionOption[] | null {
  if (name !== 'AskUserQuestion' || !Array.isArray(input.questions)) return null;
  const first = input.questions[0] as
    { options?: { label?: unknown; description?: unknown }[] } | undefined;
  const options = (first?.options ?? [])
    .filter((o) => typeof o?.label === 'string' && o.label.length > 0)
    .map((o) => ({
      label: o.label as string,
      // Optional in our own type even though the tool schema requires it: the
      // input is the agent's, not ours, and a missing description should cost a
      // subtitle, not the whole button.
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
    }));
  return options.length ? options : null;
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

  // SDKRateLimitEvent (sdk.d.ts) is a member of the SDKMessage union, so it
  // arrives through the same for-await loop as everything else — the real reset
  // timestamp costs no extra plumbing. The status is passed through as reported;
  // deciding what a rejection means is Usage#noteLimit's job, not this one's.
  if (m.type === 'rate_limit_event') {
    const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info;
    if (info?.status) {
      out.push({
        type: 'rate-limit',
        status: info.status as 'allowed' | 'allowed_warning' | 'rejected',
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
      });
    }
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
      return out;
    }
    // A slash command whose expansion shells out reports failure here, as a
    // user-role message — not as a `result` error. Dropping it made an aborted
    // command look identical to an agent that ran and said nothing: observed
    // with /security-review in a repo with no remote, where `git diff
    // origin/HEAD...` cannot resolve, so the turn ended with an empty transcript
    // and a `done` status. Surface it instead.
    if (typeof content === 'string') {
      const stderr = content.match(/<local-command-stderr>([\s\S]*?)(?:<\/local-command-stderr>|$)/);
      const text = stderr?.[1].trim();
      if (text) out.push({ type: 'msg', msg: { kind: 'error', text } });
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
 *
 * Round-2-of-2 fix: `wait()` used to only enqueue; the caller emitted `approval`
 * for every request regardless of queue position. `Session.pending` is a single
 * slot, so a second concurrent request overwrote it before the first was
 * resolved — the UI card showed request 2's summary while `decide()` still
 * resolved request 1. `wait()` now reports `isHead` (true only when this
 * request was pushed into an empty queue) so the caller emits `approval` only
 * for the request that will actually be decided next; a queued request stays
 * invisible until `resolve()` promotes it to head.
 */
export function approvalQueue() {
  const pending: { request: ApprovalRequest; resolve: (r: PermissionResult) => void }[] = [];

  return {
    /** Enqueue a request. `isHead` is true only when the queue was empty
     *  beforehand — the caller should emit `approval` for it only then. */
    wait(request: ApprovalRequest): { promise: Promise<PermissionResult>; isHead: boolean } {
      const isHead = pending.length === 0;
      const promise = new Promise<PermissionResult>((resolve) => {
        pending.push({ request, resolve });
      });
      return { promise, isHead };
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
    let stopped = false;
    let auto = opts.auto ?? false;

    const canUseTool = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const options = questionOptions(toolName, toolInput);
      // Read at call time, not captured: setAuto() can flip this mid-session and
      // every later tool call must see the new value. A question is exempt: auto
      // means "don't make me approve tool calls", and allowing AskUserQuestion
      // just makes the CLI answer "The user did not answer the questions" — the
      // question would flash past with nothing to click.
      if (auto && !options) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
      const request = {
        id: `a${++approvalSeq}`,
        tool: toolName,
        summary: summarize(toolName, toolInput, !options),
        ...(options ? { options } : {}),
      };
      const { promise, isHead } = approvals.wait(request);
      if (isHead) emit({ type: 'approval', request });
      return promise;
    };

    const options: Options = {
      cwd: opts.cwd,
      // canUseTool stays wired even when `auto` starts true: the flag is checked
      // inside it, so turning auto back off restores prompting on a session whose
      // callback was never removed.
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
      // An answer is delivered as a deny: `message` is the only field the SDK
      // feeds back into the tool result, and allowing AskUserQuestion would let
      // the CLI resolve it as unanswered instead.
      decide(allow: boolean, answer?: string) {
        const outcome = approvals.resolve(answer
          ? { behavior: 'deny', message: `The user answered: ${answer}` }
          : allow
            ? { behavior: 'allow', updatedInput: {} }
            : { behavior: 'deny', message: 'denied from switchboard' });
        if (!outcome) return;
        emit({ type: 'approval-resolved' });
        if (outcome.next) emit({ type: 'approval', request: outcome.next });
      },
      // Turning auto on has to clear what is already queued, not just future
      // calls: the tool call blocking right now is the reason the user reached
      // for the toggle, and leaving it pending would strand the agent waiting on
      // an Allow button the card no longer shows.
      setAuto(on: boolean) {
        auto = on;
        if (!on) return;
        let drained = false;
        while (approvals.resolve({ behavior: 'allow', updatedInput: {} })) drained = true;
        if (drained) emit({ type: 'approval-resolved' });
      },
      // Idempotent: the server now calls stop() from its own `stopped` handler as
      // well as from the stop/delete commands, so this runs more than once per
      // session by design.
      stop() {
        if (stopped) return;
        stopped = true;
        input.close();
        void q.interrupt().catch(() => {});
      },
    };
  },
};

/**
 * Real claude.ai plan limits for one account, or a rejection.
 *
 * The SDK exposes this only on a live `Query`, but a Query does not need a
 * session: the prompt stream below never yields, so the CLI starts, answers the
 * control request, and is closed again without a prompt, a model turn, or a
 * token of spend. That is what makes idle accounts pollable — which is the
 * whole point, since "which account is freest" has to be answerable *before* a
 * session exists.
 *
 * Deliberately does not reuse a running session's Query. That would mean
 * threading a method through AgentHandle and the registry and would still need
 * this standalone path for idle accounts.
 *
 * Rejects rather than returning null so the caller has one failure channel:
 * a thrown error, a timeout, and `rate_limits_available: false` all mean the
 * same thing to every consumer — no real number for this account.
 */
export async function probeLimits(
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<AccountLimits> {
  const q = query({
    // Never yields: the SDK pulls, gets nothing, and no turn is ever started.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<never>(() => {});
    })(),
    options: {
      env: { ...process.env, ...env } as Options['env'],
      // Isolation: omitting settingSources loads the user's ~/.claude/settings.json
      // plus project/local settings resolved against this server process's cwd,
      // which can fire SessionStart hooks and boot every configured MCP server —
      // per Claude account, every 5 minutes, forever — just to read a usage
      // number. A usage probe must not have side effects.
      settingSources: [],
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => {
        // A hung CLI must not wedge the refresh loop forever.
        timer = setTimeout(() => reject(new Error('usage probe timed out')), timeoutMs);
      }),
    ]);
    if (!usage.rate_limits_available || !usage.rate_limits) {
      // API key, Bedrock, Vertex, or a token without the profile scope. Not an
      // error the user can act on, but not a number either.
      throw new Error('plan rate limits are not available for this account');
    }
    const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined) =>
      (w && typeof w.utilization === 'number' && w.resets_at
        ? { utilization: w.utilization, resetsAt: w.resets_at }
        : null);
    const fiveHour = win(usage.rate_limits.five_hour);
    const sevenDay = win(usage.rate_limits.seven_day);
    // Both windows are optional in the SDK type, so `rate_limits_available: true`
    // does not guarantee either one is actually present. Rejecting here — the
    // same failure channel as the check above — keeps a missing number from
    // being reported as an authoritative 0%, which would sort this account as
    // the freest one available and render with none of the estimate's caveats.
    if (!fiveHour && !sevenDay) {
      throw new Error('plan rate limits were reported available but both windows were empty');
    }
    return { fiveHour, sevenDay, subscription: usage.subscription_type };
  } finally {
    clearTimeout(timer);
    // Releases the child process. Without this the node event loop stays alive.
    q.close();
  }
}
