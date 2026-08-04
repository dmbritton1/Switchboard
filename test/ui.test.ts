import { test } from 'node:test';
import assert from 'node:assert';
import {
  sortSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel, accountView,
  freestAccount, groupTranscript, toolRunLabel, commandMenu, commandToken,
} from '../web/lib.js';

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
