import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import {
  sortSessions, visibleSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel, accountView,
  freestAccount, newlyNotifiable,
  groupTranscript, toolRunLabel, commandMenu, commandToken, attributeBranches, branchHues, HUES,
  readTheme, ACCENTS, CANVASES, pastedName, composeMessage,
} from '../web/lib.js';

test('composeMessage appends attachment paths, and stands alone without text', () => {
  assert.equal(composeMessage('look at this', ['uploads/a.png']), 'look at this\nuploads/a.png');
  // An image with no covering text is a message on its own.
  assert.equal(composeMessage('  ', ['uploads/a.png', 'uploads/b.png']), 'uploads/a.png\nuploads/b.png');
  assert.equal(composeMessage('just text', []), 'just text');
  assert.equal(composeMessage('   ', []), '', 'an empty composer stays empty so Send can refuse it');
});

test('pastedName keeps same-millisecond pastes from overwriting each other', () => {
  const names = [0, 1].map((i) => pastedName('image.png', 1700, i));
  assert.deepEqual(names, ['paste-1700-0-image.png', 'paste-1700-1-image.png']);
  assert.equal(pastedName('', 1700, 0), 'paste-1700-0-image.png');
});

const tool = (name, status = 'ok') => ({ kind: 'tool', name, summary: 'x', status });

test('groupTranscript folds a run of tool calls and leaves everything else alone', () => {
  const out = groupTranscript([
    { kind: 'user', text: 'go' },
    tool('Read'), tool('Bash'), tool('Edit'),
    { kind: 'text', text: 'done' },
  ]);
  assert.deepEqual(out.map((g) => g.kind), ['msg', 'tools', 'msg']);
  assert.equal(out[1].at, 1);
  assert.deepEqual(out[1].msgs.map((m) => m.name), ['Read', 'Bash', 'Edit']);
});

test('groupTranscript leaves a lone tool call inline', () => {
  const out = groupTranscript([tool('Read'), { kind: 'text', text: 'hi' }, tool('Bash')]);
  assert.deepEqual(out.map((g) => g.kind), ['msg', 'msg', 'msg']);
});

test('groupTranscript keys each run by its own first index', () => {
  const out = groupTranscript([
    tool('Read'), tool('Bash'),
    { kind: 'text', text: 'thinking' },
    tool('Edit'), tool('Write'),
  ]);
  assert.deepEqual(out.filter((g) => g.kind === 'tools').map((g) => g.at), [0, 3]);
});

test('toolRunLabel names distinct tools and calls out unresolved state', () => {
  assert.equal(toolRunLabel([tool('Read'), tool('Read'), tool('Bash')]), '3 tool calls · Read, Bash');
  assert.equal(
    toolRunLabel([tool('Read'), tool('Bash', 'error'), tool('Edit', 'running')]),
    '3 tool calls · Read, Bash, Edit · 1 failed · running',
  );
  assert.equal(
    toolRunLabel([tool('A'), tool('B'), tool('C'), tool('D')]),
    '4 tool calls · A, B, C…',
  );
});

const session = (over = {}) => ({
  id: 'a', repo: '/r/one', branch: 'feat/a', account: 'claude-main',
  status: 'working', pending: null, statusSince: 1000, ...over,
});

