/**
 * How long a session's collected paths stay usable before they are recollected.
 *
 * This is the rate limit, not a freshness preference. STATUS_THROTTLE_MS is 4000
 * (web/app.js), so every visible card asks for its session's status every four
 * seconds; recollecting on each of those would mean hundreds of git processes a
 * minute on a busy grid. The cache absorbs that, and the signal is advisory
 * enough that thirty seconds of staleness costs nothing.
 */
export const PATH_TTL_MS = 30_000;

/** Sessions can overlap on a great many files; nobody reads the eleventh. */
export const MAX_LISTED_PATHS = 10;

export type PathCache = Map<string, { paths: string[]; at: number }>;

export type Overlap = { id: string; branch: string; files: string[] };

/**
 * Which of `others` have changed a path `self` has also changed.
 *
 * A session missing from the cache is reported as no overlap rather than as an
 * error: entries fill in as each session's status is polled, so early on the
 * answer is legitimately incomplete. That makes the signal asymmetric for a
 * short while — one side may see a collision the other does not yet — which is
 * acceptable for a warning and unacceptable for anything with teeth.
 */
// ponytail: a linear scan per sibling, so O(n * paths) per call and O(n^2)
// across a grid where every card polls. Fine at ten sessions with a few hundred
// paths each; if a repo ever carries dozens of live sessions, invert it into a
// path -> sessions index built once per refresh instead.
export function overlaps(
  cache: PathCache, self: string, others: { id: string; branch: string }[],
): Overlap[] {
  const mine = cache.get(self);
  if (!mine) return [];
  const own = new Set(mine.paths);
  const out: Overlap[] = [];
  for (const other of others) {
    const theirs = cache.get(other.id);
    if (!theirs) continue;
    const files = theirs.paths.filter((p) => own.has(p));
    if (files.length) out.push({ id: other.id, branch: other.branch, files });
  }
  return out;
}

/** A path list for a card tooltip or a tool result, bounded so neither grows unread. */
export function summarizePaths(files: string[]): string {
  if (files.length <= MAX_LISTED_PATHS) return files.join(', ');
  const shown = files.slice(0, MAX_LISTED_PATHS).join(', ');
  return `${shown}, and ${files.length - MAX_LISTED_PATHS} more`;
}

/**
 * Recollect one session's paths if the entry is missing or older than the TTL.
 *
 * A failed collection keeps whatever was there: a worktree removed by hand
 * should not silently blank a set other sessions are intersecting against —
 * that would read as "no overlap" rather than "unknown", which is the wrong
 * direction to fail for a warning.
 */
export async function refreshPaths(
  cache: PathCache, id: string, collect: () => Promise<string[]>, now: number,
): Promise<void> {
  const entry = cache.get(id);
  if (entry && now - entry.at < PATH_TTL_MS) return;
  try {
    cache.set(id, { paths: await collect(), at: now });
  } catch {
    // Keep the stale entry. dropPaths is the deliberate forget.
  }
}

/** Called when a session goes away: paths for a deleted session are a lie. */
export function dropPaths(cache: PathCache, id: string): void {
  cache.delete(id);
}
