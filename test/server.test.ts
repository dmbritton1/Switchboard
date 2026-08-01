import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { Registry } from '../src/sessions.ts';
import { Usage } from '../src/usage.ts';
import { Scheduler } from '../src/schedule.ts';
import { createServer } from '../src/server.ts';
import { createWorktree } from '../src/worktree.ts';

const run = promisify(execFile);

// `fetch` implements the Fetch spec's forbidden-header-name list, which includes
// `Host` — there is no way to send a spoofed Host header through fetch(). node:http's
// request() has no such restriction, so the Host-guard tests below use it directly.
function rawRequest(
  url: URL,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: opts.method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const accounts = [
  { name: 'claude-main', provider: 'claude' as const, budget: 1000, env: {} },
  { name: 'codex', provider: 'codex' as const, budget: 1000, env: {} },
];

async function boot(t: { after: (fn: () => void) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const registry = new Registry(join(dir, 'state.json'));
  const usage = new Usage();
  const scheduler = new Scheduler();
  const server = createServer({ registry, usage, scheduler, accounts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  t.after(() => { server.close(); return rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, registry, usage, scheduler, server };
}

test('GET / serves the app shell', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /<title>Switchboard<\/title>/);
});

test('GET /events opens an SSE stream with an immediate snapshot', async (t) => {
  const { base, registry } = await boot(t);
  registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'a title',
  });

  const res = await fetch(`${base}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');

  const reader = res.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^data: /m);
  const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].title, 'a title');
  assert.equal(payload.accounts[0].name, 'claude-main');
  await reader.cancel();
});

test('POST /command with an unknown cmd is a 400', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'nonsense' }),
  });
  assert.equal(res.status, 400);
});

test('POST /command create rejects a repo that is not a git repo', async (t) => {
  const { base, registry } = await boot(t);
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({
      cmd: 'create', repo: '/definitely/not/a/repo',
      branch: 'x', account: 'claude-main', prompt: 'hi',
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a git repository/i);
  assert.equal(registry.all().length, 0, 'no orphan session may be created');
});

test('POST /command with a mismatched Origin is rejected and has no effect', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(registry.all().length, 1, 'a rejected request must not have deleted the session');
});

test('POST /command with a foreign Host is rejected and has no effect', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await rawRequest(new URL(`${base}/command`), {
    method: 'POST',
    headers: { host: 'evil.example:9999', 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 403);
  assert.equal(registry.all().length, 1, 'a rejected request must not have deleted the session');
});

test('GET /events with a foreign Host is rejected', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/events`), {
    method: 'GET',
    headers: { host: 'evil.example:9999' },
  });
  assert.equal(res.status, 403);
});

