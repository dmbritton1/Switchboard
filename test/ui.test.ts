import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import {
  sortSessions, visibleSessions, cardAction, decideSpecs, selectionState, triggerLabel, targetLabel,
  accountView, freestAccount, newlyNotifiable, linkView,
  groupTranscript, toolRunLabel, resultMeta, promptFold, commandMenu, commandToken,
  attributeBranches, branchHues, HUES, readTheme, ACCENTS, CANVASES,
  pastedName, composeMessage, diffSummary, patchLineClass,
  transcriptView, detailKey, requestOnce, needsDetailFetch, detailPresentation,
  fetchToolDetail, createDetailController, changeDetailSession, setDetailExpanded,
  detailControllerView, storeToolDetail, storeToolDetailError, invalidateToolDetail,
  addAttachment, removeAttachment, sendPayload, settleSendState,
  snapshotFiles, createAttachmentController, changeAttachmentSession,
  beginAttachmentUpload, addUploadedAttachment, finishAttachmentUpload,
  dismissAttachmentUploadError, attachmentComposerBusy,
  beginAttachmentSend, completeAttachmentSend,
  codexSettingsFromForm, codexSettingsSummary, usageLines,
} from '../web/lib.js';

// Nothing else in `npm test` ever loads app.js as code — the DOM it wants is
// out of scope for a plain test run — so a renamed or dropped lib.js export
// would only surface as a blank page in the browser. This catches that one
// realistic failure without a DOM harness: import lib.js for real and check
// every name app.js's import block asks it for is actually there.
test('every name app.js imports from lib.js is actually exported', async () => {
  const appJs = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const block = appJs.match(/^import \{([\s\S]*?)\} from '\.\/lib\.js';/m)?.[1];
  assert.ok(block, 'could not find the lib.js import block in app.js');
  const names = block.split(',').map((n) => n.trim()).filter(Boolean);
  const lib = await import('../web/lib.js');
  for (const name of names) assert.ok(name in lib, `app.js imports ${name}, which lib.js does not export`);
});

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

test('resultMeta measures long output and inlines a short one-liner', () => {
  assert.deepEqual(resultMeta('a\nb\nc'), { label: '3 lines', fold: true });
  // Trailing newlines are how the output ended, not an extra line of it.
  assert.deepEqual(resultMeta('a\nb\n\n'), { label: '2 lines', fold: true });
  assert.deepEqual(resultMeta('clean'), { label: 'clean', fold: false },
    'a short one-liner reads on the call line rather than behind a click');
  assert.deepEqual(resultMeta('x'.repeat(81)), { label: '1 line', fold: true },
    'one very long line is still a wall, so it folds');
  // A running call has no output yet, and an empty result is not worth a row.
  assert.deepEqual(resultMeta(undefined), { label: '', fold: false });
  assert.deepEqual(resultMeta('\n'), { label: '', fold: false });
});

test('promptFold leaves a short prompt alone', () => {
  assert.equal(promptFold('run the tests'), null);
  assert.equal(promptFold('line one\nline two\nline three'), null,
    'a handful of short lines still reads fine in full');
});

