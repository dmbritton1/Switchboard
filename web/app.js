import {
  sortSessions, visibleSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel,
  postCommand, commandFailure, retainedSessionError, commandErrorText, CODEX_FAILURE_LABEL,
  accountView, freestAccount, newlyNotifiable,
} from './lib.js';

let state = { sessions: [], accounts: [] };
let openId = null;
// Which header panel is open: null, 'queue', or an account name. Mutually
// exclusive by construction — one variable, not one flag per panel.
let panel = null;
// Keys are `id:status`; see newlyNotifiable in lib.js.
let seenNotified = new Set();

const NOTIFY_VERB = { 'needs-you': 'needs you', done: 'finished', stopped: 'stopped' };
// Session whose chat view has already been auto-scrolled once; see renderChatPane().
let scrolledFor = null;
// Ids checked for the merge/push toolbar. A plain module-level Set, same pattern
// as openId — render() reads it, checkbox/button handlers mutate it and re-render.
let selected = new Set();
// Result text from the last merge/push, shown in the toolbar until the next
// selection change or action. Not part of `state`: it doesn't come from the
// server's SSE snapshot, it's local UI feedback for a fire-and-forget-style
// command that, unlike most of this app's commands, we do want to surface.
let selectionMessage = '';
let sessionCommandError = null;
let queueCommandError = '';
// Worktrees whose `create` command is in flight. `git worktree add` (and the
// launch after it) takes long enough that the dialog closes and the grid
// re-renders well before the real session exists in `state` — without this,
// the user is left staring at an unchanged grid and can't tell anything
// happened. Not part of `state`: it never comes from an SSE snapshot, and
// `state` is fully overwritten on every message (see es.onmessage) so
// anything stuffed into state.sessions would be wiped by the next unrelated
// snapshot. Cleared once the create command settles, success or failure —
// on success the real card takes over on the next snapshot; on failure the
// dialog reopens with an error and there is nothing left to show as pending.
let pendingCreates = [];

const $ = (sel) => document.querySelector(sel);

async function runSessionCommand(body) {
  const result = await postCommand(body);
  sessionCommandError = retainedSessionError(String(body.id), result);
  render();
  return result;
}

async function runQueueCommand(body) {
  const result = await postCommand(body);
  queueCommandError = commandFailure(result);
  render();
  return result;
}

// EventSource reconnects on its own, so there is no backoff code to write.
const es = new EventSource('/events');
// True until the first payload of a connection has been consumed. The server
// pushes full state on connect, so that payload seeds the seen-set instead of
// notifying for everything already on the board.
let seeding = true;
es.onopen = () => { seeding = true; };
es.onmessage = (e) => {
  $('#conn').hidden = true;
  state = JSON.parse(e.data);
  // First snapshot only: state.settings (and everything else) is absent from
  // the pre-snapshot initial `state`, so ⚙ and + New start disabled in markup
  // to keep their handlers from reading state.settings off an object that
  // doesn't have it yet.
  $('#settings-btn').disabled = false;
  $('#new-btn').disabled = false;
  notify(seeding);
  seeding = false;
  render();
};
// EventSource reconnects on its own; this only makes the gap visible.
es.onerror = () => { $('#conn').hidden = false; };

function notify(seed) {
  const needs = state.sessions.filter((s) => s.status === 'needs-you');
  // Deliberately not driven by notifyOn: the title counter answers "how many
  // are blocked on me", which is not the same question as "what do I want
  // pinged about".
  document.title = needs.length ? `(${needs.length}) Switchboard` : 'Switchboard';
  if (Notification.permission !== 'granted') return;

  // `stopped` in notifyOn means a self-inflicted Stop also notifies — accepted,
  // since the setting is off by default and its label says so. The case that
  // actually needs guarding is a server restart: Registry.load revives every
  // session as `stopped` (sessions.ts), which would otherwise fire once per
  // session on every reconnect. `seed` is what prevents that: the reconnect's
  // first payload comes through with seed=true (see es.onopen below), so
  // newlyNotifiable seeds seenNotified from it instead of firing.
  const on = state.settings?.notifyOn ?? ['needs-you'];
  const { fire, seen } = newlyNotifiable(state.sessions, on, seenNotified, seed || document.hasFocus());
  seenNotified = seen;
  for (const s of fire) {
    new Notification(`${s.branch} ${NOTIFY_VERB[s.status]}`, { body: s.pending?.summary ?? '' });
  }
}

