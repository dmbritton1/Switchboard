import assert from 'node:assert';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CodexRuntimeError,
  prepareCodexRuntime,
  redactCodexText,
} from '../src/agents/codex-runtime.ts';
import { writeFakeCodex } from './helpers/fake-codex.ts';

async function fixture(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-codex-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof CodexRuntimeError && error.code === code;
}

test('an explicit compatible executable is authoritative', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);

  const runtime = await prepareCodexRuntime(
    { bin, env: { CODEX_HOME: join(dir, 'codex-home') } },
    { platform: 'darwin', sdkVersion: '0.145.0' },
  );

  assert.equal(runtime.source, 'explicit');
  assert.equal(runtime.commandPath, bin);
  assert.equal(runtime.codexPathOverride, bin);
  assert.equal(runtime.version, '0.145.0');
  assert.equal(runtime.env.CODEX_HOME, join(dir, 'codex-home'));
});

test('an explicit version mismatch fails closed', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir, { version: '0.146.0' });

  await assert.rejects(
    prepareCodexRuntime({ bin, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    expectCode('codex_version_mismatch'),
  );
});

test('an incompatible ChatGPT.app candidate falls back to the SDK CLI', async (t) => {
  const dir = await fixture(t);
  const appDir = join(dir, 'app');
  await mkdir(appDir);
  const chatgptPath = await writeFakeCodex(appDir, { version: '0.146.0' });
  const bundledDir = join(dir, 'bundled');
  await mkdir(bundledDir);
  const bundledPath = await writeFakeCodex(bundledDir);

  const runtime = await prepareCodexRuntime(
    { env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0', chatgptPath, bundledPath },
  );

  assert.equal(runtime.source, 'sdk');
  assert.equal(runtime.commandPath, bundledPath);
  assert.equal(runtime.codexPathOverride, undefined);
  assert.match(runtime.diagnostics.join('\n'), /ChatGPT.*0\.146\.0.*0\.145\.0/);
});

test('a non-darwin host fails before resolving a binary', async () => {
  await assert.rejects(
    prepareCodexRuntime({ env: {} }, { platform: 'linux', sdkVersion: '0.145.0' }),
    expectCode('codex_platform_unsupported'),
  );
});

test('a missing explicit binary fails closed', async (t) => {
  const dir = await fixture(t);

  await assert.rejects(
    prepareCodexRuntime({ bin: join(dir, 'missing'), env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    expectCode('codex_binary_missing'),
  );
});

test('an explicit directory is not executable', async (t) => {
  const dir = await fixture(t);

  await assert.rejects(
    prepareCodexRuntime({ bin: dir, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    expectCode('codex_binary_not_executable'),
  );
});

test('a non-executable explicit file fails closed', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);
  await chmod(bin, 0o644);

  await assert.rejects(
    prepareCodexRuntime({ bin, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    expectCode('codex_binary_not_executable'),
  );
});

test('an explicit binary with an unreadable version fails closed', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);

  await assert.rejects(
    prepareCodexRuntime({ bin, env: {} }, {
      platform: 'darwin', sdkVersion: '0.145.0',
      runFile: async () => ({ stdout: 'not a Codex version', stderr: '' }),
    }),
    expectCode('codex_version_unreadable'),
  );
});

test('a wedged version preflight times out with the version readiness code', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);

  await assert.rejects(
    prepareCodexRuntime({ bin, env: { CODEX_TOKEN: 'version-secret' } }, {
      platform: 'darwin', sdkVersion: '0.145.0', preflightTimeoutMs: 25,
      runFile: async () => new Promise<never>(() => {}),
    }),
    (error: unknown) => error instanceof CodexRuntimeError
      && error.code === 'codex_version_unreadable'
      && /version check timed out/i.test(error.message)
      && !error.message.includes('version-secret'),
  );
});

test('semver build metadata does not make a compatible explicit binary mismatch', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir, { version: '0.145.0+local.build' });

  const runtime = await prepareCodexRuntime(
    { bin, env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0+sdk.build' },
  );

  assert.equal(runtime.version, '0.145.0+local.build');
});

test('a logged-out explicit binary reports authentication unavailable', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir, { login: 'logged-out' });

  await assert.rejects(
    prepareCodexRuntime({ bin, env: {} }, { platform: 'darwin', sdkVersion: '0.145.0' }),
    expectCode('codex_auth_unavailable'),
  );
});

