// DOM-free view logic, imported by app.js and covered by test/ui.test.ts.
// Everything else in app.js is DOM assembly, verified by using it — this file
// is the part with branches worth locking down.

const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };

const MIXED = 'Selected worktrees belong to different repos — pick worktrees from one repo';
const basename = (p) => p.split('/').filter(Boolean).pop() ?? p;

/** Blocked first, then running, then finished — most recently changed first within each. */
export function sortSessions(sessions) {
  return [...sessions].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.statusSince - a.statusSince,
  );
}

/**
 * Which action a card's single slot gets. `queue` is the scheduling queue from
 * the SSE snapshot; it does not exist until the scheduling work lands, so it
 * defaults to empty and the 'waiting' branch is simply never taken today.
 */
export function cardAction(session, queue = []) {
  if (session.pending) return { kind: 'approve' };
  if (session.status === 'working' || session.status === 'needs-you') return { kind: 'stop' };
  if (session.status === 'stopped') {
    const held = queue.find(
      (q) => q.state === 'waiting'
        && q.trigger?.kind === 'reset'
        && q.action?.kind === 'resume'
        && q.action.sessionId === session.id,
    );
    return held ? { kind: 'waiting', account: held.trigger.account } : { kind: 'resume' };
  }
  return { kind: 'none' };
}

/** A queue item's trigger, rendered for the queue strip. */
export function triggerLabel(t) {
  if (t.kind === 'at') return new Date(t.time).toLocaleString();
  return `when ${t.account} resets`;
}

/**
 * A queue item's target, rendered for the queue strip. `sessions` is passed in
 * rather than read from a module global, the way `selectionState` already
 * takes `sessions` and `selected` as arguments — that's what keeps this DOM-free
 * and testable.
 */
export function targetLabel(action, sessions) {
  if (action.kind === 'create') return `${action.branch} · new worktree`;
  const s = sessions.find((x) => x.id === action.sessionId);
  const branch = s ? s.branch : 'deleted session';
  return action.kind === 'resume' ? `${branch} · resume` : `${branch} · message`;
}

/**
 * Label and button states for the selection bar. The same-repo rule is the
 * authoritative one server-side (selectedRepo() in server.ts) — this is the
 * courtesy that disables the buttons instead of erroring after the click.
 */
export function selectionState(sessions, selected) {
  const chosen = sessions.filter((s) => selected.has(s.id));
  if (!chosen.length) {
    return { count: 0, label: '', merge: { enabled: false, reason: '' }, push: { enabled: false, reason: '' } };
  }
  const repos = new Set(chosen.map((s) => s.repo));
  const mixed = repos.size > 1;
  const busy = chosen.find((s) => s.status === 'working' || s.status === 'needs-you');
  return {
    count: chosen.length,
    label: mixed
      ? `${chosen.length} selected across ${repos.size} repos`
      : `${chosen.length} selected · ${basename(chosen[0].repo)}`,
    merge: {
      enabled: !mixed && !busy,
      reason: mixed ? MIXED : busy ? `"${busy.branch}" is still running — stop it or wait` : '',
    },
    push: { enabled: !mixed, reason: mixed ? MIXED : '' },
  };
}

export const CODEX_FAILURE_LABEL = Object.freeze({
  codex_platform_unsupported: 'Unsupported platform',
  codex_binary_missing: 'Codex executable missing',
  codex_binary_not_executable: 'Codex executable is not runnable',
  codex_version_unreadable: 'Codex version unavailable',
  codex_version_mismatch: 'Codex version mismatch',
  codex_auth_unavailable: 'Codex login unavailable',
  codex_start_failed: 'Codex failed to start',
  codex_resume_failed: 'Codex failed to resume',
  codex_stream_failed: 'Codex stream failed',
  codex_sandbox_denied: 'Blocked by worktree sandbox',
  codex_user_stopped: 'Stopped by you',
});