function elapsed(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function stoppedLabel(s) {
  return CODEX_FAILURE_LABEL[s.stoppedCode] ?? s.stoppedReason ?? 'stopped';
}

// Commits last fetched for the open session's Graph tab. Graph data is not in
// the SSE snapshot: commits change when the agent commits or the user merges,
// neither of which is a session-state event, so this view polls instead of
// riding render().
let graphCommits = [];

function setPanel(next) {
  panel = panel === next ? null : next;
  render();
}

function accountMeter(a) {
  const v = accountView(a);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `meter${panel === a.name ? ' open' : ''}`;
  b.title = v.title;

  const name = document.createElement('span');
  name.textContent = a.name;

  const bar = document.createElement('span');
  // Real utilization caps at 100 (load caps at 1.0), so `> 1` was unreachable
  // for exactly the accounts that have a real number to warn about.
  bar.className = `bar ${v.load >= 1 ? 'over' : ''}`;
  const fill = document.createElement('i');
  fill.style.width = `${Math.min(v.pct, 100)}%`;
  bar.append(fill);

  const num = document.createElement('span');
  num.textContent = `${v.pct}%`;

  b.append(name, bar, num);
  b.onclick = () => setPanel(a.name);
  return b;
}

function accountPanel(a) {
  const v = accountView(a);
  const box = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = a.name;

  const line = document.createElement('p');
  line.className = 'meta';
  line.textContent = v.budgetLine;
  box.append(h, line);

  for (const w of v.windows) {
    const row = document.createElement('p');
    row.className = 'meta';
    // Local time: a UTC reset timestamp is a small puzzle every single glance.
    row.textContent = `${w.label} · ${w.pct}% · resets ${new Date(w.resetsAt).toLocaleString()}`;
    box.append(row);
  }

  if (v.note) {
    const note = document.createElement('p');
    note.className = 'meta';
    note.textContent = v.note;
    box.append(note);
  }
  // Panel only: the meter stays a number, and a logged-out alt account should
  // not make every glance at the header look like a failure.
  if (a.limitsError) {
    const err = document.createElement('p');
    err.className = 'meta';
    err.textContent = `No real plan limits: ${a.limitsError}`;
    box.append(err);
  }
  return box;
}

// The scheduling queue rides the SSE snapshot (see the scheduling design), which
// does not carry it yet — so this is written to render nothing until it does,
// rather than guarded at each call site.
const queueItems = () => state.queue ?? [];

function queueRow(q) {
  const row = document.createElement('div');
  row.className = 'queue-row';

  const when = document.createElement('span');
  when.className = 'queue-when';
  when.textContent = triggerLabel(q.trigger);

  const what = document.createElement('span');
  what.className = 'queue-what';
  what.textContent = targetLabel(q.action, state.sessions);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'queue-del';
  del.title = 'Remove from queue';
  del.textContent = '✕';
  del.onclick = async () => { await runQueueCommand({ cmd: 'unschedule', itemId: q.id }); };

  row.append(when, what, del);

  // missed and failed items stay in the queue on purpose, so their reason has
  // to be readable here — this is the only place they are ever shown.
  if (q.state !== 'waiting') {
    const why = document.createElement('p');
    why.className = 'queue-why';
    why.textContent = q.state === 'missed'
      ? 'missed — its time passed while Switchboard was not running'
      : `failed — ${q.error ?? 'unknown error'}`;
    row.append(why);
  }
  return row;
}

function queuePanel() {
  const box = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = 'Scheduled';
  box.append(h, ...queueItems().map(queueRow));
  if (queueCommandError) {
    const error = document.createElement('p');
    error.className = 'queue-error';
    error.setAttribute('role', 'alert');
    error.append(queueCommandError, ' ');
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = () => { queueCommandError = ''; render(); };
    error.append(dismiss);
    box.append(error);
  }
  return box;
}

/** The open panel's contents, or null. */
function panelBody() {
  if (!panel) return null;
  if (panel === 'queue') return queueItems().length || queueCommandError ? queuePanel() : null;
  const account = state.accounts.find((a) => a.name === panel);
  return account ? accountPanel(account) : null;
}

function renderHeader() {
  $('#meters').replaceChildren(...state.accounts.map(accountMeter));
  const badge = $('#queue-badge');
  const n = queueItems().length;
  badge.hidden = n === 0;
  badge.textContent = `⏱ ${n}`;
  badge.className = panel === 'queue' ? 'open' : '';
  badge.title = `${n} scheduled item${n === 1 ? '' : 's'}`;
  const body = panelBody();
  // A panel whose subject vanished (account renamed out of accounts.json)
  // closes itself rather than leaving an empty box open.
  if (panel && !body) panel = null;
  $('#panel').hidden = !body;
  $('#panel').replaceChildren(...(body ? [body] : []));
}

function render() {
  renderHeader();
  renderCommandError();
  openId ? renderSession() : renderGrid();
}

function renderCommandError() {
  const error = $('#command-error');
  error.replaceChildren();
  const text = commandErrorText(sessionCommandError, state.sessions, openId);
  if (!text) return;
  error.append(text, ' ');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => { sessionCommandError = null; render(); };
  error.append(dismiss);
}

// ponytail: renderGrid() rebuilds every card on every render, and render() runs on
// every SSE snapshot plus a 30s timer. Firing a /status fetch per card per render
// means an active agent (many snapshots/sec) turns N cards into N requests/sec.
// Smallest fix: throttle the whole batch to once per STATUS_THROTTLE_MS, not a
// per-session cache of results — cards are torn down and rebuilt every render
// regardless, so a result cache would need its own invalidation story for no
// real benefit here.
//
// renderDiffPane() shares this same timestamp rather than keeping a second timer:
// renderGrid() only runs while openId is null and renderDiffPane() only while it
// isn't, so the two never race for the throttle window.
let lastStatusFetch = 0;
const STATUS_THROTTLE_MS = 4000;
// Set by openTab() on a fresh switch onto Diff; consumed by the next
// renderDiffPane() to bypass the throttle just this once. See openTab().
let forceDiffFetch = false;

function renderGrid() {
  scrolledFor = null; // Re-opening a card should jump to its latest message again.
  $('#session').hidden = true;
  $('#interrupt').hidden = true;
  const grid = $('#grid');
  grid.hidden = false;
  grid.replaceChildren();

  // A selected session can vanish (deleted, or gone after a restart's reload)
  // without ever passing back through a checkbox handler, so prune here rather
  // than trust the Set to stay in sync with `state` on its own.
  const live = new Set(state.sessions.map((s) => s.id));
  for (const id of selected) if (!live.has(id)) selected.delete(id);
  if (selected.size) grid.append(selectionBar());

  // Pending creates first: they're newer than anything with a real
  // statusSince, and the whole point is that the user should see one
  // appear the instant they close the dialog, not scroll to find it.
  for (const p of pendingCreates) grid.append(pendingCard(p));

  const fetchStatus = Date.now() - lastStatusFetch > STATUS_THROTTLE_MS;
  if (fetchStatus) lastStatusFetch = Date.now();

  const sorted = sortSessions(
    visibleSessions(state.sessions, state.settings.collapseDone),
    state.settings.sort,
  );
  for (const s of sorted) grid.append(card(s, fetchStatus));

  if (!state.sessions.length && !pendingCreates.length) {
    const empty = document.createElement('div');
    empty.id = 'grid-empty';
    const line = document.createElement('p');
    line.textContent = 'No sessions yet.';
    const hint = document.createElement('p');
    hint.textContent = 'Start one with + New in the header.';
    empty.append(line, hint);
    grid.append(empty);
  }
}

/**
 * The toolbar that appears once at least one worktree is checked. Merge and
 * Push both act on the whole selection, and both require it to be a single
 * repo — a "folder" in the sense the feature was asked for — because a merge
 * or push runs once, in one repo's working directory; there is no such thing
 * as merging worktree A's branch into worktree B's unrelated repo. The button
 * disables itself rather than erroring after the click, but /command runs the
 * identical same-repo check server-side (see selectedRepo() in server.ts) —
 * this is a courtesy, not the guard.
 */
function selectionBar() {
  const ids = [...selected];
  const st = selectionState(state.sessions, selected);

  const bar = document.createElement('div');
  bar.id = 'selection-bar';
  bar.onclick = (e) => e.stopPropagation();

  const label = document.createElement('span');
  label.className = 'selection-label';
  label.textContent = st.label;
  bar.append(label);

  const mergeBtn = document.createElement('button');
  mergeBtn.textContent = 'Merge selected';
  mergeBtn.disabled = !st.merge.enabled;
  mergeBtn.title = st.merge.reason;
  mergeBtn.onclick = () => doMerge(ids);

  const pushBtn = document.createElement('button');
  pushBtn.textContent = 'Push';
  pushBtn.disabled = !st.push.enabled;
  pushBtn.title = st.push.reason;
  pushBtn.onclick = () => doPush(ids);

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'ghost';
  clearBtn.onclick = () => { selected.clear(); selectionMessage = ''; render(); };

  bar.append(mergeBtn, pushBtn, clearBtn);

  if (selectionMessage) {
    const msg = document.createElement('p');
    msg.id = 'selection-status';
    msg.textContent = selectionMessage;
    bar.append(msg);
  }
  return bar;
}

async function doMerge(ids) {
  const branches = state.sessions.filter((s) => ids.includes(s.id)).map((s) => s.branch);
  if (!window.confirm(`Commit outstanding changes and merge ${branches.join(', ')} into the repo's checked-out branch?`)) return;
  const result = await postCommand({ cmd: 'merge', ids });
  selectionMessage = result.ok
    ? `Merged ${result.data.merged.join(', ')} into ${result.data.target}.`
    : commandFailure(result);
  if (result.ok) selected.clear();
  render();
}

async function doPush(ids) {
  const result = await postCommand({ cmd: 'push', ids });
  selectionMessage = result.ok
    ? (result.data.output ? `Pushed: ${result.data.output}` : 'Pushed — already up to date.')
    : commandFailure(result);
  render();
}

/** The single contextual control a session's state calls for. */
function actionSlot(s) {
  const act = cardAction(s, queueItems());
  if (act.kind === 'approve') return approval(s);
  if (act.kind === 'stop') return stopButton(s);
  if (act.kind === 'resume') return resumeButton(s);
  if (act.kind === 'waiting') {
    const p = document.createElement('p');
    p.className = 'waiting';
    p.textContent = `⏱ waiting for ${act.account} to reset`;
    return p;
  }
  return null;
}

// The session whose ⋯ menu is open, or null. Same pattern as openId: render()
// reads it, handlers mutate it and re-render.
let menuFor = null;

function menuItem(label, onclick, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = extra;
  b.textContent = label;
  // render() is unconditional here, not left as a side effect of onclick(): Copy
  // worktree path mutates no state and triggers no render of its own, so the
  // stale .menu node was never torn down, and the outside-click closer further
  // down (guarded on `menuFor`, which is already null by then) couldn't help either.
  b.onclick = async (e) => { e.stopPropagation(); menuFor = null; await onclick(); render(); };
  return b;
}

/**
 * Every per-session control that is not the one contextual action. New
 * per-session features go here, so the card face never grows again.
 */
function overflowMenu(s) {
  const wrap = document.createElement('div');
  wrap.className = 'menu-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `menu-btn${menuFor === s.id ? ' open' : ''}`;
  btn.title = 'More';
  btn.textContent = '⋯';
  btn.onclick = (e) => {
    e.stopPropagation();
    menuFor = menuFor === s.id ? null : s.id;
    render();
  };
  wrap.append(btn);
  if (menuFor !== s.id) return wrap;

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.onclick = (e) => e.stopPropagation();

  // Codex sessions never prompt (approvalPolicy 'never'), so the toggle would
  // be a lie there — shown disabled with the reason, not hidden.
  const auto = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = s.auto;
  box.disabled = s.provider === 'codex';
  auto.title = s.provider === 'codex'
    ? 'Codex uses a fixed worktree sandbox with non-interactive permissions.'
    : 'Approve every tool call automatically, without asking';
  box.onchange = async () => {
    menuFor = null;
    await runSessionCommand({ cmd: 'auto', id: s.id, auto: box.checked });
  };
  auto.append(box, ' Auto-approve');

  menu.append(auto);
  // A blocked card's one action slot is spent on Allow/Deny, so Stop has no
  // home on the card face for `needs-you` — without it here, the only way to
  // halt a runaway agent mid-prompt would be to Deny it first or delete the
  // session outright. `working` gets it too, duplicating actionSlot()'s Stop,
  // because the menu is the path that works from every stoppable state.
  if (s.status === 'working' || s.status === 'needs-you') {
    menu.append(menuItem('Stop', async () => { await runSessionCommand({ cmd: 'stop', id: s.id }); }));
  }
  menu.append(
    menuItem('Graph', () => openTab(s.id, 'graph')),
    menuItem('Copy worktree path', () => navigator.clipboard?.writeText(s.cwd)),
    menuItem('Delete…', () => confirmDelete(s), 'danger'),
  );
  wrap.append(menu);
  return wrap;
}

function confirmDelete(s) {
  const dialog = $('#del');
  $('#del-branch').textContent = s.branch;
  $('#del-wt').checked = false;
  setDelHint(false);
  dialog.returnValue = '';
  dialog.dataset.id = s.id;
  dialog.showModal();
}

const DEL_HINT = {
  false: 'Without the checkbox, the worktree is left on disk untouched — only Switchboard forgets the session.',
  true: 'Uncommitted changes in this worktree will be lost.',
};

function setDelHint(removeWorktree) {
  $('#del-hint').textContent = DEL_HINT[removeWorktree];
}

// Registered once at module level, not inside confirmDelete() (which runs per
// open): the checkbox element itself never changes, only its checked state.
$('#del-wt').addEventListener('change', (e) => setDelHint(e.target.checked));

$('#del').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Consumed for the same reason the create dialog consumes it: Escape closes
  // without setting returnValue, so a stale 'delete' would make the next
  // Escape destroy a worktree.
  const go = dialog.returnValue === 'delete';
  dialog.returnValue = '';
  // Unconditional, regardless of go: this dialog only ever opens from the ⋯
  // menu's Delete… item, behind which a stale .menu node can otherwise be left
  // rendered until an unrelated render (next SSE snapshot or the 30s timer)
  // happens to clean it up. Cheap enough to run on every close rather than
  // trust that whatever opened the dialog already re-rendered.
  render();
  if (!go) return;
  await runSessionCommand({ cmd: 'delete', id: dialog.dataset.id, removeWorktree: $('#del-wt').checked });
});