test('sortSessions orders needs-you, working, done, stopped', () => {
  const out = sortSessions([
    session({ id: 'd', status: 'stopped' }),
    session({ id: 'c', status: 'done' }),
    session({ id: 'b', status: 'working' }),
    session({ id: 'a', status: 'needs-you' }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['a', 'b', 'c', 'd']);
});

test('sortSessions breaks ties by most recent statusSince', () => {
  const out = sortSessions([
    session({ id: 'old', statusSince: 100 }),
    session({ id: 'new', statusSince: 900 }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['new', 'old']);
});

test('sortSessions does not mutate its input', () => {
  const input = [session({ id: 'b', status: 'stopped' }), session({ id: 'a', status: 'working' })];
  sortSessions(input);
  assert.deepEqual(input.map((s) => s.id), ['b', 'a']);
});

test('cardAction gives a blocked session the approval box', () => {
  const s = session({ status: 'needs-you', pending: { id: 'p', tool: 'Bash', summary: 'ls' } });
  assert.deepEqual(cardAction(s), { kind: 'approve' });
});

test('decideSpecs gives an ordinary tool an uncaptioned Allow and Deny', () => {
  assert.deepEqual(decideSpecs({ id: 'p', tool: 'Bash', summary: 'ls' }), [
    { label: 'Allow', command: { allow: true } },
    { label: 'Deny', command: { allow: false } },
  ]);
});

test('decideSpecs captions each answer button with the option description', () => {
  const specs = decideSpecs({
    id: 'p',
    tool: 'AskUserQuestion',
    summary: 'TS or Py?',
    options: [
      { label: 'Python', description: 'No build step.' },
      { label: 'TypeScript' },
    ],
  });
  assert.deepEqual(specs.slice(0, 2), [
    { label: 'Python', description: 'No build step.', command: { answer: 'Python' } },
    { label: 'TypeScript', description: undefined, command: { answer: 'TypeScript' } },
  ]);
  assert.deepEqual(specs[2].command, { allow: false });
  assert.equal(specs[2].label, 'Skip');
});

test('cardAction gives a working session Stop', () => {
  assert.deepEqual(cardAction(session({ status: 'working' })), { kind: 'stop' });
});

test('cardAction gives a done session nothing', () => {
  assert.deepEqual(cardAction(session({ status: 'done' })), { kind: 'none' });
});

test('cardAction gives a stopped session Resume when nothing is queued for it', () => {
  assert.deepEqual(cardAction(session({ status: 'stopped' })), { kind: 'resume' });
});

test('cardAction gives a stopped session the waiting state when a reset-resume is queued', () => {
  const queue = [{
    id: 'q1', state: 'waiting',
    trigger: { kind: 'reset', account: 'claude-main' },
    action: { kind: 'resume', sessionId: 'a', prompt: 'go on' },
  }];
  assert.deepEqual(cardAction(session({ status: 'stopped' }), queue),
    { kind: 'waiting', account: 'claude-main' });
});

test('cardAction ignores queue items for other sessions, other kinds, and dead states', () => {
  const s = session({ status: 'stopped' });
  const other = { kind: 'reset', account: 'claude-main' };
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: other, action: { kind: 'resume', sessionId: 'zzz' } }]),
    { kind: 'resume' }, 'other session');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: other, action: { kind: 'send', sessionId: 'a' } }]),
    { kind: 'resume' }, 'not a resume');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'failed', trigger: other, action: { kind: 'resume', sessionId: 'a' } }]),
    { kind: 'resume' }, 'not waiting');
  assert.deepEqual(
    cardAction(s, [{ id: 'q', state: 'waiting', trigger: { kind: 'at', time: 1 }, action: { kind: 'resume', sessionId: 'a' } }]),
    { kind: 'resume' }, 'time-triggered, not a reset wait');
});

