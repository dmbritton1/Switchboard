// Records one real Claude session's SDK messages to a fixture file.
// Usage: node scripts/record-claude.ts <out.json>
import { writeFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const out = process.argv[2] ?? 'test/fixtures/claude-basic.json';
const messages: unknown[] = [];

const q = query({
  prompt: 'Run the shell command `echo switchboard`, then reply with only the word done.',
  options: { cwd: process.cwd(), permissionMode: 'bypassPermissions' },
});

for await (const m of q) messages.push(m);

await writeFile(out, JSON.stringify(messages, null, 2));
console.log(`recorded ${messages.length} messages to ${out}`);
