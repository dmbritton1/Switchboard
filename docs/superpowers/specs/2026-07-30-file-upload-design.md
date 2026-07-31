# File upload for Switchboard sessions

Date: 2026-07-30
Status: approved, not yet implemented

## Problem

A session's agent can only read what is on disk inside its worktree. There is
no way to hand it a file — a screenshot, a log, a CSV, a spec — from the
browser. Today you have to copy the file into the worktree yourself in a
terminal, which defeats the point of a single window.

## Mechanism

Both adapters (`claudeAdapter`, `codexAdapter`) accept a **text prompt only**.
Neither takes attachments, and `StartOpts`/`AgentHandle` have no place to put
them. So the upload does not travel through the agent protocol at all:

1. The browser POSTs the file bytes to the server.
2. The server writes the file into that session's worktree.
3. The relative path is appended to the message text.
4. The agent opens it by path, as it would any other file in the repo.

This works for every file type and both providers, and changes no adapter,
no `Msg` kind, and no transcript shape.

## Server

One new route in `src/server.ts`, sitting beside `/command`:

```
POST /upload?id=<sessionId>&name=<filename>
body: raw file bytes
200 -> { "path": "uploads/<filename>" }
```

- **Guards:** the existing `hostOk(req)` check applies (it is above the route
  dispatch already), plus the same `Origin`-vs-`Host` check `/command` uses.
  This route writes to disk; it wants both.
- **Session lookup:** `registry.get(id)`; 404 `{ error: 'no such session' }` if
  absent. The file goes to `session.cwd`, so an unknown session has nowhere to
  write.
- **Name validation** (trust boundary — not simplified away): reduce `name` to
  `basename(name)` and reject with 400 if the result is empty, `.`, `..`, or
  differs from the input. A traversal like `../../.ssh/authorized_keys` is
  rejected, not silently rewritten.
- **Size cap:** accumulate the body with a running byte count; abort at 25 MB
  and respond 413. Prevents an unbounded buffer from a mistaken drop of a
  video file.
- **Write:** `mkdir` `<session.cwd>/uploads` recursively, then write the bytes.
  Overwrites an existing file of the same name — last drop wins, which matches
  what a user dragging the same screenshot twice expects.

## Storage location

`<worktree>/uploads/<name>`.

- Codex runs sandboxed to its worktree, so anything outside it (OS temp dir,
  a shared upload folder) is unreadable to that provider. Inside the worktree
  is the only location that works for both.
- A subdirectory rather than the worktree root keeps `git status` legible —
  one untracked `uploads/` line instead of N untracked files mixed into the
  repo's real ones.
- Cleanup is already handled: `delete` with "remove worktree" checked removes
  the whole directory.

## Client

`web/index.html` and `web/app.js`:

- A file-picker button in `#composer` (a `<label>` wrapping a hidden
  `<input type="file" multiple>` — native, no library).
- A `drop`/`dragover` handler on the chat view for drag-and-drop of the same
  files.
- Both paths run the same function: for each file, POST it to `/upload` with
  the open session's id, then append the returned `path` to `#prompt`'s value,
  space-separated.
- The user then types whatever they want around the paths and presses Send.
  The existing `send({ cmd: 'send', ... })` path is untouched.
- Upload failure surfaces inline the same way command errors already do,
  rather than silently dropping the file.

## Testing

Added to `test/server.test.ts`:

- Upload to a live session writes the exact bytes to
  `<cwd>/uploads/<name>` and returns that relative path.
- `name=../../evil` returns 400 and creates no file outside the worktree.

## Deliberately out of scope

**Attaching files in the new-session dialog.** The worktree does not exist
until `create` runs, and `create` creates the worktree and launches the agent
with the first prompt in a single call — so there is no moment at which a file
could be written before the agent starts reading. Supporting it requires
splitting worktree creation from agent launch, which is a larger change than
the feature justifies. Attach files in the first follow-up message instead.
Revisit if that turns out to be annoying in practice.

**Uploading into the transcript as an attachment chip.** The path-in-text
approach means an upload leaves no trace in the transcript beyond the message
the user sends. That is enough to know what happened. A dedicated `Msg` kind
buys nicer rendering and costs a registry change, a persistence change, and a
render branch.

## Questions asked, and the answers assumed

The interactive question prompt did not render on the asking side, so these
were answered by default. Written out here so they can be corrected:

**Q1 — Where do you want to attach files?**
- Open chat composer ← **assumed**
- New-session dialog
- Both

**Q2 — Where should uploaded files land inside the worktree?**
- `uploads/` subdir ← **assumed**
- Worktree root
- OS temp dir (rejected: unreadable to sandboxed Codex)

If either default is wrong, say which and the spec changes before any code is
written.