test('selectionState labels a single-repo selection with the repo name', () => {
  const out = selectionState(
    [session({ id: 'a', status: 'done' }), session({ id: 'b', repo: '/r/one', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.count, 2);
  assert.equal(out.label, '2 selected · one');
  assert.equal(out.merge.enabled, true);
  assert.equal(out.push.enabled, true);
});

test('selectionState disables merge and push across repos', () => {
  const out = selectionState(
    [session({ id: 'a', repo: '/r/one', status: 'done' }), session({ id: 'b', repo: '/r/two', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.label, '2 selected across 2 repos');
  assert.equal(out.merge.enabled, false);
  assert.equal(out.push.enabled, false);
  assert.match(out.merge.reason, /different repos/);
});

test('selectionState disables merge but not push while a selected session runs', () => {
  const out = selectionState(
    [session({ id: 'a', status: 'working', branch: 'feat/live' }), session({ id: 'b', status: 'done' })],
    new Set(['a', 'b']),
  );
  assert.equal(out.merge.enabled, false);
  assert.match(out.merge.reason, /feat\/live/);
  assert.equal(out.push.enabled, true);
});

test('selectionState survives an empty selection', () => {
  const out = selectionState([session()], new Set());
  assert.equal(out.count, 0);
  assert.equal(out.merge.enabled, false);
  assert.equal(out.push.enabled, false);
});

test('triggerLabel formats an at trigger as a local date/time', () => {
  const time = Date.parse('2026-08-01T15:00:00Z');
  assert.equal(triggerLabel({ kind: 'at', time }), new Date(time).toLocaleString());
});

test('triggerLabel names the account for a reset trigger', () => {
  assert.equal(triggerLabel({ kind: 'reset', account: 'claude-main' }), 'when claude-main resets');
});

test('targetLabel names the new branch for a create action', () => {
  const action = { kind: 'create', repo: '/r/one', branch: 'feat/new', account: 'claude-main', prompt: 'go' };
  assert.equal(targetLabel(action, []), 'feat/new · new worktree');
});

test('targetLabel names the branch and kind for a send action on a live session', () => {
  const sessions = [session({ id: 'a', branch: 'feat/a' })];
  const action = { kind: 'send', sessionId: 'a', text: 'keep going' };
  assert.equal(targetLabel(action, sessions), 'feat/a · message');
});

test('targetLabel names the branch and kind for a resume action on a live session', () => {
  const sessions = [session({ id: 'a', branch: 'feat/a' })];
  const action = { kind: 'resume', sessionId: 'a', prompt: 'continue' };
  assert.equal(targetLabel(action, sessions), 'feat/a · resume');
});

test('targetLabel falls back to "deleted session" for a session id no longer in the list', () => {
  const action = { kind: 'resume', sessionId: 'gone', prompt: 'continue' };
  assert.equal(targetLabel(action, []), 'deleted session · resume');
});

const acct = (over = {}) => ({
  name: 'claude-main', provider: 'claude', budget: 2000000,
  pace: 0.4, limits: null, limitsError: null, load: 0.4, ...over,
});

test('accountView without limits reproduces the estimate wording exactly', () => {
  const v = accountView(acct());
  assert.equal(v.real, false);
  assert.equal(v.pct, 40);
  assert.equal(v.title, 'claude-main — ~40% of its 5h budget (estimate)');
  assert.equal(v.budgetLine, 'claude · ~40% of a 2,000,000 token budget · estimate');
  assert.match(v.note, /not a real plan limit/);
  assert.deepEqual(v.windows, []);
});

test('accountView with limits drops the estimate wording', () => {
  const v = accountView(acct({
    limits: {
      fiveHour: { utilization: 11, resetsAt: '2026-08-03T19:10:00Z' },
      sevenDay: { utilization: 1, resetsAt: '2026-08-10T08:00:00Z' },
      subscription: 'pro',
    },
    load: 0.11,
  }));
  assert.equal(v.real, true);
  assert.equal(v.pct, 11);
  assert.equal(v.title, 'claude-main — 11% of the 5h limit');
  assert.equal(v.budgetLine, 'claude · pro plan');
  assert.equal(v.note, '');
  assert.deepEqual(v.windows.map((w) => [w.label, w.pct]), [['5h', 11], ['7d', 1]]);
});

test('accountView headlines the 5h window even when 7d is far worse', () => {
  const v = accountView(acct({
    limits: {
      fiveHour: { utilization: 5, resetsAt: '2026-08-03T19:10:00Z' },
      sevenDay: { utilization: 96, resetsAt: '2026-08-10T08:00:00Z' },
      subscription: 'max',
    },
    load: 0.96,
  }));
  // The badge stays on 5h — a nearly-exhausted week does not get to steal the
  // headline number, it only shows up in the tap-open panel's windows list.
  assert.equal(v.pct, 5);
  assert.equal(v.title, 'claude-main — 5% of the 5h limit');
  // `load` is untouched: it still ranks this account as nearly out of room for
  // the bar color and the New Session picker, even though the badge reads 5%.
  assert.equal(v.load, 0.96);
  assert.deepEqual(v.windows.map((w) => [w.label, w.pct]), [['5h', 5], ['7d', 96]]);
});

test('accountView falls back to 7d as the headline when the plan does not report 5h', () => {
  const v = accountView(acct({
    limits: { fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-08-10T08:00:00Z' }, subscription: 'pro' },
    load: 0.42,
  }));
  assert.equal(v.pct, 42);
  assert.equal(v.title, 'claude-main — 42% of the 7d limit');
  assert.deepEqual(v.windows.map((w) => w.label), ['7d']);
});

test('accountView omits a window the plan does not report', () => {
  const v = accountView(acct({
    limits: { fiveHour: { utilization: 8, resetsAt: '2026-08-03T19:10:00Z' }, sevenDay: null, subscription: 'pro' },
    load: 0.08,
  }));
  assert.deepEqual(v.windows.map((w) => w.label), ['5h']);
  // A single-element windows array is exactly the case the reduce seed used to
  // get wrong (windows[0] ?? {label:'5h', pct:0}) — assert on the actual value,
  // not just its presence.
  assert.equal(v.pct, 8);
  assert.equal(v.title, 'claude-main — 8% of the 5h limit');
});

test('accountView keeps a probe error out of the meter title', () => {
  const v = accountView(acct({ limitsError: 'logged out' }));
  assert.equal(v.real, false);
  assert.ok(!v.title.includes('logged out'), 'the error belongs in the panel, not the meter');
});

const withLimits = (name: string, pct: number) => acct({
  name,
  limits: { fiveHour: { utilization: pct, resetsAt: '2026-08-03T19:10:00Z' }, sevenDay: null, subscription: 'max' },
  load: pct / 100,
});

test('freestAccount does not let an unprobed account outrank a real number', () => {
  // The regression: codex has no plan limits, so its estimate reads 0% and the
  // dialog defaulted to it over every Claude account with a real utilization.
  const accounts = [
    withLimits('claude-main', 83),
    withLimits('claude-alt', 58),
    acct({ name: 'codex', provider: 'codex', pace: 0, load: 0 }),
  ];
  assert.equal(freestAccount(accounts).name, 'claude-alt');
});

test('freestAccount falls back to load when nobody has real limits', () => {
  const accounts = [acct({ name: 'a', load: 0.7 }), acct({ name: 'b', load: 0.2 })];
  assert.equal(freestAccount(accounts).name, 'b');
});

test('freestAccount picks the lowest load among accounts that all have limits', () => {
  assert.equal(freestAccount([withLimits('a', 90), withLimits('b', 12)]).name, 'b');
});

test('sortSessions defaults to blocked-first', () => {
  const out = sortSessions([
    session({ id: 'd', status: 'stopped' }),
    session({ id: 'a', status: 'needs-you' }),
  ]);
  assert.deepEqual(out.map((s) => s.id), ['a', 'd']);
});

test('sortSessions newest ignores status and orders by statusSince', () => {
  const out = sortSessions([
    session({ id: 'old', status: 'needs-you', statusSince: 100 }),
    session({ id: 'new', status: 'done', statusSince: 900 }),
  ], 'newest');
  assert.deepEqual(out.map((s) => s.id), ['new', 'old']);
});

test('sortSessions account groups by account, blocked-first within each', () => {
  const out = sortSessions([
    session({ id: 'b-done', account: 'bravo', status: 'done', statusSince: 900 }),
    session({ id: 'a-done', account: 'alpha', status: 'done', statusSince: 900 }),
    session({ id: 'a-block', account: 'alpha', status: 'needs-you', statusSince: 100 }),
  ], 'account');
  assert.deepEqual(out.map((s) => s.id), ['a-block', 'a-done', 'b-done']);
});

test('visibleSessions passes everything through when collapseDone is off', () => {
  const list = [session({ id: 'a', status: 'done' }), session({ id: 'b', status: 'working' })];
  assert.deepEqual(visibleSessions(list, false).map((s) => s.id), ['a', 'b']);
});

test('visibleSessions drops done sessions when collapseDone is on', () => {
  const list = [session({ id: 'a', status: 'done' }), session({ id: 'b', status: 'working' })];
  assert.deepEqual(visibleSessions(list, true).map((s) => s.id), ['b']);
});

test('visibleSessions never hides a stopped session', () => {
  // `stopped` is not `done`: it has a Resume button and unfinished work behind
  // it, so collapsing must not make it disappear.
  const list = [session({ id: 'a', status: 'stopped' })];
  assert.deepEqual(visibleSessions(list, true).map((s) => s.id), ['a']);
});

test('newlyNotifiable fires for a session entering a watched status', () => {
  const out = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you'], new Set());
  assert.deepEqual(out.fire.map((s) => s.id), ['a']);
});

test('newlyNotifiable ignores a status that is not being watched', () => {
  const out = newlyNotifiable([session({ id: 'a', status: 'done' })], ['needs-you'], new Set());
  assert.deepEqual(out.fire, []);
});

test('newlyNotifiable does not fire twice for the same session and status', () => {
  const first = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you'], new Set());
  const second = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you'], first.seen);
  assert.deepEqual(second.fire, []);
});

test('newlyNotifiable fires again when a session re-enters a watched status', () => {
  // needs-you -> working -> needs-you is a second, real interruption.
  const a = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you'], new Set());
  const b = newlyNotifiable([session({ id: 'a', status: 'working' })], ['needs-you'], a.seen);
  const c = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you'], b.seen);
  assert.deepEqual(c.fire.map((s) => s.id), ['a']);
});

test('newlyNotifiable fires for a stopped session when stopped is watched', () => {
  // `stopped` replaced the never-reachable `error` status as a NotifyOn member
  // (Status has no 'error' — every failure path lands on 'stopped'), so this
  // is the transition that actually needs to notify.
  const out = newlyNotifiable([session({ id: 'a', status: 'stopped' })], ['stopped'], new Set());
  assert.deepEqual(out.fire.map((s) => s.id), ['a']);
});

test('newlyNotifiable tracks each status independently', () => {
  const a = newlyNotifiable([session({ id: 'a', status: 'needs-you' })], ['needs-you', 'done'], new Set());
  const b = newlyNotifiable([session({ id: 'a', status: 'done' })], ['needs-you', 'done'], a.seen);
  assert.deepEqual(b.fire.map((s) => s.id), ['a'], 'done is a different transition than needs-you');
});

test('a seeded seen-set fires nothing, which is what a reconnect needs', () => {
  // The reconnect defect: a full snapshot of a dozen finished sessions must
  // not notify for any of them.
  const list = [session({ id: 'a', status: 'done' }), session({ id: 'b', status: 'done' })];
  const seeded = newlyNotifiable(list, ['done'], new Set(), true).seen;
  const after = newlyNotifiable(list, ['done'], seeded);
  assert.deepEqual(after.fire, []);
});

test('seeding returns a seen-set covering every watched session', () => {
  const out = newlyNotifiable([session({ id: 'a', status: 'done' })], ['done'], new Set(), true);
  assert.deepEqual(out.fire, [], 'seeding never fires');
  assert.equal(out.seen.has('a:done'), true);
});

const CMDS = [
  'ponytail:ponytail', 'ponytail:ponytail-help', 'ponytail:ponytail-review',
  'superpowers:brainstorming', 'compact', 'clear',
];

test('the command menu opens on a bare slash and lists everything', () => {
  const menu = commandMenu('/', 1, CMDS);
  assert.equal(menu.query, '');
  assert.deepEqual(menu.matches.length, CMDS.length);
});

test('the command menu reaches past the plugin prefix', () => {
  // "help" appears nowhere in "ponytail:" — matching only the namespaced string
  // start would find nothing, which is how it feels to type a command you know
  // the name of but not the plugin.
  const menu = commandMenu('/help', 5, CMDS);
  assert.deepEqual(menu.matches, ['ponytail:ponytail-help']);
});

test('a whole-name prefix outranks a bare-name prefix', () => {
  const menu = commandMenu('/pony', 5, CMDS);
  assert.equal(menu.matches[0], 'ponytail:ponytail');
});

test('the command menu closes once the caret is into the arguments', () => {
  // The token is still a command, but the user is writing its argument now.
  assert.equal(commandMenu('/ponytail ultra', 15, CMDS), null);
  // ...and comes back if they go back to edit the command itself.
  assert.ok(commandMenu('/ponytail ultra', 5, CMDS));
});

test('the command menu stays shut for ordinary messages', () => {
  assert.equal(commandMenu('fix the tests', 5, CMDS), null);
  assert.equal(commandMenu('what about a/b?', 15, CMDS), null);
  assert.equal(commandMenu('/nosuchthing', 12, CMDS), null);
});

test('only a command the agent will recognise gets coloured', () => {
  assert.equal(commandToken('/ponytail:ponytail-help', CMDS), '/ponytail:ponytail-help');
  // The bare form expands too (verified against the SDK), so it colours too.
  assert.equal(commandToken('/ponytail-help extra args', CMDS), '/ponytail-help');
  // Half-typed and unknown tokens stay plain: colour would promise an expansion
  // that is not going to happen.
  assert.equal(commandToken('/ponyt', CMDS), null);
  assert.equal(commandToken('/nope', CMDS), null);
  assert.equal(commandToken('hello', CMDS), null);
});

test('a newline ends the command token, for the multi-line new-session prompt', () => {
  // The first prompt box is a textarea, so the command is usually its own line.
  assert.equal(commandToken('/compact\nthen carry on', CMDS), '/compact');
  assert.ok(commandMenu('/comp\nthen carry on', 5, CMDS));
  // ...and the menu is gone once the caret is down on the next line.
  assert.equal(commandMenu('/compact\nthen carry on', 12, CMDS), null);
});

test('readTheme falls back to the default for anything that is not a known pair', () => {
  const dflt = { accent: 'coral', canvas: 'ink' };
  assert.deepEqual(readTheme(null), dflt);
  assert.deepEqual(readTheme(''), dflt);
  assert.deepEqual(readTheme('{oops'), dflt);
  assert.deepEqual(readTheme('"a string"'), dflt);
  assert.deepEqual(readTheme('{"accent":"chartreuse","canvas":"beige"}'), dflt);
  // Half-filled: the known half survives, the unknown half falls back.
  assert.deepEqual(readTheme('{"canvas":"paper"}'), { accent: 'coral', canvas: 'paper' });
});

test('readTheme passes a valid pair through', () => {
  assert.deepEqual(readTheme('{"accent":"teal","canvas":"cream"}'), { accent: 'teal', canvas: 'cream' });
});

// The inline <head> script cannot import this module — it has to run before
// first paint and app.js is deferred — so it restates the two name lists. This
// is the check that the two copies have not drifted.
test('the inline theme script accepts exactly the names lib.js knows', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const [, accents] = html.match(/\^\(([a-z|]+)\)\$\/\.test\(t\.accent\)/) ?? [];
  const [, canvases] = html.match(/\^\(([a-z|]+)\)\$\/\.test\(t\.canvas\)/) ?? [];
  assert.deepEqual(accents?.split('|'), [...ACCENTS]);
  assert.deepEqual(canvases?.split('|'), [...CANVASES]);
});

test('branchHues gives each of the first HUES branches a colour of its own', () => {
  const hues = branchHues(['perf-cache', 'main', 'spike-wasm', 'docs-rewrite', 'bugfix']);
  assert.equal(hues.size, HUES);
  assert.equal(new Set(hues.values()).size, HUES, 'two branches drew in the same colour');
});

test('branchHues dedupes and wraps past the palette', () => {
  // Repeats are what it is actually fed: one name per commit, not per branch.
  assert.deepEqual(branchHues(['b', 'a', 'b']), new Map([['a', 0], ['b', 1]]));
  const wrapped = branchHues(Array.from({ length: HUES + 2 }, (_, i) => `b${i}`));
  assert.equal(wrapped.get(`b${HUES}`), 0, 'the HUES+1th branch wraps to the first colour');
  for (const hue of wrapped.values()) assert.ok(hue >= 0 && hue < HUES, `${hue} is off-palette`);
});

// The colours live in the stylesheet, so a hue the JS can emit without a rule
// to match paints nothing and the line inherits whatever is above it.
test('every branch hue has a rule in the stylesheet', async () => {
  const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');
  for (let i = 0; i < HUES; i++) assert.match(css, new RegExp(`\\.hue-${i} \\{`), `no .hue-${i}`);
  assert.doesNotMatch(css, new RegExp(`\\.hue-${HUES} \\{`), `.hue-${HUES} is unreachable`);
});

// The ⏱ button did nothing at all on an empty composer, which reads as a dead
// button. Both halves of the fix are load-bearing: `required` is what produces
// the message, and composerText() is what routes both buttons through it. A DOM
// harness for one click is more machinery than the check is worth.
test('an empty composer explains itself instead of silently doing nothing', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(html, /<textarea id="prompt"[^>]*\srequired/, '#prompt lost its required attribute');
  assert.match(js, /function composerText\(\)[\s\S]*?reportValidity\(\)/, 'composerText no longer reports why');
  for (const [name, handler] of [
    ['submit', js.match(/\$\('#composer'\)\.onsubmit = [\s\S]*?\n\};/)?.[0]],
    ['schedule', js.match(/\$\('#schedule-btn'\)\.onclick = [\s\S]*?\n\};/)?.[0]],
  ]) {
    assert.ok(handler, `could not find the ${name} handler`);
    assert.match(handler, /composerText\(\)/, `the ${name} handler bypasses composerText`);
  }
});

const gc = (h, p, tier, refs = []) => ({ h, p, tier, refs });

test('attributeBranches walks each tip back to the trunk fork point', () => {
  const owner = attributeBranches([
    gc('f1', ['f0'], 'own', ['HEAD -> feat']),
    gc('f0', ['t9'], 'own', []),
    gc('b1', ['t9'], 'other', ['bugfix', 'tag: v1']),
    gc('t9', ['t8'], 'trunk', ['main']),
    gc('t8', [], 'trunk', []),
  ]);

  assert.equal(owner.get('f1'), 'feat');
  assert.equal(owner.get('f0'), 'feat', 'attribution continues past the tip');
  assert.equal(owner.get('b1'), 'bugfix', 'a tag is not a branch name');
  assert.equal(owner.get('t9'), undefined, 'the walk stops at trunk');
  assert.equal(owner.get('t8'), undefined);
});

test('attributeBranches gives a shared commit to the first tip that claims it', () => {
  const owner = attributeBranches([
    gc('a', ['s'], 'own', ['HEAD -> a-branch']),
    gc('b', ['s'], 'other', ['b-branch']),
    gc('s', [], 'other', []),
  ]);

  assert.equal(owner.get('a'), 'a-branch');
  assert.equal(owner.get('b'), 'b-branch');
  assert.equal(owner.get('s'), 'a-branch', 'claimed once, by the branch listed first');
});

test('attributeBranches keeps a merged-in branch tip owned by its own name', () => {
  // m merges a (its own branch A) and b into B. Without seeding, walking from
  // m (processed first — it's the child, so it comes first in topo order)
  // would reach `a` before `a`'s own tip gets a turn, and claim it for B.
  const owner = attributeBranches([
    gc('m', ['a', 'b'], 'own', ['HEAD -> B']),
    gc('a', ['r'], 'other', ['A']),
    gc('b', ['r'], 'other', []),
    gc('r', [], 'trunk', ['main']),
  ]);

  assert.equal(owner.get('m'), 'B');
  assert.equal(owner.get('a'), 'A', 'the merged-in branch keeps its own tip');
  assert.equal(owner.get('b'), 'B', 'b has no ref of its own, so it belongs to the merge');
});

test('attributeBranches tolerates a parent outside the fetched window', () => {
  // commitGraph truncates at `limit`, so a parent hash can legitimately be
  // absent from the array — the walk must skip it, not throw.
  const owner = attributeBranches([
    gc('f1', ['missing'], 'own', ['HEAD -> feat']),
  ]);

  assert.equal(owner.get('f1'), 'feat');
});

test('attributeBranches stays fast through nested diamonds in one branch (perf regression guard)', () => {
  // Each level is a merge diamond (mi -> pi, qi; pi/qi -> m{i+1}) all inside
  // the same branch. A same-name node is deliberately re-enterable (it's how
  // a merged-in tip keeps its own name), so without deduping expansions per
  // walk, m{i+1} gets queued twice by level i, m{i+2} four times, and so on —
  // exponential in the level count. Without the `seen` set this test takes
  // minutes; with it, well under a millisecond. Do not remove `seen`.
  const levels = 22;
  const commits = [];
  for (let i = 0; i < levels; i++) {
    commits.push(gc(`m${i}`, [`p${i}`, `q${i}`], 'own', i === 0 ? ['HEAD -> feat'] : []));
    commits.push(gc(`p${i}`, [`m${i + 1}`], 'own', []));
    commits.push(gc(`q${i}`, [`m${i + 1}`], 'own', []));
  }
  commits.push(gc(`m${levels}`, [], 'trunk', ['main']));

  const start = Date.now();
  const owner = attributeBranches(commits);
  const elapsed = Date.now() - start;

  assert.equal(owner.get('m0'), 'feat');
  assert.ok(elapsed < 1000, `expected under 1000ms, took ${elapsed}ms`);
});
