const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };
let state = { sessions: [], accounts: [] };
let openId = null;
let seenNeedsYou = new Set();
// Session whose chat view has already been auto-scrolled once; see renderChat().
let scrolledFor = null;

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
  scrolledFor = null; // Re-opening a card should jump to its latest message again.
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
  // Only where there is something to stop: a `done` session has finished its turn
  // and a `stopped` one is already terminal, so Stop on either is a no-op button.
  // Without this, Delete was the only way to halt a runaway write-capable agent.
  if (s.status === 'working' || s.status === 'needs-you') el.append(stopButton(s));
  el.append(deleteControl(s));
  return el;
}

function stopButton(s) {
  const b = document.createElement('button');
  b.textContent = 'Stop';
  // Stopping is not destructive — no confirm. The card stays, with a Resume button.
  b.onclick = (e) => { e.stopPropagation(); send({ cmd: 'stop', id: s.id }); };
  return b;
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

  // Measured before the rebuild, because replaceChildren() changes the height:
  // render() runs on every SSE snapshot, i.e. per SDK message, and scrolling
  // unconditionally yanked the view out from under anyone reading scrollback.
  // The first render after opening a card always scrolls — that one is the user
  // asking to see the latest, not reading back.
  const firstOpen = scrolledFor !== openId;
  // Clear any upload error from a previous session, but only on an actual
  // session switch: renderChat() re-runs on every SSE snapshot and on a 30s
  // interval while the agent works, so an unconditional clear here erased the
  // error before the user had a chance to read it.
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
    el.textContent = m.kind === 'tool'
      // A denied `rm -rf` and a successful one used to be pixel-identical.
      ? `${m.name}: ${m.summary}${m.status === 'running' ? '' : ` · ${m.status}`}`
      : m.text;
    t.append(el);
  }
  if (s.pending) t.append(approval(s));
  if (nearBottom) t.scrollIntoView({ block: 'end' });
}

$('#back').onclick = () => { openId = null; render(); };

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  $('#prompt').value = '';
  send({ cmd: 'send', id: openId, text });
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

const chat = $('#chat');
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
  const freest = [...state.accounts].sort((a, b) => a.pace - b.pace)[0];
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
