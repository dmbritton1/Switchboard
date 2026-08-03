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

/**
 * The buttons a pending request gets, as [label, commandFields] pairs. An
 * AskUserQuestion carries `options`, and each one answers the question outright;
 * Skip denies it normally so the agent falls back to asking in prose, which the
 * composer can answer. Everything else is the usual Allow/Deny.
 */
export function decideSpecs(pending) {
  if (!pending.options?.length) return [['Allow', { allow: true }], ['Deny', { allow: false }]];
  return [
    ...pending.options.map((label) => [label, { answer: label }]),
    ['Skip', { allow: false }],
  ];
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