test('promptFold cuts a many-line prompt at a line boundary', () => {
  const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`);
  const fold = promptFold(lines.join('\n'));
  assert.equal(fold.head, lines.slice(0, 6).join('\n'));
  assert.equal(fold.rest, `\n${lines.slice(6).join('\n')}`);
  assert.equal(fold.head + fold.rest, lines.join('\n'),
    'the two halves must reassemble the exact original text');
});

test('promptFold cuts a long single-line prompt on a word boundary', () => {
  const text = `${'word '.repeat(150)}tail`;
  const fold = promptFold(text);
  assert.ok(fold, 'well past the character cap, so it folds despite being one line');
  assert.ok(fold.head.length <= 600);
  assert.ok(!fold.head.endsWith('wor'), 'cut lands on a space, not mid-word');
  assert.equal(fold.head + fold.rest, text);
});

test('promptFold falls back to a hard cut with no nearby word boundary', () => {
  const text = 'x'.repeat(1000);
  const fold = promptFold(text);
  assert.equal(fold.head.length, 600);
  assert.equal(fold.head + fold.rest, text);
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

test('Codex settings form preserves inherited values and explicit disabled network access', () => {
  assert.equal(codexSettingsFromForm({ model: '', reasoning: '', webSearch: '', network: '' }), undefined);
  assert.deepEqual(codexSettingsFromForm({
    model: ' gpt-5.3-codex ', reasoning: 'high', webSearch: 'live', network: 'disabled',
  }), {
    model: 'gpt-5.3-codex', modelReasoningEffort: 'high', webSearchMode: 'live', networkAccessEnabled: false,
  });
});

test('Codex settings summary distinguishes inherited and explicit disabled network access', () => {
  assert.equal(codexSettingsSummary(undefined), 'Inherit');
  assert.equal(codexSettingsSummary({ networkAccessEnabled: false }), 'Network: Disabled');
});

test('usageLines shows basic and full SDK-backed usage exactly', () => {
  assert.deepEqual(usageLines(null), []);
  assert.deepEqual(usageLines({ inputTokens: 10, outputTokens: 5 }), [
    'input: 10', 'output: 5',
  ]);
  assert.deepEqual(usageLines({
    inputTokens: 10, outputTokens: 5,
    cachedInputTokens: 3, cacheWriteInputTokens: 7, reasoningOutputTokens: 2,
  }), [
    'input: 10', 'output: 5', 'cached input: 3', 'cache write input: 7', 'reasoning output: 2',
  ]);
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

test('transcriptView projects a running tool with collapsible detail', () => {
  assert.deepEqual(transcriptView({
    kind: 'tool', id: 'c1', name: 'shell', summary: 'npm test', status: 'running',
    detailAvailable: true, detailEvicted: false,
    detailRevision: 4, detailTruncated: false,
  }), {
    kind: 'tool', id: 'c1', className: 'msg tool running',
    summary: 'shell: npm test', detailAvailable: true, detailEvicted: false,
    detailRevision: 4, truncated: false,
  });
});

test('transcriptView labels terminal tools and preserves bounded-detail metadata', () => {
  assert.deepEqual(transcriptView({
    kind: 'tool', id: 'ok', name: 'edit', summary: '2 files', status: 'ok',
    detailAvailable: true, detailEvicted: false,
    detailRevision: 8, detailTruncated: true,
  }), {
    kind: 'tool', id: 'ok', className: 'msg tool ok',
    summary: 'edit: 2 files · ok', detailAvailable: true, detailEvicted: false,
    detailRevision: 8, truncated: true,
  });
  assert.equal(transcriptView({
    kind: 'tool', id: 'bad', name: 'shell', summary: 'false', status: 'error',
    detailAvailable: false, detailEvicted: true,
    detailRevision: 9, detailTruncated: false,
  }).summary, 'shell: false · error');
});

test('transcriptView preserves SDK and MCP summaries verbatim even when the tool is named edit', () => {
  const mcpEdit = transcriptView({
    kind: 'tool', id: 'mcp-edit', name: 'edit', summary: 'workspace.edit', status: 'running',
    detailAvailable: false, detailEvicted: false,
    detailRevision: 0, detailTruncated: false,
  });
  assert.equal(mcpEdit.summary, 'edit: workspace.edit');
  assert.equal(transcriptView({
    kind: 'tool', id: 'shell-1', name: 'shell', summary: 'npm test', status: 'running',
    detailAvailable: false, detailEvicted: false,
    detailRevision: 0, detailTruncated: false,
  }).summary, 'shell: npm test');
});

test('transcriptView distinguishes evicted, never-present, and legacy no-detail tools', () => {
  const evicted = transcriptView({
    kind: 'tool', id: 'old', name: 'shell', summary: 'old', status: 'ok',
    detailAvailable: false, detailEvicted: true,
    detailRevision: 7, detailTruncated: false,
  });
  assert.equal(evicted.detailAvailable, false);
  assert.equal(evicted.detailEvicted, true);

  const neverPresent = transcriptView({
    kind: 'tool', id: 'live', name: 'shell', summary: 'waiting', status: 'running',
    detailAvailable: false, detailEvicted: false,
    detailRevision: 0, detailTruncated: false,
  });
  assert.equal(neverPresent.detailAvailable, false);
  assert.equal(neverPresent.detailEvicted, false);

  assert.deepEqual(transcriptView({
    kind: 'tool', name: 'Bash', summary: 'pwd', status: 'running',
  }), {
    kind: 'tool', id: '', className: 'msg tool running', summary: 'Bash: pwd',
    detailAvailable: false, detailEvicted: false, detailRevision: 0, truncated: false,
  });
});

test('transcriptView keeps reasoning and todos distinct from tools', () => {
  assert.deepEqual(
    transcriptView({ kind: 'reasoning', id: 'r1', text: 'Checking the failing path.' }),
    { kind: 'reasoning', className: 'msg reasoning', summary: 'Checking the failing path.' },
  );
  assert.deepEqual(transcriptView({
    kind: 'todo', id: 't1', items: [{ text: 'Run tests', completed: true }],
  }), {
    kind: 'todo', className: 'msg todo', items: [{ text: 'Run tests', completed: true }],
  });
});

test('transcriptView preserves assistant, error, and user text without exposing prompt ids', () => {
  assert.deepEqual(transcriptView({ kind: 'text', text: 'Done.' }), {
    kind: 'text', className: 'msg text', summary: 'Done.',
  });
  assert.deepEqual(transcriptView({ kind: 'error', text: 'Failed.' }), {
    kind: 'text', className: 'msg error', summary: 'Failed.',
  });
  assert.deepEqual(transcriptView({
    kind: 'user', id: '/private/prompt-id', text: 'Please continue.', delivery: 'queued',
  }), {
    kind: 'text', className: 'msg user', summary: 'Please continue.',
  });
});

test('transcriptView exposes attachment filenames without exposing stored paths', () => {
  assert.deepEqual(transcriptView({
    kind: 'user', text: 'Inspect these.', delivery: 'sent',
    attachments: ['uploads/screen.png', '/private/customer/notes.txt', 'nested\\photo.webp'],
  }), {
    kind: 'text', className: 'msg user', summary: 'Inspect these.',
    attachments: ['screen.png', 'notes.txt', 'photo.webp'],
  });
});

test('attachment helpers deduplicate, remove, and build a path-only request', () => {
  const first = addAttachment([], { name: 'screen.png', path: 'uploads/screen.png' });
  const duplicate = addAttachment(first, { name: 'screen.png', path: 'uploads/screen.png' });
  const second = addAttachment(duplicate, { name: 'notes.txt', path: 'uploads/notes.txt' });
  assert.strictEqual(duplicate, first, 'a duplicate does not churn composer state');
  assert.deepEqual(second.map((item) => item.name), ['screen.png', 'notes.txt']);
  assert.deepEqual(sendPayload('s1', 'inspect it', second), {
    cmd: 'send', id: 's1', text: 'inspect it',
    attachments: ['uploads/screen.png', 'uploads/notes.txt'],
  });
  assert.deepEqual(removeAttachment(second, 'uploads/screen.png'), [
    { name: 'notes.txt', path: 'uploads/notes.txt' },
  ]);
});

test('settleSendState retains the retry draft after failure and clears it after acceptance', () => {
  const attachments = [{ name: 'screen.png', path: 'uploads/screen.png' }];
  const failure = settleSendState('inspect it', attachments, { ok: false });
  assert.equal(failure.text, 'inspect it');
  assert.strictEqual(failure.attachments, attachments);

  assert.deepEqual(settleSendState('inspect it', attachments, { ok: true }), {
    text: '', attachments: [],
  });
});

test('snapshotFiles detaches every selected file from a live multi-file collection', () => {
  const first = { name: 'screen.png' };
  const second = { name: 'notes.txt' };
  const backing = [first, second];
  const liveFiles = { [Symbol.iterator]: () => backing[Symbol.iterator]() };

  const snapshot = snapshotFiles(liveFiles);
  backing.length = 0; // assigning input.value = '' empties a browser FileList live

  assert.deepEqual(snapshot, [first, second]);
});

test('attachment session transition preserves same-session SSE state and resets a real switch', () => {
  const controller = createAttachmentController();
  assert.equal(changeAttachmentSession(controller, 's1'), true);
  controller.pendingAttachments = [{ name: 'screen.png', path: 'uploads/screen.png' }];
  controller.uploadError = 'could not attach screen.png';

  assert.equal(changeAttachmentSession(controller, 's1'), false, 'an SSE render is not navigation');
  assert.equal(controller.pendingAttachments.length, 1);
  assert.equal(controller.uploadError, 'could not attach screen.png');

  assert.equal(changeAttachmentSession(controller, 's2'), true);
  assert.deepEqual(controller.pendingAttachments, []);
  assert.equal(controller.uploadError, '');
  assert.equal(attachmentComposerBusy(controller), false);
});

test('a stale upload completion cannot add a chip or error to the next session', () => {
  const controller = createAttachmentController();
  changeAttachmentSession(controller, 's1');
  const upload = beginAttachmentUpload(controller);
  changeAttachmentSession(controller, 's2');
  const currentUpload = beginAttachmentUpload(controller);

  assert.equal(addUploadedAttachment(controller, upload, {
    name: 'secret.png', path: 'uploads/secret.png',
  }), false);
  assert.equal(finishAttachmentUpload(controller, upload, 'old session failed'), false);
  assert.deepEqual(controller.pendingAttachments, []);
  assert.equal(controller.uploadError, '');
  assert.equal(controller.uploadsInFlight, 1, 'stale completion does not decrement new work');
  finishAttachmentUpload(controller, currentUpload);
});

test('concurrent uploads keep the composer busy until the last current operation settles', () => {
  const controller = createAttachmentController();
  changeAttachmentSession(controller, 's1');
  const first = beginAttachmentUpload(controller);
  const second = beginAttachmentUpload(controller);
  assert.equal(controller.uploadsInFlight, 2);
  assert.equal(attachmentComposerBusy(controller), true);

  assert.equal(finishAttachmentUpload(controller, first), true);
  assert.equal(controller.uploadsInFlight, 1);
  assert.equal(attachmentComposerBusy(controller), true, 'Send must stay disabled');
  assert.equal(beginAttachmentSend(controller, 'too early'), null);

  assert.equal(finishAttachmentUpload(controller, second), true);
  assert.equal(controller.uploadsInFlight, 0);
  assert.equal(attachmentComposerBusy(controller), false);
});

test('attachment send completion retains failure state, clears success, and ignores stale responses', () => {
  const controller = createAttachmentController();
  changeAttachmentSession(controller, 's1');
  controller.pendingAttachments = [{ name: 'screen.png', path: 'uploads/screen.png' }];

  const failed = beginAttachmentSend(controller, 'inspect it');
  assert.ok(failed);
  assert.equal(completeAttachmentSend(controller, failed, { ok: false }).text, 'inspect it');
  assert.equal(controller.pendingAttachments.length, 1);
  assert.equal(controller.sendInFlight, false);

  const succeeded = beginAttachmentSend(controller, 'retry it');
  assert.deepEqual(completeAttachmentSend(controller, succeeded, { ok: true }), {
    applied: true, text: '',
  });
  assert.deepEqual(controller.pendingAttachments, []);

  controller.pendingAttachments = [{ name: 'new.txt', path: 'uploads/new.txt' }];
  const stale = beginAttachmentSend(controller, 'old draft');
  changeAttachmentSession(controller, 's2');
  controller.pendingAttachments = [{ name: 'next.txt', path: 'uploads/next.txt' }];
  const current = beginAttachmentSend(controller, 'new draft');
  assert.deepEqual(completeAttachmentSend(controller, stale, { ok: true }), {
    applied: false, text: null,
  });
  assert.deepEqual(controller.pendingAttachments, [
    { name: 'next.txt', path: 'uploads/next.txt' },
  ]);
  assert.equal(controller.sendInFlight, true, 'stale response cannot unlock the current send');
  completeAttachmentSend(controller, current, { ok: false });
});

test('upload errors survive same-session updates and clear on retry, dismiss, or navigation', () => {
  const controller = createAttachmentController();
  changeAttachmentSession(controller, 's1');
  const failed = beginAttachmentUpload(controller);
  finishAttachmentUpload(controller, failed, 'could not attach screen.png');
  changeAttachmentSession(controller, 's1');
  assert.equal(controller.uploadError, 'could not attach screen.png');

  const retry = beginAttachmentUpload(controller);
  assert.equal(controller.uploadError, '', 'retry start clears the retained error');
  finishAttachmentUpload(controller, retry, 'failed again');
  dismissAttachmentUploadError(controller);
  assert.equal(controller.uploadError, '');

  const finalFailure = beginAttachmentUpload(controller);
  finishAttachmentUpload(controller, finalFailure, 'failed before switch');
  changeAttachmentSession(controller, 's2');
  assert.equal(controller.uploadError, '');
});

test('detailKey cannot collide across session and item identifier boundaries', () => {
  const key = detailKey('s1', 'i1');
  assert.notEqual(key, detailKey('s1', 'i2'));
  assert.notEqual(key, detailKey('s2', 'i1'));
  assert.notEqual(detailKey('a:b', 'c'), detailKey('a', 'b:c'));
});

test('needsDetailFetch fetches only available, current, non-evicted detail', () => {
  const view = transcriptView({
    kind: 'tool', id: 'c1', name: 'shell', summary: 'npm test', status: 'running',
    detailAvailable: true, detailEvicted: false,
    detailRevision: 4, detailTruncated: false,
  });
  assert.equal(needsDetailFetch(view), true, 'missing cache');
  assert.equal(needsDetailFetch(view, { revision: 4 }), false, 'matching revision');
  assert.equal(needsDetailFetch(view, { revision: 3 }), true, 'changed revision');
  assert.equal(needsDetailFetch({ ...view, detailAvailable: false }), false, 'unavailable');
  assert.equal(needsDetailFetch({ ...view, detailEvicted: true }), false, 'evicted');
});

test('detailPresentation restores expanded cached content across transcript rebuilds', () => {
  const view = transcriptView({
    kind: 'tool', id: 'c1', name: 'shell', summary: 'npm test', status: 'running',
    detailAvailable: true, detailEvicted: false,
    detailRevision: 4, detailTruncated: false,
  });
  assert.deepEqual(detailPresentation(view, true, {
    revision: 4, text: 'working output', truncated: false,
  }), {
    open: true, mode: 'content', text: 'working output', fetch: false,
  });
});

test('detailPresentation covers collapsed, loading, stale, evicted, and cached-error states', () => {
  const view = transcriptView({
    kind: 'tool', id: 'c1', name: 'shell', summary: 'npm test', status: 'running',
    detailAvailable: true, detailEvicted: false,
    detailRevision: 4, detailTruncated: false,
  });
  assert.deepEqual(detailPresentation(view, false), {
    open: false, mode: 'hidden', text: '', fetch: false,
  });
  assert.deepEqual(detailPresentation(view, true), {
    open: true, mode: 'loading', text: 'Loading…', fetch: true,
  });
  assert.deepEqual(detailPresentation(view, true, {
    revision: 3, text: 'stale output', truncated: false,
  }), {
    open: true, mode: 'loading', text: 'Loading…', fetch: true,
  });
  assert.deepEqual(detailPresentation({ ...view, detailEvicted: true }, true), {
    open: true, mode: 'evicted',
    text: 'Detail removed to stay within the storage limit.', fetch: false,
  });
  assert.deepEqual(detailPresentation(view, true, {
    revision: 4, text: null, truncated: false, error: 'Detail request failed.',
  }), {
    open: true, mode: 'error', text: 'Detail request failed.', fetch: false,
  });
});

test('requestOnce deduplicates a live request and removes it after settlement', async () => {
  const requests = new Map();
  let calls = 0;
  const gate = Promise.withResolvers();
  const first = requestOnce(requests, 's1:i1:4', async () => {
    calls++;
    await gate.promise;
    return 'detail';
  });
  const second = requestOnce(requests, 's1:i1:4', async () => 'duplicate');
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  gate.resolve(undefined);
  assert.equal(await first, 'detail');
  assert.equal(requests.size, 0);
});

test('requestOnce does not let a stale settled request delete a newer request for the same key', async () => {
  const requests = new Map();
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const first = requestOnce(requests, 'same', () => a.promise);
  requests.clear();
  const second = requestOnce(requests, 'same', () => b.promise);

  a.resolve('old');
  assert.equal(await first, 'old');
  assert.strictEqual(requests.get('same'), second);

  b.resolve('new');
  assert.equal(await second, 'new');
  assert.equal(requests.size, 0);
});

const richTool = (revision = 4, over = {}) => transcriptView({
  kind: 'tool', id: 'cmd-1', name: 'shell', summary: 'npm test', status: 'running',
  detailAvailable: true, detailEvicted: false,
  detailRevision: revision, detailTruncated: false, ...over,
});

test('detail controller clears session-local state on session switches and Back', () => {
  const controller = createDetailController();
  assert.equal(changeDetailSession(controller, 's1'), true);
  setDetailExpanded(controller, 's1', 'cmd-1', true);
  controller.detailCache.set(detailKey('s1', 'cmd-1'), {
    revision: 4, text: 'output', truncated: false,
  });
  controller.detailRequests.set('live', Promise.resolve());

  assert.equal(changeDetailSession(controller, 's2'), true);
  assert.equal(controller.detailSession, 's2');
  assert.equal(controller.expandedItems.size, 0);
  assert.equal(controller.detailCache.size, 0);
  assert.equal(controller.detailRequests.size, 0);

  setDetailExpanded(controller, 's2', 'cmd-1', true);
  assert.equal(changeDetailSession(controller, null), true, 'Back closes the session');
  assert.equal(controller.detailSession, null);
  assert.equal(controller.expandedItems.size, 0);
  assert.equal(changeDetailSession(controller, null), false, 'repeated Back is not a switch');
});

test('detail controller preserves expanded cached content across rebuild projections', () => {
  const controller = createDetailController();
  changeDetailSession(controller, 's1');
  setDetailExpanded(controller, 's1', 'cmd-1', true);
  controller.detailCache.set(detailKey('s1', 'cmd-1'), {
    revision: 4, text: 'working output', truncated: false,
  });

  const first = detailControllerView(controller, 's1', richTool());
  const rebuilt = detailControllerView(controller, 's1', richTool());
  assert.deepEqual(first.presentation, {
    open: true, mode: 'content', text: 'working output', fetch: false,
  });
  assert.deepEqual(rebuilt.presentation, first.presentation);
  assert.equal(rebuilt.request, null);
});

test('detail controller refreshes changed revisions with one deduplicated request key', async () => {
  const controller = createDetailController();
  changeDetailSession(controller, 's1');
  setDetailExpanded(controller, 's1', 'cmd-1', true);
  controller.detailCache.set(detailKey('s1', 'cmd-1'), {
    revision: 4, text: 'old', truncated: false,
  });

  const firstView = detailControllerView(controller, 's1', richTool(5));
  const rebuiltView = detailControllerView(controller, 's1', richTool(5));
  assert.equal(firstView.presentation.mode, 'loading');
  assert.deepEqual(rebuiltView.request, firstView.request);

  let calls = 0;
  const gate = Promise.withResolvers();
  const first = requestOnce(controller.detailRequests, firstView.request.requestKey, async () => {
    calls++;
    return gate.promise;
  });
  const duplicate = requestOnce(
    controller.detailRequests,
    rebuiltView.request.requestKey,
    async () => 'duplicate',
  );
  assert.strictEqual(first, duplicate);
  assert.equal(calls, 1);
  gate.resolve('fresh');
  assert.equal(await first, 'fresh');
});

test('detail controller rejects stale revisions and responses from an earlier session generation', () => {
  const controller = createDetailController();
  changeDetailSession(controller, 's1');
  setDetailExpanded(controller, 's1', 'cmd-1', true);
  const request = detailControllerView(controller, 's1', richTool(4)).request;
  const detail = { text: 'stale', truncated: false, evicted: false, revision: 4 };

  assert.equal(storeToolDetail(controller, request, richTool(5), detail), false);
  assert.equal(controller.detailCache.size, 0);

  changeDetailSession(controller, 's2');
  assert.equal(storeToolDetail(controller, request, richTool(4), detail), false);
  assert.equal(controller.detailCache.size, 0);
});

test('detail controller clears cache on eviction and clears expansion when detail is unavailable', () => {
  const controller = createDetailController();
  changeDetailSession(controller, 's1');
  const key = setDetailExpanded(controller, 's1', 'cmd-1', true);
  controller.detailCache.set(key, { revision: 4, text: 'old', truncated: false });

  const evicted = detailControllerView(controller, 's1', richTool(5, {
    detailAvailable: false, detailEvicted: true,
  }));
  assert.equal(controller.detailCache.has(key), false);
  assert.equal(controller.expandedItems.has(key), true);
  assert.equal(evicted.presentation.mode, 'evicted');

  controller.detailCache.set(key, { revision: 5, text: 'impossible', truncated: false });
  const unavailable = detailControllerView(controller, 's1', richTool(5, {
    detailAvailable: false, detailEvicted: false,
  }));
  assert.equal(controller.detailCache.has(key), false);
  assert.equal(controller.expandedItems.has(key), false);
  assert.equal(unavailable.presentation.mode, 'hidden');
});

test('detail controller Retry invalidates a cached error and makes the expanded item fetchable', () => {
  const controller = createDetailController();
  changeDetailSession(controller, 's1');
  setDetailExpanded(controller, 's1', 'cmd-1', true);
  const request = detailControllerView(controller, 's1', richTool()).request;
  assert.equal(storeToolDetailError(controller, request, richTool(), 'Detail request failed.'), true);
  assert.equal(detailControllerView(controller, 's1', richTool()).presentation.mode, 'error');

  invalidateToolDetail(controller, 's1', 'cmd-1');
  const retry = detailControllerView(controller, 's1', richTool());
  assert.equal(retry.presentation.mode, 'loading');
  assert.ok(retry.request);
});

test('fetchToolDetail encodes Registry keys and returns the JSON detail body', async () => {
  let requested = '';
  const body = { text: 'output', truncated: false, evicted: false, revision: 4 };
  const result = await fetchToolDetail('s 1', 'i/1', async (url) => {
    requested = String(url);
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(requested, '/detail?session=s+1&item=i%2F1');
  assert.deepEqual(result, body);
});

test('fetchToolDetail sanitizes HTTP, network, and malformed response failures', async () => {
  await assert.rejects(
    fetchToolDetail('s', 'i', async () => new Response('<secret>', { status: 503 })),
    { message: 'Detail request failed (HTTP 503).' },
  );
  await assert.rejects(
    fetchToolDetail('s', 'i', async () => { throw new Error('token=secret'); }),
    { message: 'Detail request failed.' },
  );
  await assert.rejects(
    fetchToolDetail('s', 'i', async () => new Response('<not-json>', { status: 200 })),
    { message: 'Detail request failed.' },
  );
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
  const dflt = { accent: 'coral', canvas: 'obsidian' };
  assert.deepEqual(readTheme(null), dflt);
  assert.deepEqual(readTheme(''), dflt);
  assert.deepEqual(readTheme('{oops'), dflt);
  assert.deepEqual(readTheme('"a string"'), dflt);
  assert.deepEqual(readTheme('{"accent":"chartreuse","canvas":"beige"}'), dflt);
  // Half-filled: the known half survives, the unknown half falls back.
  assert.deepEqual(readTheme('{"canvas":"linen"}'), { accent: 'coral', canvas: 'linen' });
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

const fileDiff = (over = {}) => ({
  path: 'src/a.ts', added: 3, removed: 1, binary: false, patch: '', truncated: false, ...over,
});

test('diffSummary names the file and its line counts, and spells out a rename', () => {
  assert.equal(diffSummary(fileDiff()), 'src/a.ts · +3 −1');
  assert.equal(
    diffSummary(fileDiff({ old: 'src/old.ts', path: 'src/new.ts', added: 0, removed: 0 })),
    'src/old.ts → src/new.ts · +0 −0',
  );
  // A byte count is not a line count, so a binary file says so instead of "+0 −0".
  assert.equal(diffSummary(fileDiff({ path: 'logo.png', binary: true })), 'logo.png · binary');
});

test('patchLineClass tells the four kinds of patch line apart', () => {
  assert.equal(patchLineClass('+added'), 'add');
  assert.equal(patchLineClass('-removed'), 'del');
  assert.equal(patchLineClass('@@ -1,2 +1,3 @@'), 'hunk');
  assert.equal(patchLineClass(' context'), '');
  assert.equal(patchLineClass(''), '', 'a blank context line is still context');
  // `---`/`+++` are stripped server-side, but a *body* line of dashes is real
  // content and must not be mistaken for a header.
  assert.equal(patchLineClass('+++ this is content'), 'add');
});

test('linkView is null when no link is in progress', () => {
  assert.equal(linkView(null), null);
});

test('linkView asks the user to wait before a URL exists', () => {
  const v = linkView({
    provider: 'claude', phase: 'starting', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: null,
  });
  assert.equal(v.showUrl, false);
  assert.equal(v.busy, true);
  assert.equal(v.showCodeBox, false);
});

test('linkView offers the sign-in link once the URL arrives', () => {
  const v = linkView({
    provider: 'codex', phase: 'awaiting-user', url: 'https://auth.openai.com/x',
    codeRequested: false, identity: null, suggestedName: null, error: null,
  });
  assert.equal(v.showUrl, true);
  assert.equal(v.url, 'https://auth.openai.com/x');
  assert.equal(v.showCodeBox, false);
  assert.equal(v.showNameForm, false);
});

// The paste box follows the CLI's actual prompt, not the provider: the Claude
// CLI hedges with "if prompted", so the no-prompt branch is real.
test('linkView shows the code box only once the CLI asked for one', () => {
  const base = {
    provider: 'claude', phase: 'awaiting-user', url: 'https://claude.com/x',
    identity: null, suggestedName: null, error: null,
  };
  assert.equal(linkView({ ...base, codeRequested: false }).showCodeBox, false);
  assert.equal(linkView({ ...base, codeRequested: true }).showCodeBox, true);
});

test('linkView shows the name form with the identity once naming', () => {
  const v = linkView({
    provider: 'claude', phase: 'naming', url: null, codeRequested: false,
    identity: { email: 'dwight@example.com', subscription: 'pro' },
    suggestedName: 'claude-dwight', error: null,
  });
  assert.equal(v.showNameForm, true);
  assert.equal(v.suggestedName, 'claude-dwight');
  assert.match(v.identityLine, /dwight@example\.com/);
  assert.match(v.identityLine, /pro/i);
});

test('linkView names the account plainly when the provider exposed no identity', () => {
  const v = linkView({
    provider: 'codex', phase: 'naming', url: null, codeRequested: false,
    identity: null, suggestedName: 'codex', error: null,
  });
  assert.equal(v.showNameForm, true);
  assert.equal(v.suggestedName, 'codex');
  assert.match(v.identityLine, /Codex/);
});

test('linkView surfaces an error and hides every input', () => {
  const v = linkView({
    provider: 'claude', phase: 'error', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: 'The sign-in timed out.',
  });
  assert.equal(v.error, 'The sign-in timed out.');
  assert.equal(v.showUrl, false);
  assert.equal(v.showCodeBox, false);
  assert.equal(v.showNameForm, false);
});

// C2: a failed link still holds a (settled) pending server-side until
// something clears it. app.js keeps #link-cancel visible in every phase and
// relabels it from this field — pinning the label here means the dismiss
// behaviour is tested even though no test in this suite renders the DOM.
test('linkView relabels the cancel control to Dismiss once the link has failed', () => {
  const error = linkView({
    provider: 'claude', phase: 'error', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: 'The sign-in timed out.',
  });
  assert.equal(error.cancelLabel, 'Dismiss');

  const starting = linkView({
    provider: 'claude', phase: 'starting', url: null, codeRequested: false,
    identity: null, suggestedName: null, error: null,
  });
  assert.equal(starting.cancelLabel, 'Cancel sign-in');
});