test('a wedged login preflight times out with the authentication readiness code', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);

  await assert.rejects(
    prepareCodexRuntime({ bin, env: { CODEX_TOKEN: 'login-secret' } }, {
      platform: 'darwin', sdkVersion: '0.145.0', preflightTimeoutMs: 25,
      runFile: async (_file, args) => args.includes('--version')
        ? { stdout: 'codex-cli 0.145.0\n', stderr: '' }
        : new Promise<never>(() => {}),
    }),
    (error: unknown) => error instanceof CodexRuntimeError
      && error.code === 'codex_auth_unavailable'
      && /authentication check timed out/i.test(error.message)
      && !error.message.includes('login-secret'),
  );
});

test('an unsupported login-status command defers authentication validation', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir, { login: 'unsupported' });

  const runtime = await prepareCodexRuntime(
    { bin, env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0' },
  );

  assert.match(runtime.diagnostics.join('\n'), /login status.*unsupported/i);
});

test('a compatible ChatGPT.app binary is selected before the SDK fallback', async (t) => {
  const dir = await fixture(t);
  const appDir = join(dir, 'app');
  const bundledDir = join(dir, 'bundled');
  await Promise.all([mkdir(appDir), mkdir(bundledDir)]);
  const chatgptPath = await writeFakeCodex(appDir);
  const bundledPath = await writeFakeCodex(bundledDir, { version: '0.146.0' });

  const runtime = await prepareCodexRuntime(
    { env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0', chatgptPath, bundledPath },
  );

  assert.equal(runtime.source, 'chatgpt');
  assert.equal(runtime.commandPath, chatgptPath);
  assert.equal(runtime.codexPathOverride, chatgptPath);
});

test('the SDK CLI is selected when no ChatGPT.app candidate is available', async (t) => {
  const dir = await fixture(t);
  const bundledDir = join(dir, 'bundled');
  await mkdir(bundledDir);
  const bundledPath = await writeFakeCodex(bundledDir);

  const runtime = await prepareCodexRuntime(
    { env: {} },
    { platform: 'darwin', sdkVersion: '0.145.0', chatgptPath: join(dir, 'absent'), bundledPath },
  );

  assert.equal(runtime.source, 'sdk');
  assert.equal(runtime.commandPath, bundledPath);
  assert.equal(runtime.codexPathOverride, undefined);
});

test('the production default reads the installed SDK version', async (t) => {
  const dir = await fixture(t);
  const bundledDir = join(dir, 'bundled');
  await mkdir(bundledDir);
  const bundledPath = await writeFakeCodex(bundledDir);

  const runtime = await prepareCodexRuntime(
    { env: {} },
    { platform: 'darwin', chatgptPath: join(dir, 'absent'), bundledPath },
  );

  assert.equal(runtime.version, '0.145.0');
});

test('an invalid account environment shape fails without leaking its contents', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);

  await assert.rejects(
    prepareCodexRuntime({ bin, env: { CODEX_TOKEN: 123 } as unknown as Record<string, string> }, {
      platform: 'darwin', sdkVersion: '0.145.0',
    }),
    (error: unknown) =>
      error instanceof CodexRuntimeError
      && error.code === 'codex_start_failed'
      && !error.message.includes('123'),
  );
});

test('login status receives the same merged environment returned by the runtime', async (t) => {
  const dir = await fixture(t);
  const bin = await writeFakeCodex(dir);
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];

  const runtime = await prepareCodexRuntime(
    { bin, env: { CODEX_HOME: join(dir, 'home'), SAFE_FLAG: 'yes' } },
    {
      platform: 'darwin', sdkVersion: '0.145.0',
      runFile: async (_file, args, options) => {
        calls.push({ args, env: options.env });
        return args.includes('--version')
          ? { stdout: 'codex-cli 0.145.0\n', stderr: '' }
          : { stdout: 'Logged in using ChatGPT\n', stderr: '' };
      },
    },
  );

  assert.deepEqual(calls.map((call) => call.args), [['--version'], ['login', 'status']]);
  assert.deepEqual(calls[1].env, runtime.env);
});

test('redaction removes bearer tokens and credential-shaped environment values', () => {
  assert.equal(
    redactCodexText('Bearer abc123 failed with super-secret', { CODEX_TOKEN: 'abc123', CUSTOM_SECRET: 'super-secret' }),
    'Bearer [REDACTED] failed with [REDACTED]',
  );
});
