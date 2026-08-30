import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RelayResult, RelaySession } from '../types.ts';

function describe(result: RelayResult, queuedNote: string): string {
  if (result.ok) return result.queued ? queuedNote : 'Delivered.';
  switch (result.reason) {
    case 'unknown-session': return 'No such session.';
    case 'self': return 'That is this session.';
    case 'different-repo': return 'That session is on a different repository.';
    case 'not-live': return 'That session is stopped and cannot receive messages.';
  }
}

/**
 * Cross-session messaging for one session. `sessions` and `send` are closures
 * the server built over that session's identity, so nothing here can name a
 * different sender — the tool takes a target, never a from.
 */
export function relayServer(deps: {
  sessions: () => RelaySession[];
  send: (target: string, text: string) => RelayResult;
}) {
  return createSdkMcpServer({
    name: 'relay',
    version: '0.1.0',
    instructions:
      'Other agent sessions working on this same repository, on their own git '
      + 'branches. Use this to coordinate — to say what you are changing, to ask '
      + 'what another session has already done, or to answer when one asks you.',
    tools: [
      tool(
        'list_sessions',
        'List the other sessions on this repository that you can message.',
        {},
        async () => {
          const rows = deps.sessions();
          if (!rows.length) {
            return { content: [{ type: 'text' as const, text: 'No other sessions on this repository.' }] };
          }
          return {
            content: [{
              type: 'text' as const,
              text: rows
                .map((s) => `${s.branch} — ${s.status}, on account ${s.account} (id ${s.id})`)
                .join('\n'),
            }],
          };
        },
      ),
      tool(
        'send_to_session',
        'Send a message to another session on this repository. It arrives as a '
          + 'prompt, so say who you are and what you need.',
        {
          session: z.string().describe('The target session id or branch, from list_sessions.'),
          text: z.string().describe('The message. Write it for another agent, not for a human.'),
        },
        async ({ session, text }) => {
          const result = deps.send(session, text);
          return {
            content: [{
              type: 'text' as const,
              text: describe(result, 'Queued — that session is mid-turn and will read it when the turn ends.'),
            }],
            ...(result.ok ? {} : { isError: true as const }),
          };
        },
      ),
    ],
  });
}
