import {
  sortSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel,
  postCommand, commandFailure, retainedSessionError, commandErrorText, CODEX_FAILURE_LABEL,
  accountView,
} from './lib.js';

let state = { sessions: [], accounts: [] };
let openId = null;
// Which header panel is open: null, 'queue', or an account name. Mutually
// exclusive by construction — one variable, not one flag per panel.
let panel = null;
let seenNeedsYou = new Set();
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
es.onmessage = (e) => {
  $('#conn').hidden = true;
  state = JSON.parse(e.data);
  notify();
  render();
};
// EventSource reconnects on its own; this only makes the gap visible.
es.onerror = () => { $('#conn').hidden = false; };

function notify() {
  const needs = state.sessions.filter((s) => s.status === 'needs-you');
  document.title = needs.length ? `(${needs.length}) Switchboard` : 'Switchboard';
  if (document.hasFocus() || Notification.permission !== 'granted') return;
  for (const s of needs) {
    if (seenNeedsYou.has(s.id)) continue;
    seenNeedsYou.add(s.id);
    new Notification(`${s.branch} needs you`, { body: s.pending?.summary ?? '' });
  }
  seenNeedsYou = new Set(needs.map((s) => s.id));
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

  const fetchStatus = Date.now() - lastStatusFetch > STATUS_THROTTLE_MS;
  if (fetchStatus) lastStatusFetch = Date.now();

  const sorted = sortSessions(state.sessions);
  for (const s of sorted) grid.append(card(s, fetchStatus));

  if (!state.sessions.length) {
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

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  const result = await runSessionCommand({ cmd: 'send', id: openId, text });
  if (result.ok) $('#prompt').value = '';
};

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

async function openNew() {
  // reset() before the option lists are rebuilt below, so it can't clobber them:
  // a re-opened dialog otherwise still holds the previous session's repo, branch
  // and prompt. (returnValue is cleared by the close handler, which is the only
  // place it is ever set — see there.)
  const dialog = $('#new');
  dialog.querySelector('form').reset();

  repoCombo.setOptions(await fetch('/repos').then((r) => r.json()));

  const sel = document.querySelector('select[name=account]');
  // `load` is the server's one ranking number — real plan utilization where we
  // have it, the local estimate otherwise. Sorting on `pace` here would default
  // the dialog to a different account than the meters imply is freest.
  const freest = [...state.accounts].sort((a, b) => a.load - b.load)[0];
  sel.replaceChildren(...state.accounts.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.selected = a.name === freest?.name;
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
  const result = await postCommand({
    cmd: 'create',
    repo: f.get('repo'), branch: f.get('branch'),
    account: f.get('account'), prompt: f.get('prompt'),
  });
  if (!result.ok) {
    $('#new-error').textContent = commandFailure(result);
    dialog.showModal();
  }
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
