export type Status = 'working' | 'needs-you' | 'done' | 'stopped';

export type Msg =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  // id is optional: it correlates a tool call to its later result so the registry
  // can flip status running -> ok/error. The Codex adapter (Task 5) emits tool
  // messages already resolved and has no equivalent id.
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'ok' | 'error'; id?: string }
  | { kind: 'error'; text: string };

export type ApprovalRequest = { id: string; tool: string; summary: string };

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
  startedAt: number;
  statusSince: number;
};

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
  | { type: 'tool-result'; id: string; ok: boolean }
  | { type: 'stopped'; reason: string };

export type StartOpts = {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  resumeId?: string;
  /** Start with auto-approval already on, so a resumed session keeps the toggle
   *  it had before the restart rather than silently reverting to prompting. */
  auto?: boolean;
};

export type AgentHandle = {
  send(text: string): void;
  decide(allow: boolean): void;
  setAuto(on: boolean): void;
  stop(): void;
};

export type Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle;
};
