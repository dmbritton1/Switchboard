import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeFakeCodex(
  dir: string,
  options: {
    version?: string;
    login?: 'ready' | 'logged-out' | 'unsupported';
  } = {},
): Promise<string> {
  const path = join(dir, 'fake-codex');
  const version = options.version ?? '0.145.0';
  const login = options.login ?? 'ready';
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const mode = ${JSON.stringify(login)};
  if (mode === 'ready') {
    process.stdout.write('Logged in using ChatGPT\\n');
    process.exit(0);
  }
  if (mode === 'unsupported') {
    process.stderr.write('error: unrecognized subcommand status\\n');
    process.exit(2);
  }
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
process.stderr.write('unexpected invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
