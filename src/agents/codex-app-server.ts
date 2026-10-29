import type { CapabilitySnapshot } from './codex-capabilities.ts';
import { normalizeElicitation } from './codex-elicitation.ts';
import { normalizeCodexQuestions, type CodexInteractionResult } from './codex-questions.ts';
import { CodexApprovals } from './codex-approvals.ts';
import { AppServerRequestError } from './codex-app-server-client.ts';
import { realpath } from 'node:fs/promises';
import { safeCodexDetail } from './codex-detail.ts';
import { classifyCodexFailure } from './codex.ts';
import { CodexRuntimeError, unsafeCodexProviderIdentifier, redactCodexText } from './codex-runtime.ts';
import { validateCodexSettings } from './codex-settings.ts';
import { snapshotCodexPrompt } from '../prompt-input.ts';
import type { CodexAppServerSupervisor } from './codex-app-server-supervisor.ts';
import type {
  Adapter, AdapterEvent, AgentHandle, AgentPrompt, CodexFailureCode, StartOpts, ToolMsg,
} from '../types.ts';

type AppServerInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

type QueueEntry = { prompt: AgentPrompt; promptId?: string };
type ItemPhase = 'started' | 'completed';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function notificationHasUnsafeIdentifier(value: Record<string, unknown>): boolean {
  const thread = object(value.thread);
  const turn = object(value.turn);
  const item = object(value.item);
  return [value.threadId, value.turnId, thread?.id, turn?.id, item?.id]
    .some(unsafeCodexProviderIdentifier);
}

function toolStatus(value: unknown, phase: ItemPhase): ToolMsg['status'] {
  if (value === 'failed' || value === 'declined') return 'error';
  return phase === 'completed' || value === 'completed' ? 'ok' : 'running';
}

function scrubAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[^\p{L}\p{N}_./\\-])\/(?!\/)[^\s"'`<>{}\[\](),;:]+/gu, '$1[path omitted]')
    .replace(/(^|[^\p{L}\p{N}_./\\-])(?:[A-Za-z]:\\|\\\\)[^\s"'`<>{}\[\](),;:]+/gu, '$1[path omitted]');
}

function safePublicText(value: string, env: Record<string, string>): string {
  return scrubAbsolutePaths(redactCodexText(value, env));
}

/** Only the structured usage-limit variant is eligible for server recovery. */
export type CodexAppServerTurnFailure =
  | { kind: 'UsageLimitExceeded'; reason: string }
  | { kind: 'Other'; reason: string };

export function classifyCodexAppServerTurnFailure(
  error: unknown, env: Record<string, string>,
): CodexAppServerTurnFailure {
  const value = object(error);
  const reason = safePublicText(text(value?.message) ?? 'Codex app-server turn failed.', env);
  return value?.codexErrorInfo === 'usageLimitExceeded'
    ? { kind: 'UsageLimitExceeded', reason }
    : { kind: 'Other', reason };
}

function withoutAbsolutePaths(value: unknown): unknown {
  if (typeof value === 'string') return scrubAbsolutePaths(value);
  if (Array.isArray(value)) return value.map(withoutAbsolutePaths);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => [
    key,
    (key === 'path' || key === 'cwd') && typeof nested === 'string' && nested.startsWith('/')
      ? '[path omitted]'
      : withoutAbsolutePaths(nested),
  ]));
}

function detail(
  msg: ToolMsg & { id: string }, value: unknown, env: Record<string, string>,
): AdapterEvent[] {
  const safe = safeCodexDetail(withoutAbsolutePaths(value), env);
  return [{ type: 'upsert-msg', msg: safe && safe.text.length
    ? { ...msg, detail: safe.text, detailTruncated: safe.truncated }
    : msg }];
}

export function codexAppServerPromptInput(prompt: AgentPrompt): AppServerInput[] {
  const files = prompt.attachments.filter((attachment) => attachment.kind === 'file');
  const images = prompt.attachments.filter((attachment) => attachment.kind === 'image');
  const body = [prompt.text, ...files.map((attachment) => `Attached file: ${attachment.relativePath}`)]
    .filter(Boolean).join('\n');
  return [
    { type: 'text', text: body, text_elements: [] },
    ...images.map((attachment) => ({ type: 'localImage' as const, path: attachment.absolutePath })),
  ];
}