// Any click that is not on a menu closes the open one. Registered once, in the
// capture phase so a card's own onclick (which opens the chat) does not fire
// first and navigate away while a menu is open.
document.addEventListener('click', (e) => {
  if (menuFor && !e.target.closest('.menu-wrap')) { menuFor = null; render(); }
}, true);

// A stand-in for the real card while `git worktree add` + launch are still
// running server-side (see the 'close' handler on #new). Deliberately a
// simplified subset of card(): no checkbox, no overflow menu, no click — none
// of those actions make sense on a session that doesn't exist yet, and this
// card is gone within a render or two once the real one lands.
function pendingCard(p) {
  const el = document.createElement('div');
  el.className = 'card pending';

  const status = document.createElement('div');
  status.className = 'status pending';
  status.textContent = 'creating…';

  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(status);

  // p.branch/p.repo/p.account are straight from the create form, same as a
  // real session's fields — untrusted text only, same as card() below.
  const branch = document.createElement('div');
  branch.className = 'branch';
  branch.textContent = p.branch;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${p.repo.split('/').filter(Boolean).pop() ?? p.repo} · ${p.account}`;

  el.append(head, branch, meta);
  return el;
}

function card(s, fetchStatus) {
  const el = document.createElement('div');
  el.className = `card ${s.status}`;
  el.dataset.id = s.id;

  const select = document.createElement('label');
  select.className = 'select';
  select.onclick = (e) => e.stopPropagation();
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(s.id);
  checkbox.onchange = () => {
    if (checkbox.checked) selected.add(s.id); else selected.delete(s.id);
    selectionMessage = '';
    render();
  };
  select.append(checkbox);

  // s.branch is whatever the user typed into the create form and reaches the
  // session essentially unsanitized, so it is untrusted text — textContent only.
  const status = document.createElement('div');
  status.className = `status ${s.status}`;
  status.textContent = `${s.status} · ${elapsed(s.statusSince)}`;

  const head = document.createElement('div');
  head.className = 'card-head';
  head.append(select, status, overflowMenu(s));

  const branch = document.createElement('div');
  branch.className = 'branch';
  branch.textContent = s.branch;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${s.repo.split('/').filter(Boolean).pop() ?? s.repo} · ${s.account}`;

  const wt = document.createElement('div');
  wt.className = 'wt';

  el.append(head, branch, meta, wt);
  if (s.status === 'stopped' && s.provider === 'codex') {
    const failure = document.createElement('p');
    failure.className = 'stopped-detail';
    failure.textContent = stoppedLabel(s);
    if (s.stoppedCode && s.stoppedReason) {
      const reason = document.createElement('span');
      reason.textContent = ` — ${s.stoppedReason}`;
      failure.append(reason);
    }
    el.append(failure);
  }
  el.onclick = () => openTab(s.id, 'chat');

  // renderGrid() replaceChildren()s the whole grid on every render, so this
  // node is very likely detached by the time the fetch resolves. Look the card
  // up fresh by id at write time and skip silently if it is gone.
  if (fetchStatus) {
    fetch(`/status?id=${s.id}`).then((r) => r.json()).then((data) => {
      if (!data) return;
      const live = document.querySelector(`.card[data-id="${s.id}"] > .wt`);
      if (live) live.textContent = `+${data.added} −${data.removed} · ${data.dirty ? 'dirty' : 'clean'}`;
    }).catch(() => {});
  }

  const slot = actionSlot(s);
  if (slot) el.append(slot);
  return el;
}

