# File-by-file diff — design

The Diff tab has been a named slot since the layout spec: it renders the totals
`/status` already returns and a line reading "File-by-file diff is not
implemented yet." This spec fills it.

## Range

**Uncommitted work only — `HEAD` to the working tree, untracked files
included.**

This is the same range `worktreeStatus()` already measures for the card's
`+N −M · dirty/clean` line and the sidebar's `#sidebar-diffstat`. Sharing the
range is the point: a pane whose per-file numbers do not sum to the number
displayed six inches away is a bug report waiting to happen, and the totals are
the more visible of the two.

The consequence is that an agent which commits its work empties the pane. That
is accepted. A whole-branch range (`trunk...HEAD` plus uncommitted) is the
obvious extension, but it needs its own answer for how the two number sets
reconcile, and nothing today asks for it.

## Server

### `worktreeDiff(cwd)` — `src/worktree.ts`

Lives beside `worktreeStatus()` and reuses its pathspec verbatim:
`-- . ':!uploads'`. `/upload` drops pasted and attached files into `uploads/`
for the agent to read; they are not the agent's work and are excluded from the
totals for that reason. The same reasoning applies here, so the same exclusion
does.

```ts
export type FileDiff = {
  path: string;      // new path (post-rename)
  old?: string;      // previous path, renames only
  added: number;
  removed: number;
  binary: boolean;   // numstat reported `-`; patch is empty
  patch: string;     // unified hunks, no `diff --git` header line
  truncated: boolean;
};

export async function worktreeDiff(cwd: string): Promise<FileDiff[]>;
```

Three git calls, run together:

1. `git diff HEAD --numstat -z -- . ':!uploads'`

   Authoritative source for paths and counts. `-z` because a repo may contain a
   path with a space, a quote, or a newline in it, and the non-`-z` form escapes
   those into a quoted string that then has to be unquoted. The `-z` record
   format is `added \t removed \0 path \0`, except for renames, which emit
   `added \t removed \0 old \0 new \0` — the rename case is detected by the
   empty path field, exactly as git documents it.

   Binary files report `-` for both counts. They become `binary: true`,
   `added: 0`, `removed: 0`, empty patch — the same skip `worktreeStatus()`
   makes, for the same reason: a byte count is not a line count.

2. `git diff HEAD --patch --no-color --no-ext-diff -- . ':!uploads'`

   Split on `/^diff --git /m` and zipped to the numstat rows **by position**.
   Both commands walk the same diff queue with the same pathspec and the same
   options, so the two lists are the same files in the same order — including
   binary files, which appear in both, and mode-only changes, which appear in
   both as `0 0`. Position avoids parsing a path back out of a patch header,
   which git may quote.

   As a cheap guard against that assumption ever breaking, a chunk is only
   attached to its row when the chunk text contains the row's path. A mismatch
   yields an empty patch body under a correct header rather than the wrong
   file's diff under it. Both commands run under `-c core.quotePath=false` so
   the check is not defeated by a non-ASCII path.

   `--no-color` because the server may inherit a user's `color.ui = always`;
   `--no-ext-diff` because a repo-configured external differ would return
   something that is not a unified diff at all.

   The chunk's own first line and its `index` / `---` / `+++` lines are
   stripped: the summary already names the file. `old mode`, `new file mode`,
   `rename from/to` and the `Binary files … differ` notice are kept.

   This is the one call whose output can be large, so it carries an explicit
   `maxBuffer` and, if it still fails, degrades to empty patch bodies — the
   file list keeps working.

