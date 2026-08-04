export type Status = 'working' | 'needs-you' | 'done' | 'stopped';

export type CodexFailureCode =
  | 'codex_platform_unsupported'
  | 'codex_binary_missing'
  | 'codex_binary_not_executable'
  | 'codex_version_unreadable'
  | 'codex_version_mismatch'
  | 'codex_auth_unavailable'
  | 'codex_start_failed'
  | 'codex_resume_failed'
  | 'codex_stream_failed'
  | 'codex_sandbox_denied'
  | 'codex_user_stopped';

export type PromptDelivery = 'queued' | 'sent' | 'unsent';

export type Msg =
  | { kind: 'user'; id: string; text: string; delivery: PromptDelivery }
  | { kind: 'text'; text: string }
  // id is optional: it correlates a tool call to its later result so the registry
  // can flip status running -> ok/error. The Codex adapter (Task 5) emits tool
  // messages already resolved and has no equivalent id.
  // `result` is the tool's own output, redacted and truncated before it is ever
  // stored — see truncateResult() in sessions.ts for why it cannot be unbounded.
  | {
    kind: 'tool'; name: string; summary: string;
    status: 'running' | 'ok' | 'error'; id?: string; result?: string;
  }
  | { kind: 'error'; text: string };

/** One AskUserQuestion choice. `description` is the agent's own explanation of
 *  what picking it means — the reason to show it rather than the label alone. */
export type QuestionOption = { label: string; description?: string };

/** `options` is set only for AskUserQuestion: the first question's choices,
 *  which the UI renders as answer buttons. Answering resolves the request with a
 *  deny whose message carries the label — deny's `message` is the SDK's only
 *  channel back into the tool result, since the CLI has no terminal to ask on. */
export type ApprovalRequest = {
  id: string; tool: string; summary: string; options?: QuestionOption[];
};

export type Session = {
  id: string;
  provider: 'claude' | 'codex';
  account: string;
  vendorSessionId: string | null;
  repo: string;
  cwd: string;
  branch: string;
  title: string;
  status: Status;
  /** Auto-approve every tool call instead of asking. Codex sessions ignore it —
   *  their SDK has no interactive approval to skip (see codex.ts approvalPolicy). */
  auto: boolean;
  transcript: Msg[];
  pending: ApprovalRequest | null;
  stoppedReason: string | null;
  stoppedCode: CodexFailureCode | null;
  startedAt: number;
  statusSince: number;
};

/**
 * User preferences. Every default is today's behavior, so a state.json that
 * gains this block changes nothing until something is actually set.
 *
 * `account: null` means "rank by usage and pick the freest", which is what the
 * New dialog does today; a name pins that account instead.
 */
export type Settings = {
  autoApprove: boolean;
  account: string | null;
  branchPrefix: string;
  notifyOn: NotifyOn[];
  sort: SortMode;
  collapseDone: boolean;
  autoRequeue: boolean;
};

export type NotifyOn = 'needs-you' | 'done' | 'stopped';
export type SortMode = 'blocked' | 'newest' | 'account';

// Frozen because callers spread from it; an unfrozen shared default is one
// stray mutation away from every future session inheriting it. The `: Settings`
// annotation contextually types the literal, so `notifyOn` needs no cast.
// notifyOn is frozen on its own statement, after the literal, rather than
// inline: Object.freeze is shallow, so it has to be applied separately to
// reach the array — and its array overload returns `readonly NotifyOn[]`,
// which is not assignable to the mutable `NotifyOn[]` that Settings declares.
// Freezing after assignment sidesteps that: the frozen return value is never
// assigned anywhere, only DEFAULT_SETTINGS.notifyOn's existing NotifyOn[] type is.
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  autoApprove: false,
  account: null,
  branchPrefix: '',
  notifyOn: ['needs-you'],
  sort: 'blocked',
  collapseDone: false,
  autoRequeue: true,
});
Object.freeze(DEFAULT_SETTINGS.notifyOn);

export type AdapterEvent =
  | { type: 'status'; status: Status }
  | { type: 'msg'; msg: Msg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  // Claude only. The Codex SDK has no rate-limit concept anywhere in its types,
  // so a Codex account never produces this and falls back to the pace estimate.
  | { type: 'rate-limit'; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: number | null }
  | { type: 'vendor-session-id'; id: string }
  // Claude only, and about the machine rather than the session: the CLI resolves
  // the same user plugins for every session, so the server keeps one list off to
  // the side instead of copying it into each transcript.
  | { type: 'slash-commands'; commands: string[] }
  // `text` is the raw tool output. Adapters redact account env values out of it
  // before emitting; the registry truncates it before storing.
  | { type: 'tool-result'; id: string; ok: boolean; text?: string }
  | { type: 'prompt-delivery'; id: string; delivery: 'sent' | 'unsent' }
  | { type: 'stopped'; reason: string; code?: CodexFailureCode };

/** One claude.ai plan rate-limit window. `utilization` is 0-100, not a
 *  fraction — that is the SDK's unit, kept as-is so a stray /100 is a visible
 *  bug rather than a plausible-looking number. */
export type LimitWindow = {
  utilization: number;
  /** ISO 8601, straight from the SDK. */
  resetsAt: string;
};

/** Real plan limits for one account. A window is null when the SDK reports it
 *  as null, which it does for windows that do not apply to the plan. */
export type AccountLimits = {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  /** 'pro' | 'max' | 'team' | 'enterprise', or null. Not an enum here: it is a
   *  display string and an unrecognized plan should render, not throw. */
  subscription: string | null;
};

export type StartOpts = {
  cwd: string;
  prompt: string;
  promptId?: string;
  env: Record<string, string>;
  resumeId?: string;
  /** Start with auto-approval already on, so a resumed session keeps the toggle
   *  it had before the restart rather than silently reverting to prompting. */
  auto?: boolean;
};

export type AgentHandle = {
  send(text: string, promptId?: string): void;
  /** `answer` is the AskUserQuestion option label the user picked; it overrides
   *  `allow` and is handed back to the agent as the tool result. */
  decide(allow: boolean, answer?: string): void;
  setAuto(on: boolean): void;
  stop(): void;
};

export type Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle;
};

export type Trigger =
  /** Fire at this wall-clock moment (epoch ms). */
  | { kind: 'at'; time: number }
  /** Fire once this account's usage window has room again. */
  | { kind: 'reset'; account: string };

export type Action =
  | { kind: 'create'; repo: string; branch: string; account: string; prompt: string }
  | { kind: 'send'; sessionId: string; text: string }
  | { kind: 'resume'; sessionId: string; prompt: string };

/** A one-shot queued chat. There is no `fired` state: an item that fires is
 *  removed. `missed` and `failed` stick around so the user can see what happened
 *  and re-arm or delete them. */
export type Queued = {
  id: string;
  trigger: Trigger;
  action: Action;
  createdAt: number;
  state: 'waiting' | 'missed' | 'failed';
  error: string | null;
};