function stopButton(s) {
  const b = document.createElement('button');
  b.textContent = 'Stop';
  // Stopping is not destructive — no confirm. The card stays, with a Resume button.
  b.onclick = async (e) => { e.stopPropagation(); await runSessionCommand({ cmd: 'stop', id: s.id }); };
  return b;
}

/**
 * Buttons that resolve a pending request: one per option when the agent asked a
 * question, Allow/Deny otherwise. Shared by the interrupt bar and the session
 * card so the two never drift. Skip denies the question the ordinary way — the
 * agent then re-asks in prose and the composer takes over, which is the only
 * escape hatch while a blocked turn is holding the input queue.
 * Option labels come from the agent, so they stay textContent like every other
 * summary here.
 */
function decideButtons(id, pending, compact = false) {
  return decideSpecs(pending).map(({ label, description, command }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    // The interrupt strip is a one-line nudge about a session you are not
    // reading, so its captions stay in the tooltip; the card is where a choice
    // is actually weighed, so there they are on the button.
    if (description && compact) b.title = description;
    if (description && !compact) {
      const caption = document.createElement('small');
      caption.className = 'opt-desc';
      caption.textContent = description;
      b.append(caption);
    }
    b.onclick = async (e) => {
      e.stopPropagation();
      await runSessionCommand({ cmd: 'decide', id, ...command });
    };
    return b;
  });
}

/**
 * The only cross-session element in the session view: another session blocking
 * on an approval while you are reading this one. Answerable in place, because
 * walking back to the grid to click Allow is the whole friction this removes.
 */
