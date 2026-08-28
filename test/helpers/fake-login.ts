import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A fake `claude` / `codex` executable for link tests. Mirrors
 * helpers/fake-codex.ts: a real script run through a real process boundary, so
 * stream parsing, stdin relay and exit handling are genuinely exercised.
 *
 * It never binds a port and never opens a browser — the real `codex login`
 * starts a server on 1455, and a test that did the same could not run offline
 * or in parallel.
 */
export async function writeFakeLoginCli(
  dir: string,
  options: {
    provider?: 'claude' | 'codex';
    mode?: 'ok' | 'no-prompt' | 'bad-code' | 'no-url' | 'slow';
    email?: string | null;
  } = {},
): Promise<string> {
  const provider = options.provider ?? 'claude';
  const mode = options.mode ?? 'ok';
  const email = options.email === undefined ? 'user@example.com' : options.email;
  const path = join(dir, `fake-${provider}-login`);

  const url = provider === 'claude'
    ? 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=abc'
    : 'https://auth.openai.com/oauth/authorize?client_id=fake&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc';

  const source = `#!/usr/bin/env node
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const provider = ${JSON.stringify(provider)};
const mode = ${JSON.stringify(mode)};
const email = ${JSON.stringify(email)};
const url = ${JSON.stringify(url)};

const home = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function writeCredentials() {
  mkdirSync(home, { recursive: true });
  if (provider === 'claude') {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      oauthAccount: email ? { emailAddress: email } : {},
    }));
    return;
  }
  const tokens = email === null
    ? { access_token: 'fake-access', account_id: 'acct_fake' }
    : { id_token: 'h.' + b64url({ email, email_verified: true }) + '.sig',
        access_token: 'fake-access', account_id: 'acct_fake' };
  writeFileSync(join(home, 'auth.json'), JSON.stringify({
    auth_mode: email === null ? 'apikey' : 'chatgpt',
    tokens,
    last_refresh: '2026-08-28T00:00:00Z',
  }));
}

// --- status / logout -------------------------------------------------------
if (provider === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    ...(email ? { email } : {}), subscriptionType: 'pro',
  }) + '\\n');
  process.exit(0);
}
if (provider === 'codex' && args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (args.includes('logout')) process.exit(0);

// --- login -----------------------------------------------------------------
const isLogin = provider === 'claude'
  ? args[0] === 'auth' && args[1] === 'login'
  : args[0] === 'login';
if (!isLogin) {
  process.stderr.write('unexpected invocation: ' + args.join(' ') + '\\n');
  process.exit(2);
}
if (!home) {
  process.stderr.write('missing credential dir env\\n');
  process.exit(2);
}

if (mode === 'no-url') {
  // Emits a decoy on a host the scraper must ignore, then hangs.
  process.stdout.write('visit https://example.com/not-oauth for help\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'slow') {
  setTimeout(() => {
    process.stdout.write(url + '\\n');
    writeCredentials();
    process.exit(0);
  }, 2000);
} else if (provider === 'codex') {
  process.stderr.write('Starting local login server on http://localhost:1455.\\n');
  process.stderr.write('If your browser did not open, navigate to this URL:\\n\\n' + url + '\\n');
  writeCredentials();
  process.exit(0);
} else {
  process.stdout.write('Opening browser to sign in\\u2026\\n');
  process.stdout.write("If the browser didn't open, visit: " + url + '\\n');
  if (mode === 'no-prompt') {
    writeCredentials();
    process.exit(0);
  }
  process.stdout.write('Paste code here if prompted > ');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const line = buf.split('\\n')[0];
    if (!buf.includes('\\n')) return;
    if (mode === 'bad-code' || line.trim() !== 'good-code') {
      process.stderr.write('invalid authorization code\\n');
      process.exit(1);
    }
    writeCredentials();
    process.exit(0);
  });
}
`;

  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
