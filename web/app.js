const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };
let state = { sessions: [], accounts: [] };
let openId = null;
let seenNeedsYou = new Set();

const $ = (sel) => document.querySelector(sel);

async function send(body) {
  const res = await fetch('/command', { method: 'POST', body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}

// EventSource reconnects on its own, so there is no backoff code to write.
const es = new EventSource('/events');
es.onmessage = (e) => {
  state = JSON.parse(e.data);
  notify();
  render();
};

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

function render() {
  openId ? renderChat() : renderGrid();
}

// ponytail: renderGrid() rebuilds every card on every render, and render() runs on
// every SSE snapshot plus a 30s timer. Firing a /status fetch per card per render
// means an active agent (many snapshots/sec) turns N cards into N requests/sec.
// Smallest fix: throttle the whole batch to once per STATUS_THROTTLE_MS, not a
// per-session cache of results — cards are torn down and rebuilt every render
// regardless, so a result cache would need its own invalidation story for no
// real benefit here.
let lastStatusFetch = 0;
const STATUS_THROTTLE_MS = 4000;

function renderGrid() {
  $('#chat').hidden = true;
  const grid = $('#grid');
  grid.hidden = false;
  grid.replaceChildren();

  const accounts = document.createElement('div');
  accounts.className = 'accounts';
  for (const a of state.accounts) {
    const pct = Math.round(a.pace * 100);
    const el = document.createElement('div');
    el.className = 'card';

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = a.name;

    const bar = document.createElement('div');
    bar.className = `bar ${a.pace > 1 ? 'over' : ''}`;
    const i = document.createElement('i');
    i.style.width = `${Math.min(pct, 100)}%`;
    bar.append(i);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `~${pct}% of 5h budget · estimate`;

    el.append(status, bar, meta);
    accounts.append(el);
  }
  grid.append(accounts);

  const fetchStatus = Date.now() - lastStatusFetch > STATUS_THROTTLE_MS;
  if (fetchStatus) lastStatusFetch = Date.now();

  const sorted = [...state.sessions].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.statusSince - a.statusSince,
  );
  for (const s of sorted) grid.append(card(s, fetchStatus));

  const add = document.createElement('div');
  add.className = 'card';
  add.id = 'new-card';
  add.textContent = '+ new worktree';
  add.onclick = openNew;
  grid.append(add);
}

function card(s, fetchStatus) {
  const el = document.createElement('div');
  el.className = `card ${s.status}`;
  el.dataset.id = s.id;

  // s.branch is whatever the user typed into the create-session form (and it
  // survives into the session basically unsanitized on the server side), so it
  // is untrusted text and must go through textContent, not innerHTML.
  const status = document.createElement('div');
  status.className = `status ${s.status}`;
  status.textContent = `${s.status} · ${elapsed(s.statusSince)}`;

  const branch = document.createElement('div');
  branch.className = 'branch';
  branch.textContent = s.branch;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = s.account;

  const wt = document.createElement('div');
  wt.className = 'wt';

  el.append(status, branch, meta, wt);
  el.onclick = () => { openId = s.id; render(); };

  // renderGrid() replaceChildren()s the whole grid on every render, so the `wt`
  // node captured by this closure is very likely detached by the time the fetch
  // resolves (a fresh SSE snapshot mid-burst rebuilds it before the network
  // round trip finishes). Look the node up fresh by session id at write time —
  // `.card[data-id] > .wt` picks the direct-child stats div, not the unrelated
  // `.wt`-classed line inside an approval box — and skip silently if the card
  // is gone (session deleted or scrolled off in a future render).
  if (fetchStatus) {
    fetch(`/status?id=${s.id}`).then((r) => r.json()).then((data) => {
      if (!data) return;
      const live = document.querySelector(`.card[data-id="${s.id}"] > .wt`);
      if (live) live.textContent = `+${data.added} −${data.removed} · ${data.dirty ? 'dirty' : 'clean'}`;
    }).catch(() => {});
  }

  if (s.pending) el.append(approval(s));
  if (s.status === 'stopped') el.append(resumeButton(s));
  el.append(deleteControl(s));
  return el;
}

function deleteControl(s) {
  const box = document.createElement('div');
  box.className = 'delete';

  const label = document.createElement('label');
  label.onclick = (e) => e.stopPropagation();
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, ' remove worktree');

  const b = document.createElement('button');
  b.textContent = 'Delete';
  b.onclick = (e) => {
    e.stopPropagation();
    const removeWorktree = checkbox.checked;
    const msg = removeWorktree
      ? `Delete "${s.branch}" and remove its git worktree? Uncommitted changes in it will be lost.`
      : `Delete "${s.branch}" from Switchboard? Its git worktree will be left on disk, untouched.`;
    if (!window.confirm(msg)) return;
    send({ cmd: 'delete', id: s.id, removeWorktree });
  };

  box.append(label, b);
  return box;
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

  for (const [label, allow] of [['Allow', true], ['Deny', false]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); send({ cmd: 'decide', id: s.id, allow }); };
    box.append(b);
  }
  return box;
}

function resumeButton(s) {
  const b = document.createElement('button');
  b.textContent = `Resume (${s.stoppedReason ?? 'stopped'})`;
  b.onclick = (e) => { e.stopPropagation(); send({ cmd: 'resume', id: s.id }); };
  return b;
}

function renderChat() {
  const s = state.sessions.find((x) => x.id === openId);
  if (!s) { openId = null; return renderGrid(); }
  $('#grid').hidden = true;
  $('#chat').hidden = false;
  $('#chat-title').textContent = `${s.branch} · ${s.account} · ${s.status}`;

  const t = $('#transcript');
  t.replaceChildren();
  for (const m of s.transcript) {
    const el = document.createElement('div');
    el.className = `msg ${m.kind}`;
    el.textContent = m.kind === 'tool' ? `${m.name}: ${m.summary}` : m.text;
    t.append(el);
  }
  if (s.pending) t.append(approval(s));
  t.scrollIntoView({ block: 'end' });
}

$('#back').onclick = () => { openId = null; render(); };

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  $('#prompt').value = '';
  send({ cmd: 'send', id: openId, text });
};

async function openNew() {
  const repos = await fetch('/repos').then((r) => r.json());
  $('#repos').replaceChildren(...repos.map((r) => {
    const o = document.createElement('option');
    o.value = r;
    return o;
  }));

  const sel = document.querySelector('select[name=account]');
  const freest = [...state.accounts].sort((a, b) => a.pace - b.pace)[0];
  sel.replaceChildren(...state.accounts.map((a) => {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.selected = a.name === freest?.name;
    return o;
  }));

  $('#new-error').textContent = '';
  $('#new').showModal();
}

$('#new').addEventListener('close', async (e) => {
  const dialog = e.target;
  if (dialog.returnValue !== 'create') return;
  const f = new FormData(dialog.querySelector('form'));
  const { ok, data } = await send({
    cmd: 'create',
    repo: f.get('repo'), branch: f.get('branch'),
    account: f.get('account'), prompt: f.get('prompt'),
  });
  if (!ok) {
    $('#new-error').textContent = data.error;
    dialog.showModal();
  }
});

if (Notification.permission === 'default') Notification.requestPermission();
setInterval(render, 30_000); // keeps the elapsed times honest