test('GET /repos with a foreign Host is rejected', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/repos`), {
    method: 'GET',
    headers: { host: 'evil.example:9999' },
  });
  assert.equal(res.status, 403, '/repos returns decoded local repo paths; it needs the guard too');
});

test('POST /command send to a session with no live agent is not a 200', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'exit 1' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'send', id: s.id, text: 'hi' }),
  });
  assert.equal(res.status, 404, 'a 200 here means the prompt was silently dropped');
  assert.deepEqual(registry.get(s.id)!.transcript, [], 'and nothing was appended');
});

test('POST /command resume is rejected unless the session is stopped', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  assert.equal(registry.get(s.id)!.status, 'working');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'resume', id: s.id }),
  });
  assert.equal(res.status, 409, 'resume must not launch a second agent into a live worktree');
  assert.equal(registry.get(s.id)!.status, 'working', 'and must not have revived anything');
});

test('POST /command delete removes the session', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'delete', id: s.id, removeWorktree: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(registry.all().length, 0);
});

// ---- merge / push --------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('POST /command merge rejects worktrees selected from two different repos', async (t) => {
  const { base, registry } = await boot(t);
  const a = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-a',
    cwd: '/repo-a/wt', branch: 'x', title: 'x',
  });
  const b = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-b',
    cwd: '/repo-b/wt', branch: 'y', title: 'y',
  });
  registry.apply(a.id, { type: 'stopped', reason: 'done' });
  registry.apply(b.id, { type: 'stopped', reason: 'done' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [a.id, b.id] }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /different repos/i);
});

test('POST /command merge rejects a session that is still working', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  assert.equal(registry.get(s.id)!.status, 'working');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [s.id] }),
  });

  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /still running/i);
});

test('POST /command push rejects worktrees selected from two different repos', async (t) => {
  const { base, registry } = await boot(t);
  const a = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-a',
    cwd: '/repo-a/wt', branch: 'x', title: 'x',
  });
  const b = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/repo-b',
    cwd: '/repo-b/wt', branch: 'y', title: 'y',
  });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'push', ids: [a.id, b.id] }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /different repos/i);
});

test('POST /command merge then push: end to end against a real repo and remote', async (t) => {
  const { base, registry } = await boot(t);
  const repo = await makeRepo();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const remote = await mkdtemp(join(tmpdir(), 'sb-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await run('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
  await run('git', ['remote', 'add', 'origin', remote], { cwd: repo });

  const cwd = await createWorktree(repo, 'feat/ship');
  await writeFile(join(cwd, 'ship.txt'), 'payload\n');
  // Left uncommitted on purpose: merge is supposed to pick up outstanding work.

  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo, cwd, branch: 'feat/ship', title: 'feat/ship',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });

  const mergeRes = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'merge', ids: [s.id] }),
  });
  assert.equal(mergeRes.status, 200);
  const mergeBody = await mergeRes.json();
  assert.deepEqual(mergeBody.merged, ['feat/ship']);
  assert.equal(mergeBody.target, 'main');

  const pushRes = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'push', ids: [s.id] }),
  });
  assert.equal(pushRes.status, 200);

  // `cwd: remote` would fail here: git refuses to run inside a bare repo via
  // plain cwd discovery (safe.bareRepository) unless told explicitly.
  const { stdout } = await run('git', ['--git-dir=' + remote, 'show', 'main:ship.txt']);
  assert.equal(stdout, 'payload\n', 'the merged file should have reached the remote');
});

test('POST /upload writes the file into the session worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const res = await fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST',
    body: 'hello file',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: 'uploads/notes.txt' });
  assert.equal(await readFile(join(wt, 'uploads', 'notes.txt'), 'utf8'), 'hello file');
});

test('POST /upload rejects a filename that escapes the worktree', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });
  // Unique so a leftover file from an earlier run can never make this pass.
  const escapee = `escaped-${s.id}.txt`;

  const res = await fetch(
    `${base}/upload?id=${s.id}&name=${encodeURIComponent(`../${escapee}`)}`,
    { method: 'POST', body: 'pwned' },
  );

  assert.equal(res.status, 400);
  await assert.rejects(
    stat(join(dirname(wt), escapee)),
    'a rejected name must not have written anything outside the worktree',
  );
});

test('POST /upload refuses to follow a symlinked uploads directory', async (t) => {
  const { base, registry } = await boot(t);
  const wt = await mkdtemp(join(tmpdir(), 'sb-wt-'));
  t.after(() => rm(wt, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'sb-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  // Simulates a tracked symlink materialized by `git worktree add` from an
  // untrusted branch: uploads/ points somewhere outside the worktree entirely.
  await symlink(outside, join(wt, 'uploads'));
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: wt, branch: 'b', title: 't',
  });

  const res = await fetch(`${base}/upload?id=${s.id}&name=notes.txt`, {
    method: 'POST',
    body: 'pwned',
  });

  assert.equal(res.status, 400);
  await assert.rejects(
    stat(join(outside, 'notes.txt')),
    'a refused upload must not have written anything into the symlink target',
  );
});

test('POST /command auto sets the flag on a stopped session, which has no live handle', async (t) => {
  const { base, registry } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });
  assert.equal(registry.get(s.id)!.auto, false, 'sessions start off, not on');

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'auto', id: s.id, auto: true }),
  });

  assert.equal(res.status, 200);
  // The point of setting it registry-side: no handle exists here, and the flag
  // still has to stick so the next resume() launches with auto already on.
  assert.equal(registry.get(s.id)!.auto, true);
});

test('GET /graph returns the laid-out commits for a session', async (t) => {
  const { base, registry } = await boot(t);
  const dir = await mkdtemp(join(tmpdir(), 'sb-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await run('git', ['init', '-b', 'main'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  await run('git', ['config', 'user.name', 'T'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: dir });
  await run('git', ['commit', '-m', 'init'], { cwd: dir });

  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: dir,
    cwd: dir, branch: 'main', title: 't',
  });

  const res = await fetch(`${base}/graph?id=${s.id}`);
  assert.equal(res.status, 200);
  const commits = await res.json();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, 'init');
  assert.equal(commits[0].lane, 0);
  assert.ok(commits[0].refs.includes('HEAD -> main'));
});

test('GET /graph for an unknown session is a 404, not a crash', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/graph?id=nope`);
  assert.equal(res.status, 404);
});

