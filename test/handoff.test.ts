import { test } from 'node:test';
import assert from 'node:assert';
import { renderHandoff, HANDOFF_FILE, HANDOFF_PROMPT } from '../src/handoff.ts';
import type { Session } from '../src/types.ts';

function session(transcript: Session['transcript']): Session {
  return {
    id: 'sess-1', provider: 'claude', account: 'claude-main', vendorSessionId: null,
    repo: '/repo', cwd: '/repo/.claude/worktrees/feat-x', branch: 'feat/x', title: 'feat/x',
    status: 'stopped', auto: false, lastUsage: null, transcript, pending: null,
    stoppedReason: null, stoppedCode: null, startedAt: 0, statusSince: 0,
  };
}

test('renderHandoff names the source session in its header', () => {
  const out = renderHandoff(session([]));
  assert.match(out, /# Handoff from `feat\/x`/);
  assert.match(out, /claude-main/);
});

test('renderHandoff keeps prompts, agent prose, todos and errors', () => {
  const out = renderHandoff(session([
    { kind: 'user', id: 'u1', text: 'add a retry', delivery: 'sent' },
    { kind: 'text', text: 'I added a retry to the fetch helper.' },
    { kind: 'todo', id: 't1', items: [
      { text: 'write the test', completed: true },
      { text: 'wire it up', completed: false },
    ] },
    { kind: 'error', text: 'the process exited with code 1' },
  ]));
  assert.match(out, /## You said\n\nadd a retry/);
  assert.match(out, /I added a retry to the fetch helper\./);
  assert.match(out, /- \[x\] write the test/);
  assert.match(out, /- \[ \] wire it up/);
  assert.match(out, /\*\*Error:\*\* the process exited with code 1/);
});

test('renderHandoff inlines held tool detail and marks evicted detail', () => {
  const out = renderHandoff(session([
    { kind: 'tool', id: 'a', name: 'Read', summary: 'src/foo.ts', status: 'ok',
      detail: 'export const foo = 1;' },
    { kind: 'tool', id: 'b', name: 'Bash', summary: 'npm test', status: 'error',
      detailEvicted: true },
  ]));
  assert.match(out, /- \*\*Read\*\* src\/foo\.ts — ok/);
  assert.match(out, /export const foo = 1;/);
  assert.match(out, /- \*\*Bash\*\* npm test — error/);
  assert.match(out, /_\[detail evicted\]_/);
});

test('renderHandoff never emits reasoning', () => {
  const out = renderHandoff(session([
    { kind: 'reasoning', id: 'r1', text: 'the user probably wants a mutex here' },
    { kind: 'text', text: 'Done.' },
  ]));
  assert.doesNotMatch(out, /mutex/);
  assert.match(out, /Done\./);
});

test('the opening prompt points the successor at the handoff file', () => {
  assert.equal(HANDOFF_FILE, '.switchboard/handoff.md');
  assert.match(HANDOFF_PROMPT, /\.switchboard\/handoff\.md/);
  assert.match(HANDOFF_PROMPT, /git log/);
});