export function normalizeCodexAppServerItem(
  phase: ItemPhase, item: unknown, env: Record<string, string> = {},
): AdapterEvent[] {
  const value = object(item);
  if (!value || typeof value.type !== 'string' || typeof value.id !== 'string') return [];
  if (unsafeCodexProviderIdentifier(value.id)) return [];
  const id = value.id;
  switch (value.type) {
    case 'agentMessage':
      return phase === 'completed' && text(value.text) !== null
        ? [{ type: 'msg', msg: { kind: 'text', text: safePublicText(text(value.text)!, env) } }]
        : [];
    case 'reasoning': {
      const summary = Array.isArray(value.summary) ? value.summary.filter((part): part is string => typeof part === 'string') : [];
      return summary.length ? [{ type: 'upsert-msg', msg: {
        kind: 'reasoning', id, text: safePublicText(summary.join('\n'), env),
      } }] : [];
    }
    case 'plan':
      return text(value.text) === null ? [] : [{ type: 'upsert-msg', msg: {
        kind: 'todo', id, items: [{ text: safePublicText(text(value.text)!, env), completed: false }],
      } }];
    case 'commandExecution':
      return detail({
        kind: 'tool', id, name: 'shell', summary: safePublicText(text(value.command) ?? 'Command', env),
        status: toolStatus(value.status, phase),
      }, value.aggregatedOutput, env);
    case 'fileChange': {
      const changes = Array.isArray(value.changes) ? value.changes : [];
      return detail({
        kind: 'tool', id, name: 'edit', summary: `${changes.length} file${changes.length === 1 ? '' : 's'}`,
        status: toolStatus(value.status, phase),
      }, { changes }, env);
    }
    case 'mcpToolCall': {
      const server = safePublicText(text(value.server) ?? 'mcp', env);
      const tool = safePublicText(text(value.tool) ?? 'tool', env);
      return detail({ kind: 'tool', id, name: tool, summary: `${server}.${tool}`, status: toolStatus(value.status, phase) }, {
        arguments: value.arguments, result: value.result, error: value.error,
      }, env);
    }
    case 'webSearch':
      return [{ type: 'upsert-msg', msg: {
        kind: 'tool', id, name: 'search', summary: safePublicText(text(value.query) ?? 'Search', env),
        status: toolStatus(value.status, phase),
      } }];
    case 'error':
      return phase === 'completed' && text(value.message) !== null
        ? [{ type: 'msg', msg: { kind: 'error', text: safePublicText(text(value.message)!, env) } }]
        : [];
    case 'contextCompaction':
      return [{ type: 'upsert-msg', msg: {
        kind: 'tool', id, name: 'context', summary: 'Context compacted', status: toolStatus(value.status, phase),
      } }];
    default:
      return [];
  }
}

async function threadResponse(value: unknown, cwd: string): Promise<string | null> {
  const response = object(value);
  const thread = response && object(response.thread);
  const sandbox = response && object(response.sandbox);
  const id = thread && text(thread.id);
  if (!response || !thread || !sandbox || !id || unsafeCodexProviderIdentifier(id)
    || typeof response.cwd !== 'string' || typeof thread.cwd !== 'string'
    || response.approvalPolicy !== 'on-request' || response.approvalsReviewer !== 'user' || sandbox.type !== 'workspaceWrite') return null;
  if (response.cwd !== cwd || thread.cwd !== cwd) {
    try {
      const [expected, effective, stored] = await Promise.all([realpath(cwd), realpath(response.cwd), realpath(thread.cwd)]);
      if (expected !== effective || expected !== stored) return null;
    } catch { return null; }
  }
  return id;
}

function settingsConfig(settings: StartOpts['codexSettings']): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  const config: Record<string, unknown> = {};
  if (settings.webSearchMode !== undefined) config.web_search = settings.webSearchMode;
  if (settings.networkAccessEnabled !== undefined) {
    config.sandbox_workspace_write = { network_access: settings.networkAccessEnabled };
  }
  return Object.keys(config).length ? config : undefined;
}

function lastUsage(value: unknown): AdapterEvent | null {
  const record = object(value);
  const last = record && object(record.last);
  if (!last || typeof last.inputTokens !== 'number' || typeof last.outputTokens !== 'number') return null;
  const optional = (name: string): number | undefined => typeof last[name] === 'number' ? last[name] as number : undefined;
  return {
    type: 'usage', inputTokens: last.inputTokens, outputTokens: last.outputTokens,
    ...(optional('cachedInputTokens') === undefined ? {} : { cachedInputTokens: optional('cachedInputTokens') }),
    ...(optional('cacheWriteInputTokens') === undefined ? {} : { cacheWriteInputTokens: optional('cacheWriteInputTokens') }),
    ...(optional('reasoningOutputTokens') === undefined ? {} : { reasoningOutputTokens: optional('reasoningOutputTokens') }),
  };
}

