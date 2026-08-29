import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFakeLoginCli } from './helpers/fake-login.ts';

function collect(
  bin: string, args: string[], env: Record<string, string>, stdin?: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the claude fake prints its URL on stdout and waits for a code', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'claude' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['auth', 'login'], { CLAUDE_CONFIG_DIR: home }, 'good-code\n');
  assert.equal(r.code, 0);
  assert.match(r.out, /https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.match(r.out, /Paste code here/);
  assert.ok(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).oauthAccount.emailAddress);
  await rm(d, { recursive: true, force: true });
});

test('the codex fake prints its URL on stderr and needs no code', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'codex' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['login'], { CODEX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(r.err, /https:\/\/auth\.openai\.com\/oauth\/authorize/);
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  assert.ok(auth.tokens.id_token);
  await rm(d, { recursive: true, force: true });
});

test('a bad code exits nonzero and writes no credentials', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'claude', mode: 'bad-code' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['auth', 'login'], { CLAUDE_CONFIG_DIR: home }, 'whatever\n');
  assert.equal(r.code, 1);
  await assert.rejects(() => readFile(join(home, '.claude.json'), 'utf8'));
  await rm(d, { recursive: true, force: true });
});

test('email: null produces an api-key style auth.json with no id_token', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'codex', email: null });
  const home = join(d, 'cfg');
  await collect(bin, ['login'], { CODEX_HOME: home });
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  assert.equal(auth.tokens.id_token, undefined);
  assert.equal(auth.auth_mode, 'apikey');
  await rm(d, { recursive: true, force: true });
});

test('claude no-prompt completes without ever asking for a code', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'claude', mode: 'no-prompt' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['auth', 'login'], { CLAUDE_CONFIG_DIR: home });
  assert.equal(r.code, 0);
  assert.match(r.out, /https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.doesNotMatch(r.out, /Paste code here/);
  assert.ok(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).oauthAccount.emailAddress);
  await rm(d, { recursive: true, force: true });
});

test('codex slow keeps the URL on stderr, never stdout', async () => {
  const d = await mkdtemp(join(tmpdir(), 'fake-login-'));
  const bin = await writeFakeLoginCli(d, { provider: 'codex', mode: 'slow' });
  const home = join(d, 'cfg');
  const r = await collect(bin, ['login'], { CODEX_HOME: home });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(r.err, /https:\/\/auth\.openai\.com\/oauth\/authorize/);
  await rm(d, { recursive: true, force: true });
});