export async function postCommand(body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: `Switchboard request failed: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

export function commandFailure(result) {
  if (result.ok) return '';
  return String(result.data?.error ?? `Command failed with HTTP ${result.status}`);
}

export function retainedSessionError(sessionId, result) {
  const message = commandFailure(result);
  return message ? { sessionId, message } : null;
}

/** Keep upload metadata in the browser while sending only server-issued paths. */
export function addAttachment(list, attachment) {
  return list.some((item) => item.path === attachment.path)
    ? list
    : [...list, attachment];
}

export function removeAttachment(list, path) {
  return list.filter((item) => item.path !== path);
}

export function sendPayload(sessionId, text, attachments) {
  return {
    cmd: 'send', id: sessionId, text,
    attachments: attachments.map((item) => item.path),
  };
}

/** Transactional composer state: a rejected command remains retryable. */
export function settleSendState(text, attachments, result) {
  return result.ok ? { text: '', attachments: [] } : { text, attachments };
}

/**
 * The text for the retained session error, or '' when there is none.
 *
 * Deviation from the plan, which said to clear this region whenever `openId`
 * changes: the grid's Allow/Deny and Stop buttons act on a session other than
 * the open one, so clearing on navigation drops exactly the failure the user
 * needs. It is retained instead — and because it can therefore belong to a
 * session that is nowhere on screen, it is named. `sessions` is passed in
 * rather than read from a module global, like selectionState() above.
 */
export function commandErrorText(error, sessions, openId) {
  if (!error) return '';
  if (error.sessionId === openId) return error.message;
  const session = sessions.find((s) => s.id === error.sessionId);
  return session ? `${session.branch}: ${error.message}` : error.message;
}

/**
 * Convert an SSE transcript message into the small, untrusted view model used
 * by the browser renderer. IDs survive only where they are needed as internal
 * lazy-detail keys; no projection puts them into visible text.
 */
export function transcriptView(message) {
  if (message.kind === 'tool') {
    const suffix = message.status === 'running' ? '' : ` · ${message.status}`;
    return {
      kind: 'tool',
      id: message.id ?? '',
      className: `msg tool ${message.status}`,
      summary: `${message.name}: ${message.summary}${suffix}`,
      detailAvailable: message.detailAvailable ?? false,
      detailEvicted: message.detailEvicted ?? false,
      detailRevision: message.detailRevision ?? 0,
      truncated: message.detailTruncated ?? false,
    };
  }
  if (message.kind === 'reasoning') {
    return { kind: 'reasoning', className: 'msg reasoning', summary: message.text };
  }
  if (message.kind === 'todo') {
    return {
      kind: 'todo',
      className: 'msg todo',
      items: message.items.map(({ text, completed }) => ({ text, completed })),
    };
  }
  const attachments = message.kind === 'user' && Array.isArray(message.attachments)
    ? message.attachments
      .filter((name) => typeof name === 'string')
      .map((name) => name.split(/[\\/]/).filter(Boolean).pop() ?? '')
      .filter((name) => name && name !== '.' && name !== '..')
    : [];
  return {
    kind: 'text', className: `msg ${message.kind}`, summary: message.text,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Collision-free key for browser-local detail state. */
export function detailKey(sessionId, itemId) {
  return JSON.stringify([sessionId, itemId]);
}

/** Share one in-flight request for one exact session/item/revision key. */
export function requestOnce(requests, key, load) {
  const current = requests.get(key);
  if (current) return current;
  let request;
  request = load().finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

export function needsDetailFetch(view, cached) {
  return view.detailAvailable
    && !view.detailEvicted
    && (!cached || cached.revision !== view.detailRevision);
}

/**
 * The renderer's only detail-state branch table. Keeping it DOM-free makes a
 * destructive transcript rebuild equivalent to the prior render.
 */
export function detailPresentation(view, expanded, cached) {
  if (!expanded || (!view.detailAvailable && !view.detailEvicted)) {
    return { open: false, mode: 'hidden', text: '', fetch: false };
  }
  if (view.detailEvicted) {
    return {
      open: true,
      mode: 'evicted',
      text: 'Detail removed to stay within the storage limit.',
      fetch: false,
    };
  }
  if (!cached || cached.revision !== view.detailRevision) {
    return { open: true, mode: 'loading', text: 'Loading…', fetch: true };
  }
  if (cached.error) {
    return { open: true, mode: 'error', text: cached.error, fetch: false };
  }
  return { open: true, mode: 'content', text: cached.text ?? '', fetch: false };
}

/** Browser-local state for lazy transcript detail, kept DOM-free for testing. */
export function createDetailController() {
  return {
    expandedItems: new Set(),
    detailCache: new Map(),
    detailRequests: new Map(),
    detailSession: null,
    generation: 0,
  };
}

/** Reset every session-scoped collection on a real open, switch, or Back. */
export function changeDetailSession(controller, sessionId) {
  if (controller.detailSession === sessionId) return false;
  controller.expandedItems.clear();
  controller.detailCache.clear();
  controller.detailRequests.clear();
  controller.detailSession = sessionId;
  controller.generation++;
  return true;
}

export function setDetailExpanded(controller, sessionId, itemId, expanded) {
  const key = detailKey(sessionId, itemId);
  if (expanded) controller.expandedItems.add(key);
  else controller.expandedItems.delete(key);
  return key;
}

/**
 * Reconcile one SSE tool projection with browser-local state, then delegate
 * every visible branch to detailPresentation().
 */
export function detailControllerView(controller, sessionId, view) {
  const key = detailKey(sessionId, view.id);
  if (!view.detailAvailable || view.detailEvicted) controller.detailCache.delete(key);
  if (!view.detailAvailable && !view.detailEvicted) controller.expandedItems.delete(key);
  const presentation = detailPresentation(
    view,
    controller.expandedItems.has(key),
    controller.detailCache.get(key),
  );
  return {
    key,
    presentation,
    request: presentation.fetch && controller.detailSession === sessionId
      ? {
          key,
          requestKey: JSON.stringify([key, view.detailRevision]),
          sessionId,
          itemId: view.id,
          revision: view.detailRevision,
          generation: controller.generation,
        }
      : null,
  };
}

function detailRequestIsCurrent(controller, request, currentView) {
  return Boolean(request
    && controller.generation === request.generation
    && controller.detailSession === request.sessionId
    && currentView?.kind === 'tool'
    && currentView.id === request.itemId
    && currentView.detailAvailable
    && !currentView.detailEvicted
    && currentView.detailRevision === request.revision);
}

export function storeToolDetail(controller, request, currentView, detail) {
  if (!detailRequestIsCurrent(controller, request, currentView)
    || detail.revision !== request.revision) return false;
  controller.detailCache.set(request.key, {
    revision: detail.revision,
    text: detail.text,
    truncated: detail.truncated,
  });
  return true;
}

export function storeToolDetailError(controller, request, currentView, error) {
  if (!detailRequestIsCurrent(controller, request, currentView)) return false;
  controller.detailCache.set(request.key, {
    revision: request.revision,
    text: null,
    truncated: false,
    error,
  });
  return true;
}

export function invalidateToolDetail(controller, sessionId, itemId) {
  const key = detailKey(sessionId, itemId);
  controller.detailCache.delete(key);
  return key;
}

export async function fetchToolDetail(sessionId, itemId, fetchImpl = fetch) {
  const params = new URLSearchParams({ session: sessionId, item: itemId });
  let response;
  try {
    response = await fetchImpl(`/detail?${params}`);
  } catch {
    throw new Error('Detail request failed.');
  }
  if (!response.ok) throw new Error(`Detail request failed (HTTP ${response.status}).`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Detail request failed.');
  }
  if (!body || typeof body !== 'object'
    || (body.text !== null && typeof body.text !== 'string')
    || typeof body.truncated !== 'boolean'
    || typeof body.evicted !== 'boolean'
    || typeof body.revision !== 'number'
    || !Number.isFinite(body.revision)) {
    throw new Error('Detail request failed.');
  }
  return body;
}
