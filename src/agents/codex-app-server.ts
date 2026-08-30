import { safeCodexDetail } from './codex-detail.ts';
import { classifyCodexFailure } from './codex.ts';
import { redactCodexText } from './codex-runtime.ts';
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

function threadResponse(value: unknown, cwd: string): string | null {
  const response = object(value);
  const thread = response && object(response.thread);
  const sandbox = response && object(response.sandbox);
  const id = thread && text(thread.id);
  if (!response || !thread || !sandbox || !id
    || response.cwd !== cwd || thread.cwd !== cwd
    || response.approvalPolicy !== 'never' || sandbox.type !== 'workspaceWrite') return null;
  return id;
}

function settingsConfig(settings: StartOpts['codexSettings']): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  const config: Record<string, unknown> = {};
  if (settings.modelReasoningEffort !== undefined) config.effort = settings.modelReasoningEffort;
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
      const queue: QueueEntry[] = [{ prompt: opts.prompt, promptId: opts.promptId }];
      let detach: (() => void) | null = null;
      let threadId: string | null = null;
      let activeTurnId: string | null = null;
      let activeUsage: unknown = null;
      let activeSnapshotCleanup: (() => Promise<void>) | null = null;
      let draining = false;
      let completing = false;
      let stopped = false;
      let interrupted = false;
      let interruptSent = false;
      let turnRequestInFlight = false;
      const bufferedNotifications: Array<{ method: string; params: unknown }> = [];

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

      const finish = (
        reason: string, code: CodexFailureCode, detachNow = true, cleanupSnapshot = true,
      ): void => {
        if (stopped) return;
        stopped = true;
        for (const queued of queue.splice(0)) {
          if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'unsent' });
        }
        if (detachNow) detachRoute();
        if (cleanupSnapshot) void cleanupActiveSnapshot().catch(() => {});
        emit({ type: 'stopped', reason: safePublicText(reason, opts.env), code });
      };

      const finishRequest = (error: unknown, fallback: CodexFailureCode): void => {
        const reason = String((error as Error)?.message ?? error);
        finish(reason, classifyCodexFailure(reason, fallback));
      };

      const interruptActiveTurn = (): void => {
        if (interruptSent || !threadId || !activeTurnId) return;
        interruptSent = true;
        void supervisor.requestForSession(sessionId, 'turn/interrupt', {
          threadId, turnId: activeTurnId,
        }).catch(() => {});
      };

      const completeTurn = async (turnId: string): Promise<void> => {
        if (stopped || completing || turnId !== activeTurnId) return;
        completing = true;
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
        const receivedTurn = text(value.turnId) ?? text(object(value.turn)?.id);
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
          const error = object(value.error);
          finish(text(error?.message) ?? 'Codex app-server turn failed.', 'codex_stream_failed');
          return;
        }
        if (method === 'turn/completed') {
          const completed = object(value.turn);
          const status = completed?.status;
          if (status === 'completed') {
            void completeTurn(receivedTurn);
          } else if (status === 'interrupted' && interrupted) {
            // stop() already produced the one terminal event.
          } else {
            const error = object(completed?.error);
            finish(text(error?.message) ?? 'Codex app-server turn failed.', 'codex_stream_failed');
          }
        }
      }

      const onFatal = (reason: string, code: CodexFailureCode): void => {
        if (code === 'codex_transport_crashed') {
          finish('Codex app-server transport crashed. Retry the session manually.', code);
        } else finish(reason, code);
      };

      const drain = async (): Promise<void> => {
        if (draining || completing || stopped || !threadId || activeTurnId || queue.length === 0) return;
        draining = true;
        try {
          const queued = queue[0];
          const prepared = await snapshotCodexPrompt(opts.cwd, queued.prompt);
          activeSnapshotCleanup = prepared.cleanup;
          let retainSnapshot = false;
          try {
            if (stopped || queue[0] !== queued || !threadId || activeTurnId) return;
            emit({ type: 'status', status: 'working' });
            queue.shift();
            if (queued.promptId) emit({ type: 'prompt-delivery', id: queued.promptId, delivery: 'sent' });
            turnRequestInFlight = true;
            let response: { turn?: unknown };
            try {
              response = await supervisor.requestForSession<{ turn?: unknown }>(sessionId, 'turn/start', {
                threadId, input: codexAppServerPromptInput(prepared.prompt),
              });
            } finally {
              turnRequestInFlight = false;
            }
            const turn = object(response)?.turn;
            const id = turn && text(turn.id);
            if (!id) {
              if (stopped) detachRoute();
              else finish('Codex app-server returned an invalid turn response.', 'codex_protocol_mismatch');
              return;
            }
            activeTurnId = id;
            if (stopped) {
              if (interrupted) interruptActiveTurn();
              detachRoute();
              return;
            }
            retainSnapshot = true;
            const early = bufferedNotifications.splice(0);
            for (const notification of early) onNotification(notification.method, notification.params);
          } finally {
            if (!retainSnapshot && activeSnapshotCleanup === prepared.cleanup) {
              await cleanupActiveSnapshot();
            }
          }
        } catch (error) {
          if (stopped) detachRoute();
          else finishRequest(error, 'codex_app_server_unavailable');
        } finally {
          draining = false;
        }
      };

      try {
        detach = supervisor.registerSession(sessionId, { onNotification, onFatal });
      } catch (error) {
        finishRequest(error, 'codex_app_server_unavailable');
        return { send() {}, decide() {}, setAuto() {}, stop() {} };
      }
      void (async () => {
        let settings: StartOpts['codexSettings'];
        try {
          settings = validateCodexSettings(opts.codexSettings);
        } catch (error) {
          finishRequest(error, opts.resumeId ? 'codex_resume_failed' : 'codex_start_failed');
          return;
        }
        const config = settingsConfig(settings);
        const params = {
          ...(opts.resumeId ? { threadId: opts.resumeId } : {}),
          cwd: opts.cwd, approvalPolicy: 'never' as const, sandbox: 'workspace-write' as const,
          ...(settings?.model !== undefined ? { model: settings.model } : {}),
          ...(config ? { config } : {}),
        };
        try {
          const response = await supervisor.requestForSession<unknown>(sessionId, opts.resumeId ? 'thread/resume' : 'thread/start', params);
          const id = threadResponse(response, opts.cwd);
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
      })();

      return {
        send(prompt, promptId) {
          if (stopped) return;
          queue.push({ prompt, promptId });
          void drain();
        },
        decide() {},
        setAuto() {},
        stop() {
          if (stopped) return;
          interrupted = true;
          interruptActiveTurn();
          finish('Stopped by user.', 'codex_user_stopped', !turnRequestInFlight, !turnRequestInFlight);
        },
      };
    },
  };
}