function renderInterrupt(current) {
  const blocked = state.sessions
    .filter((s) => s.id !== current.id && s.pending)
    .sort((a, b) => a.statusSince - b.statusSince);
  const box = $('#interrupt');
  box.hidden = !blocked.length;
  if (!blocked.length) return;

  const [first, ...rest] = blocked;
  box.replaceChildren();

  // Branch name and tool summary are both untrusted — the summary is chosen by
  // the agent, transitively by whatever it read while working.
  const line = document.createElement('span');
  line.textContent = `${first.branch} needs you — ${first.pending.tool}: ${first.pending.summary}`;
  box.append(line);

  box.append(...decideButtons(first.id, first.pending, true));

  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open';
  open.onclick = () => openTab(first.id, 'chat');
  box.append(open);

  if (rest.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.textContent = `+${rest.length} more`;
    more.onclick = () => { openId = null; render(); };
    box.append(more);
  }
}

function approval(s) {
  const box = document.createElement('div');
  box.className = 'approval';

  // s.pending.tool/summary are chosen by the agent (and, transitively, by
  // whatever the agent read while working — repo files, tool output), so they
  // are not ours to trust with innerHTML either.
  const line = document.createElement('div');
  line.className = 'wt';
  line.textContent = `${s.pending.tool}: ${s.pending.summary}`;
  box.append(line);

  box.append(...decideButtons(s.id, s.pending));
  return box;
}

function resumeButton(s) {
  const b = document.createElement('button');
  b.textContent = `Resume (${stoppedLabel(s)})`;
  b.onclick = async (e) => { e.stopPropagation(); await runSessionCommand({ cmd: 'resume', id: s.id }); };
  return b;
}

// Which facet of the open session is showing. Resets to 'chat' on open — you
// open a session to read what it said, not to land on the tab you last used
// somewhere else.
let tab = 'chat';

function openTab(id, which) {
  // A genuine switch onto Diff (new session, or arriving from another tab) must
  // show fresh data immediately rather than wait out the throttle below — this
  // is the one case where the pane would otherwise sit empty for up to
  // STATUS_THROTTLE_MS with nothing on screen yet.
  if (which === 'diff' && (id !== openId || tab !== 'diff')) forceDiffFetch = true;
  openId = id;
  tab = which;
  if (which === 'graph') { graphCommits = []; loadGraph(); }
  render();
}

const TABS = [['chat', 'Chat'], ['diff', 'Diff'], ['graph', 'Graph']];

function renderSession() {
  const s = state.sessions.find((x) => x.id === openId);
  if (!s) { openId = null; return renderGrid(); }
  $('#grid').hidden = true;
  $('#session').hidden = false;
  $('#session-title').textContent = `${s.branch} · ${s.account} · ${s.status === 'stopped' && s.provider === 'codex' ? stoppedLabel(s) : s.status}`;
  const stoppedReason = $('#session-stopped-reason');
  stoppedReason.hidden = !(s.status === 'stopped' && s.provider === 'codex' && s.stoppedCode && s.stoppedReason);
  stoppedReason.textContent = stoppedReason.hidden ? '' : s.stoppedReason;
  $('#session-menu').replaceChildren(overflowMenu(s));

  const slot = actionSlot(s);
  $('#session-action').replaceChildren(...(slot ? [slot] : []));
  renderInterrupt(s);

  $('#tabs').replaceChildren(...TABS.map(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = label;
    b.setAttribute('aria-selected', String(tab === key));
    b.onclick = () => openTab(s.id, key);
    return b;
  }));

  for (const [key] of TABS) $(`#pane-${key}`).hidden = tab !== key;

  if (tab === 'chat') renderChatPane(s);
  if (tab === 'diff') renderDiffPane(s);
  if (tab === 'graph') renderGraphPane(s);
}

function renderChatPane(s) {
  // Measured before the rebuild, because replaceChildren() changes the height:
  // render() runs on every SSE snapshot, i.e. per SDK message, and scrolling
  // unconditionally yanked the view out from under anyone reading scrollback.
  // The first render after opening a session always scrolls — that one is the
  // user asking to see the latest, not reading back.
  const firstOpen = scrolledFor !== openId;
  // Only cleared on an actual session switch: this re-runs on every snapshot
  // and on the 30s timer, and an unconditional clear erased upload errors
  // before they could be read.
  if (firstOpen) $('#upload-error').textContent = '';
  scrolledFor = openId;
  const nearBottom = firstOpen
    || window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120;

  const t = $('#transcript');
  t.replaceChildren();
  for (const m of s.transcript) {
    const el = document.createElement('div');
    // The status class doubles as the styling hook: a tool message with status
    // 'error' picks up the existing .msg.error colour.
    el.className = m.kind === 'tool' ? `msg tool ${m.status}` : `msg ${m.kind}`;
    // A denied `rm -rf` and a successful one used to be pixel-identical.
    if (m.kind === 'tool') {
      el.textContent = `${m.name}: ${m.summary}${m.status === 'running' ? '' : ` · ${m.status}`}`;
    } else {
      el.textContent = m.text;
      if (m.kind === 'user' && m.id) el.dataset.promptId = m.id;
      if (m.kind === 'user' && (m.delivery === 'queued' || m.delivery === 'unsent')) {
        const delivery = document.createElement('span');
        delivery.className = `prompt-delivery ${m.delivery}`;
        delivery.textContent = m.delivery === 'queued' ? 'Queued' : 'Not sent';
        el.append(' ', delivery);
      }
    }
    t.append(el);
  }
  // Scroll the whole pane — not #transcript — to the viewport bottom. The
  // composer is in normal flow *below* the transcript, so aligning the
  // transcript's end with the bottom edge pushed the input box off-screen, and
  // it re-fired on every snapshot because the leftover scroll (composer height)
  // stayed inside the nearBottom threshold. The pane's end is the composer, or
  // #upload-error when it has text (it's display:none when empty), so an upload
  // error lands on-screen too instead of one line below the fold.
  if (nearBottom) $('#pane-chat').scrollIntoView({ block: 'end' });
}

