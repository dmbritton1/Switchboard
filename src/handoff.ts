import type { Msg, Session } from './types.ts';

/** Worktree-relative, so the successor's prompt never carries an absolute path. */
export const HANDOFF_FILE = '.switchboard/handoff.md';

/**
 * Fixed rather than user-editable: the successor is pointed at the narrative
 * and at the code separately, because the transcript explains the intent and
 * the branch carries the result, and neither is much use alone. One constant so
 * it stays tunable once real handoffs show what a successor actually misses.
 */
export const HANDOFF_PROMPT = [
  'You are continuing work handed off from another agent on a different account.',
  '',
  `Read \`${HANDOFF_FILE}\` for the full record of what happened before you: the`,
  'prompts, what the previous agent did, and what it said. Then check `git log`',
  'and the diff against this branch\'s base for the code as it actually stands —',
  'the transcript explains the intent, the branch carries the result.',
  '',
  'Then continue the work.',
].join('\n');

function findLongestBacktickRun(text: string): number {
  let maxRun = 0;
  let currentRun = 0;
  for (const char of text) {
    if (char === '`') {
      currentRun++;
      maxRun = Math.max(maxRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return maxRun;
}

function renderMsg(m: Msg): string | null {
  switch (m.kind) {
    case 'user':
      return `## You said\n\n${m.text}`;
    case 'text':
      return m.text;
    case 'tool': {
      const head = `- **${m.name}** ${m.summary} — ${m.status}`;
      if (m.detail) {
        // Use a fence longer than any backtick run in detail to prevent
        // premature fence closure if detail contains ``` or longer runs.
        const fenceSize = Math.max(3, findLongestBacktickRun(m.detail) + 1);
        const fence = '`'.repeat(fenceSize);
        return `${head}\n\n${fence}\n${m.detail}\n${fence}`;
      }
      // An evicted body is called out rather than omitted: a successor reading
      // a confident history with silent holes in it is worse off than one that
      // can see where the holes are.
      if (m.detailEvicted) return `${head}\n\n  _[detail evicted]_`;
      return head;
    }
    case 'todo':
      return ['## Todo', ...m.items.map((i) => `- [${i.completed ? 'x' : ' '}] ${i.text}`)].join('\n');
    case 'error':
      return `**Error:** ${m.text}`;
    // Reasoning is the agent's private deliberation about a state that has since
    // changed, and the safety boundaries forbid exposing it. Dropped, not rendered.
    case 'reasoning':
      return null;
  }
}

export function renderHandoff(session: Session): string {
  const header = [
    `# Handoff from \`${session.branch}\``,
    '',
    `Previous session ran on account \`${session.account}\` (${session.provider}), on branch`,
    `\`${session.branch}\`, and was \`${session.status}\` when it was handed off.`,
    '',
    '---',
  ].join('\n');
  const body = session.transcript
    .map(renderMsg)
    .filter((chunk): chunk is string => chunk !== null);
  return [header, ...body].join('\n\n') + '\n';
}