export function createCodexAppServerAdapter(
  supervisor: CodexAppServerSupervisor, sessionId: string, _runtimeVersion: string,
): Adapter {
  return {
    start(opts, emit): AgentHandle {
      let settings: StartOpts['codexSettings'];
      const queue: QueueEntry[] = [{ prompt: opts.prompt, promptId: opts.promptId }];
      let detach: (() => void) | null = null;
      let threadId: string | null = null;
      let activeTurnId: string | null = null;
      let activeUsage: unknown = null;
      let activeSnapshotCleanup: (() => Promise<void>) | null = null;
      let draining = false;
      let compactPending = false;
      let compactStartTimer: ReturnType<typeof setTimeout> | null = null;
      let completing = false;
      let stopped = false;
      let interrupted = false;
      let interruptSent = false;
      let turnRequestInFlight = false;
      let protocolRetiring = false;
      const bufferedNotifications: Array<{ method: string; params: unknown }> = [];
      let resolveQuiescence!: () => void;
      const quiescence = new Promise<void>((resolve) => { resolveQuiescence = resolve; });
      let quiescenceSettled = false;
      let worktreeOperations = 0;

      const settleQuiescence = (): void => {
        if (quiescenceSettled || !stopped || worktreeOperations > 0) return;
        quiescenceSettled = true;
        resolveQuiescence();
      };

      const beginWorktreeOperation = (): (() => void) => {
        worktreeOperations += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          worktreeOperations -= 1;
          settleQuiescence();
        };
      };

      const detachRoute = (): void => {
        detach?.();
        detach = null;
      };

      const cleanupActiveSnapshot = async (): Promise<void> => {
        const cleanup = activeSnapshotCleanup;
        if (!cleanup) return;
        activeSnapshotCleanup = null;
        await cleanup();
      };

      const responses = new Map<string | number, (decision: CodexInteractionResult) => void>();
      const approvals = new CodexApprovals(opts.auto ?? false, (pending) => {
        emit(pending ? { type: 'approval', request: pending } : { type: 'approval-resolved' });
      }, (id, decision) => {
        const respond = responses.get(id);
        respond?.(decision);
      });
      const cancelApprovals = (): void => {
        try { approvals.cancel(); } finally { responses.clear(); }
      };
      const onServerRequest = (id: string | number, method: string, params: unknown,
        respond: (decision: CodexInteractionResult) => void): void => {
        if (method === 'mcpServer/elicitation/request') {
          const elicitation = normalizeElicitation(params, value => safePublicText(value, opts.env));
          if (stopped || interrupted || !elicitation) { respond({action:'cancel',content:null,_meta:null}); return; }
          responses.set(id, respond); approvals.addElicitation(id, elicitation); return;
        }
        if (method === 'item/tool/requestUserInput') {
          const questions = normalizeCodexQuestions(params, value => safePublicText(value, opts.env));
          if (stopped || interrupted || !questions) { respond({ answers: {} }); return; }
          responses.set(id, respond);
          approvals.addQuestions(id, questions);
          return;
        }
        if (stopped || interrupted) { respond('decline'); return; }
        const value = object(params);
        if (!value || (value.environmentId != null && value.environmentId !== 'local') || (value.grantRoot != null)
          || (value.kind != null && value.kind !== 'command')) { respond('decline'); return; }
        const command = method === 'item/commandExecution/requestApproval';
        const description = command ? text(value.command) : 'File changes';
        if (command && !description) { respond('decline'); return; }
        const reason = text(value.reason);
        const summary = safePublicText([description, reason].filter(Boolean).join(' — '), opts.env).slice(0, 2000);
        responses.set(id, respond);
        approvals.add(id, command ? 'command' : 'edit', summary);
      };
      const onServerResolved = (id: string | number): void => {
        responses.delete(id); approvals.resolved(id);
      };

      const finish = (
        reason: string, code: CodexFailureCode, detachNow = true, cleanupSnapshot = true,
      ): void => {
        if (stopped) return;
        stopped = true;
        if (compactStartTimer) clearTimeout(compactStartTimer);
        compactStartTimer = null;
        try { cancelApprovals(); } catch { /* the retiring transport owns cancellation */ }
        for (const queued of queue.splice(0)) {
          if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'unsent' });
        }
        if (detachNow) detachRoute();
        if (cleanupSnapshot) void cleanupActiveSnapshot().catch(() => {});
        try {
          emit({ type: 'stopped', reason: safePublicText(reason, opts.env), code });
        } finally {
          settleQuiescence();
        }
      };

      const finishUserStop = (): void => {
        finish('Stopped by user.', 'codex_user_stopped');
      };

      const finishRequest = (error: unknown, fallback: CodexFailureCode): void => {
        const reason = String((error as Error)?.message ?? error);
        finish(reason, error instanceof CodexRuntimeError ? error.code : classifyCodexFailure(reason, fallback));
      };

      const retireProtocolFailure = (reason: string): void => {
        if (stopped || protocolRetiring) return;
        protocolRetiring = true;
        const failure = { reason, code: 'codex_protocol_mismatch' as const };
        void supervisor.retireSessionGeneration(sessionId, failure).then(
          () => { if (!stopped) finish(failure.reason, failure.code); },
          () => { if (!stopped) finish(failure.reason, failure.code); },
        );
      };

      const finishTurnFailure = (error: unknown): void => {
        const failure = classifyCodexAppServerTurnFailure(error, opts.env);
        switch (failure.kind) {
          case 'UsageLimitExceeded':
            finish(failure.reason, 'codex_usage_limited');
            return;
          case 'Other':
            finish(failure.reason, 'codex_stream_failed');
            return;
        }
      };

      const interruptActiveTurn = (): void => {
        if (interruptSent || !threadId || !activeTurnId) return;
        interruptSent = true;
        const target = { threadId, turnId: activeTurnId };
        const interrupt = async (): Promise<void> => {
          // turn/start can acknowledge before the provider registers its active turn.
          // Retry only that exact rejection, never an unknown or transport failure.
          for (let attempt = 0; ; attempt += 1) {
            if (stopped) return;
            try {
              await supervisor.requestForSession(sessionId, 'turn/interrupt', target);
              return;
            } catch (error) {
              if (!(error instanceof AppServerRequestError) || !error.noActiveTurn || attempt === 5) throw error;
              await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
            }
          }
        };
        void interrupt().then(
          () => {
            if (interrupted) finishUserStop();
          },
          async () => {
            if (stopped || !interrupted) return;
            try {
              await supervisor.retireSessionGeneration(sessionId);
            } finally {
              if (!stopped) finishUserStop();
            }
          },
        );
      };

      const completeTurn = async (turnId: string): Promise<void> => {
        if (stopped || completing || turnId !== activeTurnId) return;
        completing = true;
        cancelApprovals();
        const usage = lastUsage(activeUsage);
        activeTurnId = null;
        activeUsage = null;
        try {
          await cleanupActiveSnapshot();
        } catch {
          // Snapshot cleanup is best-effort and must not suppress terminal events.
        }
        if (!stopped) {
          if (usage) emit(usage);
          emit({ type: 'status', status: 'done' });
        }
        completing = false;
        if (!stopped) void drain();
      };

      function onNotification(method: string, params: unknown): void {
        if (stopped) return;
        const value = object(params);
        if (!value) return;
        if (notificationHasUnsafeIdentifier(value)) {
          retireProtocolFailure('Codex app-server returned an unsafe provider identifier.');
          return;
        }
        const receivedTurn = text(value.turnId) ?? text(object(value.turn)?.id);
        if (method === 'turn/started' && receivedTurn && compactPending) {
          compactPending = false;
          if (compactStartTimer) clearTimeout(compactStartTimer);
          compactStartTimer = null;
          activeTurnId = receivedTurn;
          if (interrupted) interruptActiveTurn();
        }
        if (receivedTurn && !activeTurnId && turnRequestInFlight) {
          bufferedNotifications.push({ method, params });
          return;
        }
        if (method === 'turn/started') {
          if (receivedTurn && receivedTurn === activeTurnId) emit({ type: 'status', status: 'working' });
          return;
        }
        if (!receivedTurn || receivedTurn !== activeTurnId) return;
        if (method === 'item/started' || method === 'item/completed') {
          for (const event of normalizeCodexAppServerItem(method === 'item/started' ? 'started' : 'completed', value.item, opts.env)) emit(event);
          return;
        }
        if (method === 'turn/plan/updated' && Array.isArray(value.plan)) {
          emit({ type: 'upsert-msg', msg: {
            kind: 'todo', id: `codex-plan:${receivedTurn}`,
            items: value.plan.flatMap((step) => {
              const item = object(step);
              const stepText = item && text(item.step);
              return stepText === null ? [] : [{ text: safePublicText(stepText, opts.env), completed: item.status === 'completed' }];
            }),
          } });
          return;
        }
        if (method === 'thread/tokenUsage/updated') {
          activeUsage = value.tokenUsage;
          return;
        }
        if (method === 'error') {
          if (value.willRetry === true) return;
          finishTurnFailure(value.error);
          return;
        }
        if (method === 'turn/completed') {
          const completed = object(value.turn);
          const status = completed?.status;
          if (interrupted) {
            finishUserStop();
            return;
          }
          if (status === 'completed') {
            void completeTurn(receivedTurn);
          } else {
            finishTurnFailure(completed?.error);
          }
        }
      }

      const onFatal = (reason: string, code: CodexFailureCode): void => {
        if (interrupted) {
          finishUserStop();
        } else if (code === 'codex_transport_crashed') {
          finish('Codex app-server transport crashed. Retry the session manually.', code);
        } else finish(reason, code);
      };

      const drain = async (): Promise<void> => {
        if (draining || completing || compactPending || stopped || interrupted || protocolRetiring
          || !threadId || activeTurnId || queue.length === 0) return;
        const releaseWorktree = beginWorktreeOperation();
        draining = true;
        try {
          const queued = queue[0];
          if (/^\/compact(?:\s|$)/.test(queued.prompt.text.trim())) {
            if (queued.prompt.text.trim() !== '/compact' || queued.prompt.attachments.length) throw new Error('/compact does not accept arguments or attachments.');
            compactPending = true;
            compactStartTimer = setTimeout(() => {
              compactStartTimer = null;
              if (compactPending && !stopped) retireProtocolFailure('Codex compaction did not report a start notification.');
            }, 10_000);
            emit({type:'status',status:'working'});
            await supervisor.requestForSession(sessionId,'thread/compact/start',{threadId},()=>{
              const index = queue.indexOf(queued);
              if(index !== -1) queue.splice(index,1);
              if(queued.promptId) emit({type:'prompt-delivery',id:queued.promptId,delivery:'sent'});
            });
            return;
          }
          const selection = queued.prompt.capability ?? queued.prompt.text.match(/^\/(skill|app|mcp):[^\s]+/)?.[0].slice(1);
          const native = selection ? await supervisor.capabilitiesForSession(sessionId, opts.cwd, true, selection) : [];
          if (!Array.isArray(native)) throw new Error('Capability is no longer available; refresh and retry.');
          const prepared = await snapshotCodexPrompt(opts.cwd, queued.prompt);
          activeSnapshotCleanup = prepared.cleanup;
          let retainSnapshot = false;
          try {
            if (stopped || interrupted || protocolRetiring || queue[0] !== queued || !threadId || activeTurnId) return;
            emit({ type: 'status', status: 'working' });
            turnRequestInFlight = true;
            let response: { turn?: unknown };
            let dispatched = false;
            const acknowledgeDispatch = () => {
              if (dispatched) return;
              dispatched = true;
              const index = queue.indexOf(queued);
              if (index !== -1) queue.splice(index, 1);
              if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'sent' });
            };
            try {
              response = await supervisor.requestForSession<{ turn?: unknown }>(sessionId, 'turn/start', {
                threadId, input: [...codexAppServerPromptInput(prepared.prompt), ...native],
                ...(settings?.modelReasoningEffort !== undefined ? { effort: settings.modelReasoningEffort } : {}),
              }, acknowledgeDispatch);
            } finally {
              turnRequestInFlight = false;
            }
            const turn = object(response)?.turn;
            const id = turn && text(turn.id);
            if (!id || unsafeCodexProviderIdentifier(id)) {
              if (interrupted) {
                void supervisor.retireSessionGeneration(sessionId);
              } else if (stopped) detachRoute();
              else retireProtocolFailure('Codex app-server returned an invalid turn response.');
              return;
            }
            activeTurnId = id;
            retainSnapshot = true;
            const early = bufferedNotifications.splice(0);
            for (const notification of early) onNotification(notification.method, notification.params);
            if (interrupted && !stopped) interruptActiveTurn();
          } finally {
            if (!retainSnapshot && activeSnapshotCleanup === prepared.cleanup) {
              await cleanupActiveSnapshot();
            }
          }
        } catch (error) {
          if (interrupted && error instanceof CodexRuntimeError && error.code === 'codex_protocol_mismatch') {
            await supervisor.retireSessionGeneration(sessionId);
          } else if (interrupted) finishUserStop();
          else if (stopped) detachRoute();
          else finishRequest(error, 'codex_app_server_unavailable');
        } finally {
          draining = false;
          releaseWorktree();
          if (!stopped && !compactPending && !activeTurnId && queue.length) void drain();
        }
      };

      try {
        detach = supervisor.registerSession(sessionId, { onNotification, onFatal, onServerRequest, onServerResolved });
      } catch (error) {
        finishRequest(error, 'codex_app_server_unavailable');
        return { send() {}, decide() {}, setAuto() {}, stop() {}, quiescence };
      }
      const releaseThreadSetup = beginWorktreeOperation();
      void (async () => {
        try {
          try {
            settings = validateCodexSettings(opts.codexSettings);
          } catch (error) {
            finishRequest(error, opts.resumeId ? 'codex_resume_failed' : 'codex_start_failed');
            return;
          }
          if (opts.resumeId && unsafeCodexProviderIdentifier(opts.resumeId)) {
            finish('Codex app-server stored thread identifier is unsafe.', 'codex_protocol_mismatch');
            return;
          }
          const config = settingsConfig(settings);
          const params = {
            ...(opts.resumeId ? { threadId: opts.resumeId } : {}),
            cwd: opts.cwd, approvalPolicy: 'on-request' as const, approvalsReviewer: 'user' as const, sandbox: 'workspace-write' as const,
            ...(settings?.model !== undefined ? { model: settings.model } : {}),
            ...(config ? { config } : {}),
          };
          try {
            const response = await supervisor.requestForSession<unknown>(sessionId, opts.resumeId ? 'thread/resume' : 'thread/start', params);
            const id = await threadResponse(response, opts.cwd);
            if (!id || (opts.resumeId && id !== opts.resumeId)) {
              finish('Codex app-server thread response did not preserve the required sandbox.', 'codex_protocol_mismatch');
              return;
            }
            threadId = id;
            supervisor.bindThread(sessionId, id);
            emit({ type: 'vendor-session-id', id });
            void drain();
          } catch (error) {
            if (!stopped) finishRequest(error, opts.resumeId ? 'codex_resume_failed' : 'codex_start_failed');
          }
        } finally {
          releaseThreadSetup();
        }
      })();

      return {
        send(prompt, promptId) {
          if (stopped || interrupted || protocolRetiring) return;
          queue.push({ prompt, promptId });
          void drain();
        },
        decide(allow: boolean) {
          if (stopped || interrupted) return;
          try { approvals.decide(allow); } catch { retireProtocolFailure('Codex approval response failed.'); }
        },
        respondElicitation(requestId, response) {
          if (stopped || interrupted || protocolRetiring) return false;
          try { return approvals.respondElicitation(requestId, response); }
          catch { retireProtocolFailure('Codex form response failed.'); return false; }
        },
        async capabilities(force = false) {
          if (stopped || interrupted || protocolRetiring || !threadId) throw new Error('No live capability session.');
          return await supervisor.capabilitiesForSession(sessionId, opts.cwd, force) as CapabilitySnapshot;
        },
        async resolveCapability(alias) {
          if (stopped || interrupted || protocolRetiring || !threadId) return null;
          const snapshot = await supervisor.capabilitiesForSession(sessionId, opts.cwd, true) as CapabilitySnapshot;
          const entry = snapshot.capabilities.find(item => item.alias === alias && item.available);
          return entry?.id ?? null;
        },
        elicitationUrl(requestId) {
          return stopped || interrupted || protocolRetiring ? null : approvals.elicitationUrl(requestId);
        },
        answerQuestion(requestId, answer) {
          if (stopped || interrupted || protocolRetiring) return false;
          try { return approvals.answer(requestId, answer); }
          catch { retireProtocolFailure('Codex question response failed.'); return false; }
        },
        setAuto(on: boolean) {
          if (stopped || interrupted) return;
          try { approvals.setAuto(on); } catch { retireProtocolFailure('Codex approval response failed.'); }
        },
        stop() {
          if (stopped || interrupted || protocolRetiring) return;
          interrupted = true;
          try { cancelApprovals(); } catch { void supervisor.retireSessionGeneration(sessionId); }
          for (const queued of queue.splice(0)) {
            if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'unsent' });
          }
          interruptActiveTurn();
          if (!turnRequestInFlight && !compactPending && !activeTurnId) finishUserStop();
        },
        quiescence,
      };
    },
  };
}