test('GET /graph is behind the Host guard like every other route', async (t) => {
  const { base } = await boot(t);
  const res = await rawRequest(new URL(`${base}/graph?id=nope`), {
    method: 'GET', headers: { Host: 'evil.example' },
  });
  assert.equal(res.status, 403);
});

// ---- schedule / unschedule ------------------------------------------------

function post(base: string, body: unknown) {
  return fetch(`${base}/command`, { method: 'POST', body: JSON.stringify(body) });
}

test('scheduling a create returns an id and puts it in the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).id);
  assert.equal(scheduler.all().length, 1);
});

test('a reset trigger takes its account from the action, not the client', async (t) => {
  const { base, scheduler } = await boot(t);
  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'codex', prompt: 'go' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
});

test('scheduling rejects an unknown account', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'nope', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown account/);
});

test('scheduling rejects a repo that is not a directory', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'create', repo: '/no/such/place', branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a directory/);
});

test('scheduling rejects a non-numeric time', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: 'tomorrow' },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /timestamp/);
});

// Number(t.time) would happily coerce [] -> 0 and null -> 0 into a "valid"
// finite timestamp, scheduling a nonsense-time item instead of rejecting the
// request. A typeof guard is the only thing standing between this and a
// silently-accepted garbage trigger.
test('scheduling rejects a time that is coercible to a number but is not one', async (t) => {
  const { base } = await boot(t);
  for (const time of [[], null, [5000]]) {
    const res = await post(base, {
      cmd: 'schedule',
      trigger: { kind: 'at', time },
      action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
    });
    assert.equal(res.status, 400, `time=${JSON.stringify(time)} must be rejected`);
    assert.match((await res.json()).error, /timestamp/);
  }
});

// String({}) is the non-empty, non-blank string '[object Object]' — it would
// sail past a truthiness check and get scheduled as a real branch name or
// prompt body. A typeof guard rejects the wrong-shaped field outright.
test('scheduling rejects an object-valued branch or prompt', async (t) => {
  const { base } = await boot(t);
  const at = { kind: 'at', time: Date.now() };

  const badBranch = await post(base, {
    cmd: 'schedule', trigger: at,
    action: { kind: 'create', repo: process.cwd(), branch: {}, account: 'claude-main', prompt: 'go' },
  });
  assert.equal(badBranch.status, 400);
  assert.match((await badBranch.json()).error, /branch/);

  const badPrompt = await post(base, {
    cmd: 'schedule', trigger: at,
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: {} },
  });
  assert.equal(badPrompt.status, 400);
  assert.match((await badPrompt.json()).error, /prompt/);
});

test('scheduling rejects an empty prompt and a missing branch', async (t) => {
  const { base } = await boot(t);
  const at = { kind: 'at', time: Date.now() };
  const base_ = { repo: process.cwd(), account: 'claude-main' };

  const noPrompt = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: 'b', prompt: '  ' },
  });
  assert.equal(noPrompt.status, 400);

  const noBranch = await post(base, {
    cmd: 'schedule', trigger: at, action: { kind: 'create', ...base_, branch: '', prompt: 'go' },
  });
  assert.equal(noBranch.status, 400);
});

test('scheduling a send rejects an unknown session', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() },
    action: { kind: 'send', sessionId: 'nope', text: 'hi' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no such session/);
});

// The other half of the design guarantee: a reset trigger on a send/resume
// action takes its account from the target session, not from the client —
// same rule as the create case, covered here so it isn't only proven for one
// of the two action shapes that can carry a reset trigger.
test('a reset trigger on a send takes its account from the target session, not the client', async (t) => {
  const { base, registry, scheduler } = await boot(t);
  const s = registry.create({
    provider: 'codex', account: 'codex', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 't',
  });

  await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'reset', account: 'attacker-supplied' },
    action: { kind: 'send', sessionId: s.id, text: 'hi' },
  });
  assert.deepEqual(scheduler.all()[0].trigger, { kind: 'reset', account: 'codex' });
});

