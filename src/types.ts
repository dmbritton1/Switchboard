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
  | 'codex_app_server_unavailable'
  | 'codex_protocol_mismatch'
  | 'codex_app_server_initialization_failed'
  | 'codex_transport_crashed'
  | 'codex_request_timed_out'
  | 'codex_stream_failed'
  | 'codex_sandbox_denied'
  | 'codex_user_stopped';

export type CodexThreadSettings = {
  model?: string;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  webSearchMode?: 'disabled' | 'cached' | 'live';
  networkAccessEnabled?: boolean;
};

export type PromptDelivery = 'queued' | 'sent' | 'unsent';

export type PromptAttachment = {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: 'image' | 'file';
};

export type AgentPrompt = {
  text: string;
  attachments: PromptAttachment[];
};

export type ToolMsg = {
  kind: 'tool';
  id?: string;
  name: string;
  summary: string;
  status: 'running' | 'ok' | 'error';
  /** Compact provider output retained inline for Claude tool results. Codex
   *  stores richer output in the separately bounded `detail` body. */
  result?: string;
  detail?: string;
  detailTruncated?: boolean;
  detailEvicted?: boolean;
  detailRevision?: number;
};

export type ReasoningMsg = { kind: 'reasoning'; id: string; text: string };
export type TodoMsg = {
  kind: 'todo';
  id: string;
  items: { text: string; completed: boolean }[];
};

export type UserMsg = {
  kind: 'user';
  id: string;
  text: string;
  delivery: PromptDelivery;
  attachments?: string[];
};

export type Msg =
  | UserMsg
  | { kind: 'text'; text: string }
  | ToolMsg
  | ReasoningMsg
  | TodoMsg
  | { kind: 'error'; text: string };

export type UpsertMsg =
  | (ToolMsg & { id: string })
  | ReasoningMsg
  | TodoMsg;

export type PublicToolMsg = Omit<
  ToolMsg,
  'detail' | 'detailTruncated' | 'detailEvicted' | 'detailRevision'
> & {
  detailAvailable: boolean;
  detailTruncated: boolean;
  detailEvicted: boolean;
  detailRevision: number;
};

export type PublicMsg = Exclude<Msg, ToolMsg> | PublicToolMsg;

export type AppendToolMsg = Omit<
  ToolMsg,
  'detail' | 'detailTruncated' | 'detailEvicted' | 'detailRevision'
>;
export type AppendMsg = Exclude<Msg, ToolMsg | ReasoningMsg | TodoMsg> | AppendToolMsg;

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

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
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
  /** Immutable owner of this Codex vendor thread. Claude sessions omit both fields. */
  codexTransport?: 'sdk' | 'app-server';
  /** Runtime diagnostics captured once before the initial vendor-thread assignment. */
  codexRuntimeVersion?: string;
  codexSettings?: CodexThreadSettings;
  lastUsage: TurnUsage | null;
  transcript: Msg[];
  pending: ApprovalRequest | null;
  stoppedReason: string | null;
  stoppedCode: CodexFailureCode | null;
  startedAt: number;
  statusSince: number;
};

export type PublicSession = Omit<Session, 'transcript'> & {
  transcript: PublicMsg[];
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
  | { type: 'msg'; msg: AppendMsg }
  | { type: 'upsert-msg'; msg: UpsertMsg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | ({ type: 'usage' } & TurnUsage)
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

/** A provider-neutral account usage window. Percentages are 0-100, not fractions. */
export type AccountLimitWindow = {
  id: string;
  label: string;
  usedPercent: number;
  windowDurationMins: number | null;
  /** Epoch milliseconds inside Switchboard, never provider timestamp text. */
  resetsAt: number | null;
  reached: boolean;
};

export type AccountLimitBlockReason =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached'
  | 'spend_control_reached';

/** A bucket- or account-level provider block. */
export type AccountLimitBlock = {
  id: string;
  reason: AccountLimitBlockReason;
  resettable: boolean;
};

/** Last normalized provider read. It is intentionally process-local. */
export type AccountLimitSnapshot = {
  plan: string | null;
  windows: AccountLimitWindow[];
  blocks: AccountLimitBlock[];
  fetchedAt: number;
  authoritative: true;
  fresh: boolean;
};

export type StartOpts = {
  cwd: string;
  prompt: AgentPrompt;
  promptId?: string;
  env: Record<string, string>;
  resumeId?: string;
  /** Start with auto-approval already on, so a resumed session keeps the toggle
   *  it had before the restart rather than silently reverting to prompting. */
  auto?: boolean;
  codexSettings?: CodexThreadSettings;
};

export type AgentHandle = {
  send(prompt: AgentPrompt, promptId?: string): void;
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
  | { kind: 'create'; repo: string; branch: string; account: string; prompt: string;
      codexSettings?: CodexThreadSettings;
      /** Present only for reset-triggered creates so restored work can detect
       *  a same-name account changing providers. Timed creates omit it. */
      resetProvider?: 'claude' | 'codex' }
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
