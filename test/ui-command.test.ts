import { test } from 'node:test';
import assert from 'node:assert';
import {
  CODEX_FAILURE_LABEL, commandErrorText, commandFailure, postCommand, retainedSessionError,
} from '../web/lib.js';

test('every stable Codex failure has a user-facing label', () => {
  assert.deepEqual(Object.keys(CODEX_FAILURE_LABEL).sort(), [
    'codex_auth_unavailable', 'codex_binary_missing',
    'codex_binary_not_executable', 'codex_platform_unsupported',
    'codex_resume_failed', 'codex_sandbox_denied', 'codex_start_failed',
    'codex_stream_failed', 'codex_user_stopped',
    'codex_version_mismatch', 'codex_version_unreadable',
  ]);
});

test('a session failure is retained with the session that caused it', async () => {
  const result = await postCommand(
    { cmd: 'send', id: 's1' },
    async () => new Response(JSON.stringify({ error: 'send refused' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.deepEqual(retainedSessionError('s1', result), {
    sessionId: 's1', message: 'send refused',
  });
  assert.equal(retainedSessionError('s1', { ok: true, status: 200, data: {} }), null);
});

test('network failures become visible command errors', async () => {
  const result = await postCommand(
    { cmd: 'send' },
    async () => { throw new Error('connection closed'); },
  );
  assert.equal(commandFailure(result), 'Switchboard request failed: connection closed');
});

test('a cross-session error stays visible and names the session it came from', () => {
  const sessions = [
    { id: 'blocked', branch: 'feat/blocked' },
    { id: 'current', branch: 'feat/current' },
  ];
  const error = { sessionId: 'blocked', message: 'approval decision refused' };

  assert.equal(commandErrorText(error, sessions, 'blocked'), 'approval decision refused',
    'unlabelled while its own session is open');
  assert.equal(commandErrorText(error, sessions, 'current'), 'feat/blocked: approval decision refused',
    'labelled while a different session is open');
  assert.equal(commandErrorText(error, sessions, null), 'feat/blocked: approval decision refused',
    'labelled in the grid');
  assert.equal(commandErrorText(error, [], null), 'approval decision refused',
    'a deleted session leaves the message rather than dropping it');
  assert.equal(commandErrorText(null, sessions, 'current'), '', 'dismissal');
});