3. `git ls-files --others --exclude-standard -z -- . ':(exclude)uploads'`

   Untracked files. `git diff HEAD` cannot see them, and leaving them out would
   show `+0 −0` for the most common first prompt there is — one that tells the
   agent to *create* files. `worktreeStatus()` solves this by counting their
   lines directly rather than staging them with `git add -N`; this does the
   same and additionally synthesizes the patch body: every line prefixed `+`,
   under one `@@ -0,0 +1,N @@` header.

   The same three guards apply, and for the same reasons `worktreeStatus()`
   gives:

   - 0 bytes, or larger than 2MB → skipped. This runs in the long-lived server
     process; an agent that downloaded a dataset into its worktree should not
     have it read into memory whole.
   - a NUL byte in the first 8000 bytes → `binary: true`, no patch. git's own
     heuristic.
   - unreadable or vanished between `ls-files` and the read → skipped.

**Truncation.** A patch body longer than 2000 lines is cut there and marked
`truncated: true`. A single generated-file change would otherwise put megabytes
through a route the open pane polls every `STATUS_THROTTLE_MS` (4s). The counts
stay accurate; only the body is cut.

**Ordering.** Tracked files in git's order, then untracked. Git's order is
stable across polls, which is what matters for a pane that re-renders while
the user is reading it.

### `/diff?id=` — `src/server.ts`

Copied from the `/graph` route, including its constraint: keyed by session id,
never a path from the client. The directory to read is whatever that session
already runs in, so the route opens no way to point git at a directory the user
never registered. Unknown id → `404` with `[]`. A git failure resolves to `[]`
rather than a 500, matching `/graph`.

## Browser

`renderDiffPane()` in `web/app.js` fetches `/diff` in place of `/status`, on the
existing `forceDiffFetch` / `STATUS_THROTTLE_MS` schedule, and keeps the
existing guard that discards a response arriving after the user has left the
tab.

**Per file, a native `<details>`.** `<summary>` shows `path · +N −M`, or
`old → new · +N −M` for a rename; the body is the patch. `<details>` is used
rather than a click handler because the browser already provides the toggle,
the keyboard interaction, and the ARIA expanded state.

**Expansion state** is a `Set` of paths, module-scoped beside `sidebarDiffFor`,
cleared on session switch in `openTab()`. `open` is set from the Set on render
and the Set is updated on `toggle`.

**Re-render is skipped when the new payload is byte-identical to the last one.**
The pane polls; the diff usually has not changed between two polls; replacing
the DOM anyway resets the scroll position of a pane the user is reading. The
comparison is on the raw response text, before parse. It is cleared on session
switch alongside the expansion Set.

Both `diffSummary(file)` (the summary text, including the rename form) and
`patchLineClass(line)` (added / removed / hunk) are pure and live in
`web/lib.js`, which is where this codebase keeps browser logic that can be
tested offline.

Empty result → "No uncommitted changes." Binary file → "Binary file" in place
of the body. Truncated file → a "… truncated" line at the end of the body.

**Styling** in `web/style.css`: monospace body, added and removed lines tinted
from existing tokens, hunk headers muted. No syntax highlighting, no
side-by-side, no word-level intra-line diff.

## Tests

`test/worktree.test.ts` — a temporary repo containing a modified tracked file,
an untracked file, a binary file, and a file under `uploads/`. Asserts:

- the modified file's counts and patch body,
- the untracked file appears with an all-`+` patch,
- the binary file is `binary: true` with empty patch,
- the `uploads/` file is absent,
- summed `added`/`removed` equal `worktreeStatus()`'s totals on the same repo —
  the invariant the shared range exists to guarantee.

Rename and truncation get one case each.

`test/server.test.ts` — `/diff` returns `[]` and `404` for an unknown id, a file
list for a known one, and `403` behind the Host guard like every other route.

`test/ui.test.ts` — `diffSummary` for the plain, rename, and binary forms;
`patchLineClass` for added, removed, hunk, and context lines.

Tests stay offline and use temporary directories, per the repo's test isolation
rule.

## Out of scope

- Whole-branch range (`trunk...HEAD`).
- Syntax highlighting, side-by-side view, word-level intra-line diff.
- Staging, reverting, or any write from the pane. It reads.
- Committing from the UI.