// The named slot for the diff spec. /status returns only the totals today, so
// that is what this shows — a real file-by-file diff needs a server route and
// is spec'd separately.
function renderDiffPane(s) {
  const due = forceDiffFetch || Date.now() - lastStatusFetch > STATUS_THROTTLE_MS;
  forceDiffFetch = false;
  if (!due) return;
  lastStatusFetch = Date.now();
  const pane = $('#pane-diff');
  fetch(`/status?id=${s.id}`).then((r) => r.json()).then((d) => {
    if (openId !== s.id || tab !== 'diff') return;
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = d
      ? `${d.branch} · +${d.added} −${d.removed} · ${d.dirty ? 'uncommitted changes' : 'clean'}`
      : 'No worktree status available.';
    const note = document.createElement('p');
    note.className = 'meta';
    note.textContent = 'File-by-file diff is not implemented yet.';
    pane.replaceChildren(p, note);
  }).catch(() => {});
}

function renderGraphPane(s) {
  const rows = $('#graph-rows');
  if (!graphCommits.length) {
    rows.replaceChildren(Object.assign(document.createElement('p'), {
      id: 'graph-empty', textContent: 'No commits yet.',
    }));
    $('#graph-svg').replaceChildren();
    return;
  }
  const width = drawGraph(graphCommits);
  rows.replaceChildren(...graphCommits.map((c) => {
    const row = document.createElement('div');
    row.className = 'commit';
    row.style.marginLeft = `${width + 14}px`;
    const hash = document.createElement('span');
    hash.className = 'hash';
    hash.textContent = c.h.slice(0, 7);
    row.append(hash);
    for (const r of c.refs) row.append(refPill(r, c.lane));
    const subject = document.createElement('span');
    subject.className = 'subject';
    subject.textContent = c.subject;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${c.author} · ${c.when}`;
    row.append(subject, when);
    return row;
  }));
}

// ---- Commit graph -------------------------------------------------------
const ROW = 34, LANE = 24, PAD = 14, DOT = 5;
const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

function drawGraph(commits) {
  const at = new Map(commits.map((c) => [c.h, c]));
  const svg = $('#graph-svg');
  const width = PAD * 2 + Math.max(0, ...commits.map((c) => c.lane)) * LANE;
  svg.setAttribute('width', width);
  svg.setAttribute('height', commits.length * ROW);
  svg.replaceChildren();
  const x = (c) => PAD + c.lane * LANE;
  const y = (c) => ROW / 2 + c.row * ROW;

  for (const c of commits) {
    for (const [i, ph] of c.p.entries()) {
      const p = at.get(ph);
      // Parent outside the fetched window: its line simply ends at the bottom.
      if (!p) continue;
      const [x1, y1, x2, y2] = [x(c), y(c), x(p), y(p)];
      // The line holds its own lane and only swings across near the parent, so a
      // merge reads as an interchange instead of a diagonal cutting the map.
      const bend = Math.max(y1, y2 - ROW);
      const d = x1 === x2
        ? `M${x1},${y1}V${y2}`
        : `M${x1},${y1}V${bend}C${x1},${y2} ${x2},${bend} ${x2},${y2}`;
      // A merge's second parent is drawn in the parent's colour, not the child's:
      // that line belongs to the branch being merged in.
      svg.append(svgEl('path', { d, class: `lane${(i ? p.lane : c.lane) % 6}` }));
    }
  }
  for (const c of commits) {
    const head = c.refs.some((r) => r.startsWith('HEAD'));
    svg.append(svgEl('circle', {
      cx: x(c), cy: y(c), r: head ? DOT + 1.5 : DOT,
      class: `lane${c.lane % 6}${c.p.length > 1 ? ' merge' : ''}${head ? ' head' : ''}`,
    }));
  }
  return width;
}

function refPill(raw, lane) {
  const tag = raw.startsWith('tag: ');
  const name = raw.replace(/^tag: /, '').replace(/^HEAD -> /, '');
  const pill = document.createElement('span');
  pill.className = `ref lane${lane % 6}${tag ? ' tag' : ''}`
    + (!tag && name.includes('/') ? ' remote' : '') + (raw.startsWith('HEAD') ? ' head' : '');
  // Branch and tag names come from the repo, so they go in as text, never markup.
  const label = document.createElement('span');
  label.textContent = name;
  pill.append(label);
  return pill;
}

async function loadGraph() {
  if (!openId || tab !== 'graph') return;
  const id = openId;
  const commits = await fetch(`/graph?id=${id}`).then((r) => r.json()).catch(() => null);
  // The view can close or switch sessions while this is in flight; dropping a
  // stale response keeps one session's commits from landing under another's.
  if (!commits || openId !== id || tab !== 'graph') return;
  graphCommits = commits;
  renderSession();
}
// The 2s interval stays, but the guard above makes it a no-op unless the
// Graph tab is showing — before this task it polled whether or not the view
// was even open.
setInterval(loadGraph, 2000);

$('#back').onclick = () => { openId = null; render(); };
$('#new-btn').onclick = openNew;
$('#queue-badge').onclick = () => setPanel('queue');

// Escape closes the panel. Registered on document rather than on the panel so
// it works with focus anywhere; dialogs handle their own Escape natively and
// stopPropagation is not needed, since a dialog's Escape never reaches here as
// a keydown on document while the dialog is modal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel) { panel = null; render(); }
  else if (e.key === 'Escape' && menuFor) { menuFor = null; render(); }
});

// The datetime input is only meaningful for the "at" choice; `required` is set
// with it so an empty value can't be submitted, and cleared with it so the
// other two choices don't trip the form's own validation. Returns `sync` so a
// caller that resets the form afterward (openNew(), the schedule button below)
// can re-run it: form.reset() puts the select back to its default option
// without firing 'change', so without a manual re-sync the datetime field's
// hidden/required state is left matching whatever was selected before the reset.
function bindWhen(selectSel, inputSel) {
  const sel = $(selectSel);
  const at = $(inputSel);
  const sync = () => {
    at.hidden = sel.value !== 'at';
    at.required = sel.value === 'at';
  };
  sel.onchange = sync;
  sync();
  return sync;
}
const syncWhen = bindWhen('#when-select', '#when-at');
const syncWhen2 = bindWhen('#when2-select', '#when2-at');

// The server derives a reset trigger's account from the action, so the client
// never sends one. An invalid or empty datetime yields NaN, which the server
// rejects with a message the dialog already knows how to show.
function triggerFor(when, at) {
  return when === 'reset'
    ? { kind: 'reset' }
    : { kind: 'at', time: new Date(at).getTime() };
}

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  const result = await runSessionCommand({ cmd: 'send', id: openId, text });
  if (result.ok) $('#prompt').value = '';
};

$('#schedule-btn').onclick = () => {
  const text = $('#prompt').value.trim();
  if (!text) return;
  const dialog = $('#when-dialog');
  // Same reason as openNew(): without this, a dialog reopened after an earlier
  // "When usage resets" pick still shows that choice (and the datetime field
  // stays hidden to match) for an unrelated later message.
  dialog.querySelector('form').reset();
  syncWhen2();
  $('#when-error').textContent = '';
  dialog.showModal();
};

$('#when-dialog').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Same returnValue discipline as the #new dialog: Escape closes without
  // setting one, and an unconsumed 'ok' would re-fire on the next Escape.
  const ok = dialog.returnValue === 'ok';
  dialog.returnValue = '';
  if (!ok || !openId) return;

  const text = $('#prompt').value.trim();
  if (!text) return;
  // Always schedule a `send`, even for a session that is stopped right now: the
  // headline use of this feature is "send this tonight" against a session
  // that's live at schedule time but very likely won't be by fire time (a
  // server restart marks every session `stopped`). Only the server, at fire
  // time, knows which is true — see the downgrade to `resume` in tick() in
  // src/server.ts — so the client no longer guesses here.
  const action = { kind: 'send', sessionId: openId, text };

  const f = new FormData(dialog.querySelector('form'));
  const result = await postCommand({
    cmd: 'schedule', trigger: triggerFor(f.get('when'), f.get('at')), action,
  });
  if (result.ok) { $('#prompt').value = ''; render(); return; }
  // Same pattern as #new: show the server's reason and let the user retry,
  // rather than the fire-and-forget silence most other buttons in this app get.
  // This one is a modal the user explicitly confirmed to queue something —
  // going quiet on failure means they believe it's queued when it isn't.
  $('#when-error').textContent = commandFailure(result);
  dialog.showModal();
});

// Uploads go straight to disk in the session's worktree and come back as a
// relative path, which is appended to the prompt box. The agent then opens it
// like any other file in the repo — no adapter or transcript change needed.
async function upload(files) {
  if (!openId || !files.length) return;
  $('#upload-error').textContent = '';
  for (const file of files) {
    let path;
    try {
      const res = await fetch(`/upload?id=${openId}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.status);
      ({ path } = await res.json());
    } catch (err) {
      // Surfaced, not swallowed: a silently dropped upload turns into the user
      // sending a path that does not exist and the agent reporting confusion.
      $('#upload-error').textContent = `could not attach ${file.name}: ${err.message}`;
      return;
    }
    const box = $('#prompt');
    box.value = box.value ? `${box.value} ${path}` : path;
  }
  $('#prompt').focus();
}

