// DOM-free view logic, imported by app.js and covered by test/ui.test.ts.
// Everything else in app.js is DOM assembly, verified by using it — this file
// is the part with branches worth locking down.

const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };

const MIXED = 'Selected worktrees belong to different repos — pick worktrees from one repo';
const basename = (p) => p.split('/').filter(Boolean).pop() ?? p;

const byBlocked = (a, b) => ORDER[a.status] - ORDER[b.status] || b.statusSince - a.statusSince;

/**
 * Grid order. `blocked` is the default and the original behavior: blocked
 * first, then running, then finished, most recently changed first within each.
 * `newest` is a flat recency list. `account` groups by account name and falls
 * back to `blocked` inside each group, so grouping never costs you the
 * blocked-first reflex within the account you are looking at.
 */
export function sortSessions(sessions, mode = 'blocked') {
  const cmp = mode === 'newest'
    ? (a, b) => b.statusSince - a.statusSince
    : mode === 'account'
      ? (a, b) => a.account.localeCompare(b.account) || byBlocked(a, b)
      : byBlocked;
  return [...sessions].sort(cmp);
}

/** Hides finished sessions when the setting asks. `stopped` is deliberately not
 *  hidden: it carries a Resume button and unfinished work, unlike `done`. */
export function visibleSessions(sessions, collapseDone) {
  return collapseDone ? sessions.filter((s) => s.status !== 'done') : sessions;
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

/**
 * The transcript with consecutive tool messages folded into one collapsible
 * run, so a stretch of Read/Bash/Edit chatter costs one line instead of twenty.
 * Everything else passes through as `{ kind: 'msg', msg }`, and a run of one is
 * demoted back to a plain message — wrapping a single line in a disclosure
 * widget trades noise for noise.
 *
 * `at` is the index of the run's first message. The transcript is append-only,
 * so that index is a stable key for "did the user expand this run?" across the
 * full rebuild render() does on every SSE snapshot.
 */
export function groupTranscript(transcript) {
  const out = [];
  for (const [i, msg] of transcript.entries()) {
    const last = out.at(-1);
    if (msg.kind !== 'tool') out.push({ kind: 'msg', msg });
    else if (last?.kind === 'tools') last.msgs.push(msg);
    else out.push({ kind: 'tools', at: i, msgs: [msg] });
  }
  return out.map((g) => (g.kind === 'tools' && g.msgs.length === 1
    ? { kind: 'msg', msg: g.msgs[0] }
    : g));
}

/**
 * The one line a collapsed run shows. Tool names, not summaries: the summaries
 * are the thing being hidden, and the names are what tells you whether the run
 * was reading around or rewriting your files. Unresolved state (running, failed)
 * is on the label because that is what decides whether it is worth opening.
 */
export function toolRunLabel(msgs) {
  const names = [...new Set(msgs.map((m) => m.name))];
  const failed = msgs.filter((m) => m.status === 'error').length;
  return `${msgs.length} tool calls · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
    + (failed ? ` · ${failed} failed` : '')
    + (msgs.some((m) => m.status === 'running') ? ' · running' : '');
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

/**
 * Which sessions just entered a status worth notifying about.
 *
 * Keyed `id:status` rather than by id alone, so needs-you and done are tracked
 * independently and a session that goes needs-you -> working -> needs-you
 * notifies twice, which is two real interruptions.
 *
 * `seed` exists for one reason: EventSource reconnects on its own and the
 * server pushes a full snapshot on connect. Called with seed=true on the first
 * payload after a connect, this fires nothing and returns a seen-set covering
 * everything already on the board — without it, every dropped connection
 * notifies once per finished session for work that ended hours ago.
 *
 * The returned set is rebuilt from the current sessions each call, so a
 * deleted session's keys do not accumulate forever.
 */
export function newlyNotifiable(sessions, notifyOn, seen, seed = false) {
  const watched = sessions.filter((s) => notifyOn.includes(s.status));
  const next = new Set(watched.map((s) => `${s.id}:${s.status}`));
  const fire = seed ? [] : watched.filter((s) => !seen.has(`${s.id}:${s.status}`));
  return { fire, seen: next };
}

/**
 * Everything the meter and the account panel need to decide *what* to say,
 * with no DOM. The two branches are the point: an account with real plan
 * limits and one falling back to the local budget estimate must not be worded
 * the same, or an estimate reads as fact.
 *
 * The headline number is always the 5-hour window when the plan reports one:
 * it is the window that resets every few hours, so it is the one worth a
 * reflex check at a glance. Weekly utilization is still visible — both windows
 * are in `windows`, which the tap-open panel lists in full — it just does not
 * get to replace the badge's number. (`load`, used for the bar fill/color and
 * the New Session picker, is unrelated: it stays the worse-of-both-windows
 * fraction the server computes, so a nearly-exhausted week still ranks that
 * account as less free even though the badge reads 5h.)
 */
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
  // Fall back to whatever is there (7d only) for a plan that does not report a
  // 5h window at all. windows[0] is a safe fallback, not a guess: probeLimits()
  // rejects rather than resolving when both windows are empty, so `limits`
  // non-null guarantees at least one entry here.
  const primary = windows.find((w) => w.label === '5h') ?? windows[0];
  return {
    load: a.load,
    pct: primary.pct,
    real: true,
    title: `${a.name} — ${primary.pct}% of the ${primary.label} limit`,
    budgetLine: `${a.provider} · ${l.subscription ?? 'unknown'} plan`,
    note: '',
    windows,
  };
}

/**
 * The command token at the start of `text`, or -1 if there isn't one. Ends at
 * any whitespace, not just a space: the new-session prompt is a textarea, where
 * the command is the first line and a newline ends it just as surely.
 */
function tokenEnd(text) {
  if (!text.startsWith('/')) return -1;
  const ws = text.search(/\s/);
  return ws === -1 ? text.length : ws;
}

/** Where a name sorts for `query`: whole-name prefix, bare-name prefix, or substring. */
function rank(name, query) {
  const lower = name.toLowerCase();
  // Commands are listed namespaced ("ponytail:ponytail-help") but typing the
  // bare name works too, so "help" has to reach past the plugin prefix.
  const bare = lower.slice(lower.indexOf(':') + 1);
  if (lower.startsWith(query)) return 0;
  if (bare.startsWith(query)) return 1;
  return lower.includes(query) ? 2 : 3;
}

/**
 * What the composer's command menu should show, or null for "no menu".
 *
 * The menu belongs to the first token only: once the caret is past it the user
 * is writing arguments, and a list of commands is just in the way.
 */
export function commandMenu(text, caret, commands, limit = 8) {
  const end = tokenEnd(text);
  if (end === -1 || caret > end) return null;
  const query = text.slice(1, end).toLowerCase();
  const matches = commands
    .filter((c) => rank(c, query) < 3)
    .sort((a, b) => rank(a, query) - rank(b, query) || a.localeCompare(b))
    .slice(0, limit);
  return matches.length ? { query, matches } : null;
}

/**
 * The leading command if it is one the agent will actually recognise, else null.
 * This is what gets coloured — highlighting an unknown token would promise the
 * user something that is about to be sent as plain text.
 */
export function commandToken(text, commands) {
  const end = tokenEnd(text);
  if (end === -1) return null;
  const token = text.slice(1, end);
  const known = commands.some((c) => c === token || c.slice(c.indexOf(':') + 1) === token);
  return known ? text.slice(0, end) : null;
}

// In picker order: eight accents around the wheel starting at coral, then the
// canvases light-to-dark. The hexes live in web/style.css, which is what
// test/palette.test.ts measures — these are only names.
export const ACCENTS = Object.freeze(['coral', 'amber', 'moss', 'teal', 'sky', 'indigo', 'violet', 'rose']);
export const CANVASES = Object.freeze(['cream', 'paper', 'ink', 'void']);

const DEFAULT_THEME = Object.freeze({ accent: 'coral', canvas: 'ink' });

/**
 * The stored theme, or the default for anything that is not a known pair.
 * localStorage is user-editable and this value is read before the stylesheet
 * applies, so an unvalidated one paints an unstyled page. The two halves fall
 * back independently: an unrecognised accent should not also throw away a
 * perfectly good canvas.
 */
export function readTheme(raw) {
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_THEME };
  }
  return {
    accent: ACCENTS.includes(stored?.accent) ? stored.accent : DEFAULT_THEME.accent,
    canvas: CANVASES.includes(stored?.canvas) ? stored.canvas : DEFAULT_THEME.canvas,
  };
}

/**
 * Maps each commit to the branch whose line it sits on, for hover-tracing.
 *
 * git only reports a ref at a branch's tip, so every commit below it is
 * anonymous. Walking back from each tip recovers the rest. The first tip to
 * claim a commit keeps it — the same first-claimer-wins rule assignLanes
 * already applies to lanes — and the walk stops at trunk, which has its own
 * tier and needs no tracing.
 */
function branchNames(c) {
  return c.refs
    .filter((r) => !r.startsWith('tag: '))
    .map((r) => r.replace(/^HEAD -> /, ''))
    .filter((r) => r !== 'HEAD');
}

export function attributeBranches(commits) {
  const at = new Map(commits.map((c) => [c.h, c]));
  const owner = new Map();
  // Seed each ref-bearing commit with its own name before any walk runs. A
  // merge's walk reaches every ancestor of both parents, including another
  // branch's tip (the merged-in branch's own history) — without a seed, that
  // walk would run first (it's the child, so it's earlier in topo order) and
  // claim the tip for itself before the tip ever gets to claim its own name.
  for (const c of commits) {
    if (c.tier === 'trunk') continue;
    const names = branchNames(c);
    if (names.length && !owner.has(c.h)) owner.set(c.h, names[0]);
  }
  for (const c of commits) {
    const names = branchNames(c);
    for (const name of names) {
      const queue = [c.h];
      const seen = new Set();
      while (queue.length) {
        const h = queue.shift();
        const cur = at.get(h);
        // Missing parent (outside the window) or trunk, which has its own tier.
        if (!cur || cur.tier === 'trunk') continue;
        // Claimed by a different name: another branch's tip, which the seed
        // pass pre-claimed for itself — stop rather than swallow its history.
        const claimed = owner.get(h);
        if (claimed !== undefined && claimed !== name) continue;
        // Expanded already. The guard above deliberately lets a same-name node
        // through, so without this a node reachable by two paths inside one
        // branch re-expands its whole ancestry each time — exponential on
        // nested merges, in a function that reruns every 2s poll.
        if (seen.has(h)) continue;
        seen.add(h);
        owner.set(h, name);
        queue.push(...cur.p);
      }
    }
  }
  return owner;
}
