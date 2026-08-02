import { test } from 'node:test';
import assert from 'node:assert';
import {
  sortSessions, cardAction, selectionState, triggerLabel, targetLabel,
  transcriptView, detailKey, requestOnce, needsDetailFetch, detailPresentation,
  fetchToolDetail, createDetailController, changeDetailSession, setDetailExpanded,
  detailControllerView, storeToolDetail, storeToolDetailError, invalidateToolDetail,
} from '../web/lib.js';

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
    kind: 'tool', id: 'ok', name: 'edit',
    summary: '/Users/operator/project/src/a.ts, /private/tmp/project/src/b.ts', status: 'ok',
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

test('transcriptView never exposes absolute file-change paths and preserves other tool summaries', () => {
  const edit = transcriptView({
    kind: 'tool', id: 'edit-1', name: 'edit',
    summary: '/Users/operator/secret-one.ts, /opt/project/secret-two.ts', status: 'running',
    detailAvailable: false, detailEvicted: false,
    detailRevision: 0, detailTruncated: false,
  });
  assert.equal(edit.summary, 'edit: 2 files');
  assert.doesNotMatch(edit.summary, /Users|operator|opt|secret/);
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