$('#attach input').onchange = (e) => {
  upload(e.target.files);
  // Cleared so picking the same file twice in a row still fires `change`.
  e.target.value = '';
};

// Bound to the chat pane, not the whole session view: a file dropped on the
// commit graph is not an upload.
const chat = $('#pane-chat');
chat.addEventListener('dragover', (e) => {
  e.preventDefault(); // Without this the browser navigates to the dropped file.
  chat.classList.add('dropping');
});
chat.addEventListener('dragleave', (e) => {
  // Dragleave fires when crossing child element boundaries, so check that the
  // pointer actually left the chat container entirely (relatedTarget is outside).
  if (!chat.contains(e.relatedTarget)) chat.classList.remove('dropping');
});
chat.addEventListener('drop', (e) => {
  e.preventDefault();
  chat.classList.remove('dropping');
  upload(e.dataTransfer.files);
});

// A styled combobox standing in for the native <datalist>, which is an OS widget:
// unstylable, and it clipped long absolute paths to the input's width. Rows show the
// repo name (what identifies it) above the full path (context), so the useful half is
// never the half that gets truncated.
const repoCombo = (() => {
  const input = $('#repo-input');
  const list = $('#repo-list');
  let all = [];
  let active = -1;

  const rows = () => [...list.querySelectorAll('li')];

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  /** Paths come from disk, so build with textContent — never innerHTML. */
  function withMatch(text, q) {
    const frag = document.createDocumentFragment();
    const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (at < 0) { frag.append(text); return frag; }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + q.length);
    frag.append(text.slice(0, at), mark, text.slice(at + q.length));
    return frag;
  }

  function setActive(i) {
    const items = rows();
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((li, n) => li.setAttribute('aria-selected', String(n === active)));
    const li = items[active];
    input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  }

  function open(q = '') {
    const matches = all.filter((p) => p.toLowerCase().includes(q.toLowerCase()));
    list.replaceChildren();

    if (!all.length || !matches.length) {
      const p = document.createElement('p');
      p.className = 'combo-empty';
      p.textContent = all.length
        ? 'No recent repo matches. Type a full path.'
        : 'No recent repos found. Type a full path.';
      list.append(p);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
      return;
    }

    matches.forEach((path, n) => {
      const li = document.createElement('li');
      li.id = `repo-opt-${n}`;
      li.role = 'option';
      li.setAttribute('aria-selected', 'false');

      const name = document.createElement('span');
      name.className = 'repo-name';
      name.append(withMatch(path.split('/').filter(Boolean).pop() ?? path, q));

      const full = document.createElement('span');
      full.className = 'repo-path';
      full.append(withMatch(path, q));

      li.append(name, full);
      // mousedown, not click: click fires after blur would have closed the list.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(path); });
      list.append(li);
    });

    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  function choose(path) {
    input.value = path;
    close();
    input.focus();
  }

  input.addEventListener('input', () => open(input.value));
  input.addEventListener('focus', () => open(input.value));
  input.addEventListener('blur', close);

  input.addEventListener('keydown', (e) => {
    const isOpen = !list.hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); isOpen ? setActive(active + 1) : open(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen) setActive(active - 1); }
    else if (e.key === 'Enter' && isOpen && active >= 0) {
      // Selecting from the list must not also submit the form.
      e.preventDefault();
      choose(rows()[active].querySelector('.repo-path').textContent);
    } else if (e.key === 'Escape' && isOpen) {
      // Close the list, not the dialog.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  return { setOptions(list_) { all = list_; close(); } };
})();

function openSettings() {
  const dialog = $('#settings');
  const form = dialog.querySelector('form');
  const s = state.settings;

  form.autoApprove.checked = s.autoApprove;
  form.branchPrefix.value = s.branchPrefix;
  form.sort.value = s.sort;
  form.collapseDone.checked = s.collapseDone;
  form.autoRequeue.checked = s.autoRequeue;
  for (const box of form.querySelectorAll('input[name=notifyOn]')) {
    box.checked = s.notifyOn.includes(box.value);
  }

  // Rebuilt on every open: accounts.json can change under a running server.
  // The "freest" option is what `account: null` means.
  const sel = form.account;
  const freest = document.createElement('option');
  freest.value = '';
  freest.textContent = 'Freest account';
  freest.selected = s.account === null;
  sel.replaceChildren(freest, ...state.accounts.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.selected = a.name === s.account;
    return o;
  }));

  $('#settings-error').textContent = '';
  dialog.showModal();
}

