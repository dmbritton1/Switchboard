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
