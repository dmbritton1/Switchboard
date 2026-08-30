import type { Registry } from './sessions.ts';
import type { AgentHandle, RelayResult } from './types.ts';

/**
 * Exchanges a channel carries before it closes itself and the next send has to
 * be approved again. The number is a judgement call, not a derived one: low
 * enough that an unattended pair cannot run far before asking, high enough that
 * a working exchange is not interrupted mid-thought.
 */
export const RELAY_CHECKPOINT = 10;

/**
 * Open channels, keyed by the unordered pair of session ids. A key's presence
 * means the pair may talk without a card; its value counts exchanges since the
 * channel was opened.
 *
 * Deliberately not a field on Session. A channel is a property of a pair rather
 * than of either end, and Session is persisted — a channel that outlived the
 * process would name handles that no longer exist.
 */
export type Channels = Map<string, number>;

export function channelKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function channelOpen(channels: Channels, a: string, b: string): boolean {
  return channels.has(channelKey(a, b));
}

/** Called when a session goes away: a channel to a deleted session is a lie. */
export function dropChannels(channels: Channels, sessionId: string): void {
  for (const key of channels.keys()) {
    const [x, y] = key.split(':');
    if (x === sessionId || y === sessionId) channels.delete(key);
  }
}

export type RelayDeps = {
  registry: Registry;
  handles: Map<string, AgentHandle>;
  channels: Channels;
};

/**
 * Delivers one message from one session to another, and records that the pair
 * is talking.
 *
 * It does not check whether the pair was approved. The gate runs in the
 * adapter's canUseTool before the tool executes, so by the time this is called
 * the human has already allowed this send — re-checking here would reject the
 * first message of every channel, which is the one the approval was for.
 */
export function relay(deps: RelayDeps, from: string, to: string, text: string): RelayResult {
  const { registry, handles, channels } = deps;
  const sender = registry.get(from);
  const target = registry.get(to);
  if (!sender || !target) return { ok: false, reason: 'unknown-session' };
  if (from === to) return { ok: false, reason: 'self' };
  // The boundary merge and push already enforce: same-repo sessions are the ones
  // whose work can collide, and the ones a cross-session message can be about.
  if (sender.repo !== target.repo) return { ok: false, reason: 'different-repo' };
  const handle = handles.get(to);
  // A stopped session cannot act on a message. Accepting one would strand it in
  // a transcript nobody reads.
  if (!handle) return { ok: false, reason: 'not-live' };

  // Codex marks a prompt queued until its turn ends; Claude's streaming input
  // takes it directly. Same call the send command makes.
  const queued = target.provider === 'codex';
  const promptId = registry.appendPrompt(to, text, queued ? 'queued' : 'sent');
  handle.send({ text, attachments: [] }, promptId);

  const key = channelKey(from, to);
  const count = (channels.get(key) ?? 0) + 1;
  if (count >= RELAY_CHECKPOINT) channels.delete(key);
  else channels.set(key, count);
  return { ok: true, queued };
}