$('#settings-btn').onclick = openSettings;

$('#settings').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Same returnValue discipline as #new: Escape closes without setting one, so
  // an unconsumed 'save' would make the next Escape re-POST the form.
  const save = dialog.returnValue === 'save';
  dialog.returnValue = '';
  if (!save) return;

  const form = dialog.querySelector('form');
  const patch = {
    autoApprove: form.autoApprove.checked,
    account: form.account.value || null,
    branchPrefix: form.branchPrefix.value,
    notifyOn: [...form.querySelectorAll('input[name=notifyOn]:checked')].map((b) => b.value),
    sort: form.sort.value,
    collapseDone: form.collapseDone.checked,
    autoRequeue: form.autoRequeue.checked,
  };

  const result = await postCommand({ cmd: 'settings', patch });
  if (!result.ok) {
    // Same as #new's retry path: show the server's reason and reopen with the
    // user's input intact rather than dropping it into a toast.
    $('#settings-error').textContent = commandFailure(result);
    dialog.showModal();
  }
});

async function openNew() {
  // reset() before the option lists are rebuilt below, so it can't clobber them:
  // a re-opened dialog otherwise still holds the previous session's repo, branch
  // and prompt. (returnValue is cleared by the close handler, which is the only
  // place it is ever set — see there.)
  const dialog = $('#new');
  dialog.querySelector('form').reset();
  syncWhen();

  // reset() has just cleared the branch field, so the prefix goes in after it.
  $('#branch-input').value = state.settings.branchPrefix;

  repoCombo.setOptions(await fetch('/repos').then((r) => r.json()));

  const sel = document.querySelector('select[name=account]');
  // A pinned account that is no longer in accounts.json falls back to freest,
  // rather than leaving the picker on a name that cannot be created against.
  const pinned = state.accounts.find((a) => a.name === state.settings.account);
  const preselect = pinned ?? freestAccount(state.accounts);
  sel.replaceChildren(...state.accounts.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.selected = a.name === preselect?.name;
    return o;
  }));

  $('#new-error').textContent = '';
  dialog.showModal();
}

$('#new').addEventListener('close', async (e) => {
  const dialog = e.target;
  // Consume returnValue: a close request (Escape) closes a dialog *without*
  // setting one, so an unconsumed 'create' made the next Escape re-POST the still
  // populated form — an unintended worktree and a paid agent launch from a
  // keypress that means "cancel". Cleared here rather than only in openNew()
  // because the error-retry path below re-opens the dialog without going through
  // openNew(), and would keep the stale 'create' otherwise.
  const create = dialog.returnValue === 'create';
  dialog.returnValue = '';
  if (!create) return;
  const f = new FormData(dialog.querySelector('form'));
  const repo = f.get('repo'), branch = f.get('branch'), account = f.get('account');
  const action = { kind: 'create', repo, branch, account, prompt: f.get('prompt') };
  const when = f.get('when');

  // Only a create happening *now* gets a pending card. A scheduled one creates
  // nothing yet — it lands in the queue strip, and a card that says "creating…"
  // for something due tomorrow would be a lie.
  const pending = when === 'now' ? { repo, branch, account } : null;
  if (pending) {
    // Shown in the grid immediately — see pendingCreates' declaration for why
    // this can't just wait for the next SSE snapshot.
    pendingCreates.push(pending);
    render();
  }

  const result = await postCommand(when === 'now'
    ? { cmd: 'create', ...action }
    : { cmd: 'schedule', trigger: triggerFor(when, f.get('at')), action });
  if (pending) pendingCreates = pendingCreates.filter((p) => p !== pending);
  if (!result.ok) {
    $('#new-error').textContent = commandFailure(result);
    dialog.showModal();
  }
  render();
});

// Chrome and Safari largely ignore (or silently fall back to a "quiet",
// easy-to-miss UI for) a requestPermission() call that isn't the direct result
// of a user click — a call fired from page load routinely shows the user
// nothing, and they're never notified with no way to tell why. A persistent
// banner tied to a real button click is the reliable way to get the actual
// native prompt, and it also surfaces the 'denied' case up front, which no
// amount of re-requesting can recover from — only the browser's own
// site-settings UI can undo that, so we just point the user at it.
function updateNotifBar() {
  const bar = $('#notif-bar');
  if (!('Notification' in window)) { bar.hidden = true; return; }
  const btn = $('#notif-btn');
  if (Notification.permission === 'granted') { bar.hidden = true; return; }
  bar.hidden = false;
  if (Notification.permission === 'denied') {
    $('#notif-msg').textContent =
      "Notifications are blocked for this page — enable them in your browser's site settings to hear about sessions that need you.";
    btn.hidden = true;
  } else {
    $('#notif-msg').textContent =
      "Turn on notifications so you know when a session needs you, even when this tab isn't in front.";
    btn.hidden = false;
  }
}
$('#notif-btn').onclick = async () => {
  await Notification.requestPermission();
  updateNotifBar();
};
updateNotifBar();
setInterval(render, 30_000); // keeps the elapsed times honest
