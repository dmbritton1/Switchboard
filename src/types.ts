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

export type ApprovalRequest = { id: string; tool: string; summary: string };

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

export type AdapterEvent =
  | { type: 'status'; status: Status }
  | { type: 'msg'; msg: AppendMsg }
  | { type: 'upsert-msg'; msg: UpsertMsg }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved' }
  | ({ type: 'usage' } & TurnUsage)
  | { type: 'vendor-session-id'; id: string }
  | { type: 'tool-result'; id: string; ok: boolean }
  | { type: 'prompt-delivery'; id: string; delivery: 'sent' | 'unsent' }
  | { type: 'stopped'; reason: string; code?: CodexFailureCode };

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
  decide(allow: boolean): void;
  setAuto(on: boolean): void;
  stop(): void;
};

export type Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle;
};