test('unschedule removes the item', async (t) => {
  const { base, scheduler } = await boot(t);
  const { id } = await (await post(base, {
    cmd: 'schedule',
    trigger: { kind: 'at', time: Date.now() + 3600_000 },
    action: { kind: 'create', repo: process.cwd(), branch: 'b', account: 'claude-main', prompt: 'go' },
  })).json();

  const res = await post(base, { cmd: 'unschedule', itemId: id });
  assert.equal(res.status, 200);
  assert.equal(scheduler.all().length, 0);
});

test('the SSE snapshot carries the queue', async (t) => {
  const { base, scheduler } = await boot(t);
  scheduler.add({ kind: 'at', time: 1 }, {
    kind: 'create', repo: '/r', branch: 'b', account: 'claude-main', prompt: 'go',
  });

  const res = await fetch(`${base}/events`);
  const reader = res.body!.getReader();
  // try/finally, not a bare await at the end: if the assertion throws, an
  // uncancelled reader leaves the SSE fetch open, and boot()'s t.after
  // (server.close()) waits for that connection to end before it resolves —
  // node:test's after-hooks run in registration order (FIFO), so a t.after
  // registered here would run after boot()'s and still hang. finally runs
  // synchronously as the test unwinds, before any after-hook, so the
  // connection is always closed and a failure reports instead of hanging.
  try {
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const payload = JSON.parse(chunk.replace(/^data: /, '').trim());
    assert.equal(payload.queue.length, 1);
  } finally {
    await reader.cancel();
  }
});

test('POST /command resume on a session whose worktree is gone reports that, not an SDK error', async (t) => {
  const { base, registry } = await boot(t);
  const gone = join(tmpdir(), `sb-not-here-${Date.now()}`);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: gone, branch: 'b', title: 't',
  });
  registry.apply(s.id, { type: 'stopped', reason: 'done' });

  const res = await fetch(`${base}/command`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'resume', id: s.id }),
  });

  assert.equal(res.status, 409);
  // Spawning into a missing cwd surfaces as a bogus "native binary does not
  // match this platform" from the SDK, which sends you debugging the wrong thing.
  assert.match((await res.json()).error, /worktree is gone/);
  assert.equal(registry.get(s.id)!.status, 'stopped', 'and the session must not have been revived');
});

test('a due item fires through command() and leaves the queue', async (t) => {
  const { base, registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // A `send` to a session with no live agent is a 404 from command(), which is
  // exactly the failure path we want to observe — no agent is spawned in tests.
  const item = scheduler.add({ kind: 'at', time: Date.now() - 1000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed');
  assert.match(scheduler.all()[0].error ?? '', /no live session/);
  assert.equal(scheduler.all()[0].id, item.id, 'a failed item stays visible, it is not dropped');
});

test('an item whose time has not come is left alone', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  scheduler.add({ kind: 'at', time: Date.now() + 3600_000 }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');
});

test('a reset item does not fire while its account is rate limited', async (t) => {
  const { registry, scheduler, server, usage } = await boot(t);
  const s = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'b', title: 'b',
  });
  // registry.create() starts a session `working`, which would make the account
  // busy() and block the item for the wrong reason. Park it first so the only
  // thing under test is the rate limit.
  registry.apply(s.id, { type: 'stopped', reason: 'parked for the test' });
  usage.noteLimit('claude-main', 'rejected', Date.now() + 3600_000);
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: s.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  usage.noteLimit('claude-main', 'allowed', null);
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'it fired once the limit cleared');
});

test('a reset item waits while its account has a working session', async (t) => {
  const { registry, scheduler, server } = await boot(t);
  const busy = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt', branch: 'busy', title: 'busy',
  });
  assert.equal(busy.status, 'working', 'created sessions start working');

  const target = registry.create({
    provider: 'claude', account: 'claude-main', repo: '/r',
    cwd: '/r/wt2', branch: 'b', title: 'b',
  });
  // Park the target, so `busy` is true because of the *other* session and the
  // test can't pass for the wrong reason.
  registry.apply(target.id, { type: 'stopped', reason: 'parked for the test' });
  scheduler.add({ kind: 'reset', account: 'claude-main' }, {
    kind: 'send', sessionId: target.id, text: 'hello',
  });

  await server.tick();
  assert.equal(scheduler.all()[0].state, 'waiting');

  // Retire the busy session and it goes through.
  registry.apply(busy.id, { type: 'stopped', reason: 'done' });
  await server.tick();
  assert.equal(scheduler.all()[0].state, 'failed', 'fired once the account went idle');
});
