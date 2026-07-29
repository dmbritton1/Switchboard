export type Status = 'working' | 'needs-you' | 'done' | 'stopped';

export type Msg =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; status: 'running' | 'ok' | 'error' }
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
  | { type: 'vendor-session-id'; id: string }
  | { type: 'stopped'; reason: string };

export type StartOpts = {
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  resumeId?: string;
};

export type AgentHandle = {
  send(text: string): void;
  decide(allow: boolean): void;
  stop(): void;
};

export type Adapter = {
  start(opts: StartOpts, emit: (e: AdapterEvent) => void): AgentHandle;
};
