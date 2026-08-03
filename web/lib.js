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
 * The buttons a pending request gets: `{ label, description, command }`, where
 * `command` is merged into the decide call. An AskUserQuestion carries
 * `options`, and each one answers the question outright, captioned with the
 * agent's own explanation of that choice; Skip denies it normally so the agent
 * falls back to asking in prose, which the composer can answer. Everything else
 * is the usual Allow/Deny, which needs no caption.
 */
export function decideSpecs(pending) {
  if (!pending.options?.length) {
    return [
      { label: 'Allow', command: { allow: true } },
      { label: 'Deny', command: { allow: false } },
    ];
  }
  return [
    ...pending.options.map(({ label, description }) => ({
      label,
      description,
      command: { answer: label },
    })),
    { label: 'Skip', description: 'None of these — answer in your own words instead.', command: { allow: false } },
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

/**
 * Everything the meter and the account panel need to decide *what* to say,
 * with no DOM. The two branches are the point: an account with real plan
 * limits and one falling back to the local budget estimate must not be worded
 * the same, or an estimate reads as fact.
 *
 * The headline number is the worse of the two windows, matching the server's
 * `load` — a nearly-exhausted week must not hide behind a quiet 5h window.
 */
/**
 * The account the New worktree dialog defaults to.
 *
 * Not simply the lowest `load`. Since real plan limits landed, an account that
 * has them reports true utilization while one that doesn't falls back to the
 * local token-spend estimate — which reads 0% until Switchboard has watched it
 * spend something, and is 0% forever for a provider it can't probe. Ranking
 * those two numbers against each other made every un-probed account the
 * "freest" one available, so the dialog silently defaulted to it. A real number
 * outranks an estimate (`real` in accountView() is the same test); ties fall
 * back to load.
 */
export function freestAccount(accounts) {
  return [...accounts].sort(
    (a, b) => Number(Boolean(b.limits)) - Number(Boolean(a.limits)) || a.load - b.load,
  )[0];
}

export function accountView(a) {
  const l = a.limits;
  if (!l) {
    const pct = Math.round(a.pace * 100);
    return {
      load: a.load ?? a.pace,
      pct,
      real: false,
      title: `${a.name} — ~${pct}% of its 5h budget (estimate)`,
      budgetLine: `${a.provider} · ~${pct}% of a ${a.budget.toLocaleString()} token budget · estimate`,
      note: 'Estimated from observed token spend against the budget in accounts.json — not a real plan limit.',
      windows: [],
    };
  }
  const windows = [
    l.fiveHour && { label: '5h', pct: l.fiveHour.utilization, resetsAt: l.fiveHour.resetsAt },
    l.sevenDay && { label: '7d', pct: l.sevenDay.utilization, resetsAt: l.sevenDay.resetsAt },
  ].filter(Boolean);
  // windows[0] is a safe seed, not a fallback: probeLimits() now rejects rather
  // than resolving when both windows are empty, so `limits` non-null guarantees
  // at least one entry here.
  const worst = windows.reduce((m, w) => (w.pct > m.pct ? w : m), windows[0]);
  return {
    load: a.load,
    pct: worst.pct,
    real: true,
    title: `${a.name} — ${worst.pct}% of the ${worst.label} limit`,
    budgetLine: `${a.provider} · ${l.subscription ?? 'unknown'} plan`,
    note: '',
    windows,
  };
}
