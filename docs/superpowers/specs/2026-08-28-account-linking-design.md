# Account linking — design

Let a user link any combination of Claude and Codex accounts from the browser,
by clicking a button and approving in the provider's own OAuth page, instead of
running CLI logins by hand and editing `accounts.json`.

Today linking is entirely out-of-band. You create a config directory, run an
interactive CLI login in a terminal, hand-edit `accounts.json`, and restart the
server — `accounts.json` is read exactly once, at the entry point
(`src/server.ts:1187`), and nothing ever writes it. The app's only account
surface is read-only: `snapshot()` publishes name, provider, budget, pace and
limits (`src/server.ts:376`), `refreshLimits` polls Claude plan limits every
five minutes (`src/server.ts:313`), and `web/app.js:153` renders a meter.

## The mechanism, and why it is not an OAuth client

Switchboard does not implement OAuth. Both CLIs already run the full flow and
own their credential stores; the app spawns one with an isolated environment,
relays the URL out to the browser and (for Claude) the code back in, and reads
the resulting identity. No token ever passes through Switchboard's own code.

Credential isolation per account is real and already relied on. Claude Code
suffixes its macOS Keychain item with a hash of `CLAUDE_CONFIG_DIR` — a machine
with a default plus three alternate config dirs shows `Claude Code-credentials`
alongside `Claude Code-credentials-467ab3fe` and siblings. Codex isolates via
`auth.json` under `CODEX_HOME`.

The two providers are asymmetric, and the design follows the difference rather
than papering over it. Measured against the installed CLIs:

| | Claude | Codex |
| --- | --- | --- |
| URL printed on | stdout | stderr |
| Redirect target | `platform.claude.com/oauth/code/callback` | `http://localhost:1455/auth/callback` |
| Completion | blocks on stdin for a pasted code | local server completes it |
| Identity readback | `auth status --json` | none — see below |

`claude auth status --json` returns `loggedIn`, `email`, `subscriptionType` and
`authMethod`. `codex login status` returns only the string `Logged in using
ChatGPT`, with no identity at all; the email is in the `id_token` claims in the
staging directory's `auth.json`.

Codex's login server binds a **fixed** port 1455, so concurrent Codex links
collide by construction. One pending link at a time, globally. Claude links have
no port and could run in parallel, but allowing that means a multi-link UI for a
flow that runs a handful of times per install.

## Scope

**In:** link an account of either provider from the browser; unlink one; a
first-run experience when no accounts exist.

**Out:** renaming, editing `budget`, or setting an explicit Codex `bin` from the
UI. `budget` is a hand-tuned calibration knob (`src/usage.ts:5`), not an
onboarding decision; new accounts default to `2_000_000`, matching
`accounts.example.json`, and retuning stays a file edit. An explicit `bin` is
documentation for a local install, not a portable setting.

**Also out: general hot-reload of `accounts.json`.** Links take effect
immediately; hand edits still require a restart. Reconciling an account removed
by hand against running sessions is a separate problem with no caller asking for
it.

## The account store

`accounts: Account[]` stays a plain array. Its five readers — `create`
(`src/server.ts:576`), schedule validation (`:516`), `resume` (`:713`), `tick`'s
`free` (`:870`) and `snapshot` (`:376`) — all call `accounts.find(...)` at call
time, not closure time, so in-place `push`/`splice` makes every one correct with
no edits. Wrapping the array in a class would mean touching all five to gain
nothing they do not already do.

A new `src/accounts.ts` holds `loadAccounts(path)` and a
`createAccountStore(path)` returning `{append, remove}`. Both mutators are
read-modify-write and both write to a temp file then rename, serialized behind a
save chain — copied from `Registry`, whose comment at `src/sessions.ts:483-492`
explains why chaining beats unique temp names.

**A missing `accounts.json` is now legal** and loads as `[]`. The entry point
currently throws. This is what makes first-run work and retires the `cp
accounts.example.json` step; the example file stays as documentation of the
hand-editable shape.

### Co-ownership, and the append-only rule

This makes `accounts.json` co-owned by the user and the app for the first time,
and the window is unusually wide: the app is parked waiting on a human in a
browser tab, typically thirty seconds to five minutes, which is exactly when
someone edits a file.

Commit is therefore a read-modify-write — re-read from disk, append, write back
— so an edit made since boot survives on disk rather than being clobbered by a
blind write of a stale in-memory array.

**But only the new entry enters memory.** Re-syncing the whole array from disk
would make a link commit silently apply every unrelated edit made during that
window, including deletions, at a moment the user did not choose: deleting
`codex` from the file while linking a Claude account would make finishing the
Claude link the thing that drops `codex` from the running server. It degrades
safely — `free()` treats a missing account as never-free
(`src/server.ts:870-872`) and `resume` returns "account no longer configured"
(`:714`) — but it is an uncontrolled hot-reload triggered by an unrelated
action.

The app's write authority is scoped to entries it manages. Everything else in
the file is carried forward to disk untouched and never adopted into the running
process. That preserves exactly one rule, already true today:

> Hand edits to `accounts.json` take effect on restart. Links take effect
> immediately.

Refusing to commit when the file changed since boot was rejected: it discards a
completed OAuth flow because of an unrelated line edit.

### Why not app-owned records in `state.json`

The clean answer to co-ownership is one writer per file: linked accounts become
app-owned records in `state.json`, `accounts.json` stays read-only to the app,
and boot merges them. Rejected because **`state.json` and account records have
different lifetimes.** `state.json` holds sessions, usage samples and settings —
regenerable, disposable, gitignored. It is the file you delete to clear a wedged
session. An account record pointing at a credential directory is durable config;
deleting `state.json` to unstick a session must not silently unlink three
OAuth'd accounts.

Secondary costs, which would not decide it alone: two files to consult to answer
"what accounts exist", a precedence rule to remember, and an unlink button that
works on app-linked accounts but not hand-written ones — the same control
succeeding or failing based on which file an account came from.

### Test seam

`createServer` gains two options alongside the existing `prepare`,
`resolvePrompt` and `beforeUpload*` seams:

- `accountStore?: { append(entry: Account): Promise<void>; remove(name: string):
  Promise<void> }` — linking is disabled when absent, so every existing server
  test keeps its behavior unmodified. Two methods rather than one
  `save(accounts)`, because the read-modify-write has to happen *inside* the
  store: handing it a whole array from memory is exactly the blind write the
  append-only rule forbids.
- `accountsRoot?: string` — the directory holding per-account credential dirs,
  defaulting to `~/.switchboard/accounts`. **Required for tests to be safe:**
  without it, an unlink test would target a real path under the developer's home
  directory. It is also what makes the "never delete outside the root" rule
  testable at all, since the test needs a root it controls.

## The `PendingLink` subsystem

A new `src/link.ts` owns the state machine; `createServer` holds
`let pending: PendingLink | null`.

```
starting ──url──▶ awaiting-user ──exit 0──▶ verifying ──▶ naming ──confirm──▶ committed
    │                   │                       │
    └───────────────────┴──────── error / cancel / timeout ───────▶ (cleanup)
```

**URL capture is one regex over both streams.** Rather than two per-provider
parsers, watch stdout and stderr for the first match of
`https://(claude\.com|auth\.openai\.com)/\S*oauth\S*`. Anchoring to the two
expected hosts stops a stray URL in an update notice from hijacking the flow. No
URL within 30s fails fast with the child's redacted stderr tail — the shape a
missing binary or version mismatch takes.

Both CLIs also open the browser themselves, and since Switchboard is
127.0.0.1-only that is the same machine, so the tab often appears on its own.
The UI button is the reliable path, not the only one.

**The paste box is discovered, not assumed.** `codeRequested` is set when the
literal `Paste code here` prompt appears on stdout, not from `provider ===
'claude'`. The Claude CLI hedges with *"if prompted"*, so the branch where it
completes without asking is real; under this rule it needs no special case. The
child exits 0, the machine moves to `verifying`, and any paste box on screen
goes away.

**Identity readback** is asymmetric. Claude: `auth status --json` against the
staging dir, take `email` and `subscriptionType`, propose `claude-<local-part>`.
Codex: read `tokens.id_token` from the staging `auth.json`, base64url-decode the
payload, take `email`. No signature verification — this is labelling a file we
wrote seconds ago, not authenticating a request. Only `email` is read; nothing
else from that file is logged, persisted or returned.

**Identity may be absent, and that is not an error.** A Codex `auth.json` can
carry `auth_mode` with an `OPENAI_API_KEY` and no `tokens.id_token` at all, and
a Claude account authenticated against the Console rather than a subscription
may report no `email`. So `email` is the duplicate-detection key *when
available*, and when it is not:

- the account is still linked — the credentials are valid, which is what matters;
- no duplicate check runs, because there is nothing to compare;
- the suggested name falls back to the provider with the lowest free suffix —
  `codex`, then `codex-2`, then `codex-3`.

`identity` in the snapshot is therefore nullable at `naming`, and
`identity.subscription` is independently nullable — Codex has no equivalent of
`subscriptionType` even when the email resolves.

**Binary resolution reuses what exists, with one change to it.** For Codex, the
login child is spawned with the path `prepareCodexRuntime` already selects —
explicit account `bin`, then a version-matched ChatGPT.app binary, then the
SDK-bundled CLI (`src/agents/codex-runtime.ts:318-360`) — rather than a second
hardcoded path that could drift from the one sessions actually use.

That function cannot be reused as-is. `prepareCandidate` calls
`assertAuthentication` on all three paths (`:293`), so against the fresh, empty
`CODEX_HOME` every link starts with, it throws `codex_auth_unavailable` — the
one state linking exists to fix. The ChatGPT fallback rethrows that code rather
than continuing to the SDK binary (`:355`), so it cannot recover either.

`CodexRuntimeDeps` therefore gains `requireAuth?: boolean`, defaulting to
`true`, threaded to `prepareCandidate` to skip `assertAuthentication` when
false. Linking passes `false`; every existing caller is unchanged by the
default. Version and executability checks still run, so a mismatched binary
still fails before a browser opens. Its other failures remain actionable
`CodexRuntimeError`s and surface unchanged.

For Claude, the CLI is `claude` on `PATH`; the adapter goes through the SDK and
never needed a path before, so a missing binary is a distinct, plainly worded
link error.

**Staging and commit.** The child writes into
`~/.switchboard/accounts/.pending-<id>/`. On confirm, `rename()` to
`~/.switchboard/accounts/<name>/` — same parent directory, so same filesystem,
so atomic — then the append above. Any failure is `rm -rf` on staging with
nothing written anywhere. A `.pending-*` sweep at startup cleans up after a
crash; a pending link deliberately does not survive a restart.

**Secrets.** The pasted authorization code goes browser → POST → child stdin and
stops there: never logged, never in `snapshot()`, never persisted. Child output
is buffered to a bounded 8 KiB tail for error messages only, with the staging
path and any submitted code redacted before it can reach the browser — the
posture `redactAccountValue` (`src/server.ts:55`) and `detailSuffix`
(`src/agents/codex-runtime.ts:136`) already take.

**Name validation is a trust boundary.** The name arrives in a browser POST and
becomes a filesystem path. Constrained to `/^[a-z0-9][a-z0-9-]{0,31}$/` and
rejected on collision — the same posture as the upload handler, which rejects
what it would have had to rewrite rather than rewriting it silently
(`src/server.ts:1048-1056`).

## Commands and the wire

Five commands inside the existing `command()` switch, inheriting `originOk`, the
body parse, the `{status, json}` shape, and the save-before-respond ordering:

| cmd | precondition, else 409 |
| --- | --- |
| `link-start {provider}` | no link pending |
| `link-code {code}` | phase `awaiting-user` **and** a prompt was seen |
| `link-confirm {name}` | phase `naming` |
| `link-cancel` | none — always 200, cancelling nothing is not an error |
| `unlink {name}` | account not in use (see Unlink) |

`link-start` returns `{ok: true}`, not the URL. The URL arrives via the SSE
snapshot like everything else, so there is one code path and two open tabs
cannot disagree. Body values get the same `typeof` strictness as the rest of
`command()` (`src/server.ts:515`); a bad request 400s rather than being coerced.

Errors stay plain `{error: string}`. The Codex `code` taxonomy exists because
`web/lib.js:240` branches on it; the link dialog renders messages verbatim, so a
second taxonomy would be vocabulary with no reader.

### Pushing phase changes

`link.ts` exposes its own `subscribe(fn) => unsub`, five lines mirroring
`Registry` and `Scheduler`. `/events` gains a third `link.subscribe(push)` next
to the two already there, and the close handler a third `unsub`.

Reusing `registry.touch()` — as `refreshLimits` does (`src/server.ts:1206`) —
was rejected. `touch()` is not a push primitive: it calls `#notify()`
(`src/sessions.ts:474-480`), whose subscribers include both the SSE push
(`:936`) and the coalesced save timer (`:1163`). Routing link phase changes
through it would schedule a `state.json` write per transition, making the one
piece of state guaranteed *not* to be saved the thing that triggers saving.

`refreshLimits` reaches for `touch()` for a reason that does not apply here:
`Usage` has no subscriber list, and adding one would change an existing class.
`link.ts` is new, and `Scheduler` already set the precedent — its comment at
`src/schedule.ts:34` says it mirrors Registry's `#subs`/`#notify` "exactly: same
shape, so the /events route can treat both sources the same way." This is the
third instance of that call, not a new pattern.

The distinction generally: adopting an *interface* is nearly free; routing
through another object's *implementation* inherits its side effects.

<!-- ponytail: three copies of a five-line Set wrapper. Collapse them into one
     notifier that /events subscribes to once when a fourth publisher appears,
     when the close-handler unsub bookkeeping drifts, or when cross-source
     coalescing is wanted — that last one is the real trigger, and three
     separate #subs sets cannot provide it. Not before: it means refactoring two
     working, tested modules to serve a feature that does not need it. -->

### Snapshot shape

A `link` key beside `sessions`, `accounts` and `queue`:

```ts
link: {
  provider, phase,
  url: string | null,
  codeRequested: boolean,
  // Only at `naming`, and null there too when the provider exposed no identity
  // (Codex API-key auth, Console-authenticated Claude). `subscription` is
  // independently null: Codex has no equivalent field.
  identity: { email: string; subscription: string | null } | null,
  suggestedName: string | null,
  error: string | null,                        // redacted, bounded
} | null
```

Deliberately absent: the staging directory path, the pasted code, raw child
output, the pid. The staging path becomes the account's
`CLAUDE_CONFIG_DIR`/`CODEX_HOME` — an account env value, which AGENTS.md says is
launch-only and must never be persisted, logged, returned over SSE or rendered.

**On exposing the authorize URL:** it carries a PKCE `code_challenge` and
`state`, and the snapshot reaches every connected tab and anything local that
opens `/events`, which is unauthenticated (`README:218`). Accepted: the URL is
short-lived, the credential lands in our staging dir either way, and for Codex
the `localhost:1455` callback is open to local processes because that is how
`codex login` works, with or without this feature. Recorded here as a judgment,
not an oversight.

## Unlink

Account references live in four places; three block.

| Reference | Blocks |
| --- | --- |
| `Session.account`, status `working` or `needs-you` | yes |
| `Queued.action` `{kind:'create', account}` (`src/types.ts:257`) | yes |
| `Queued.trigger` `{kind:'reset', account}` (`src/types.ts:254`) | yes |
| `Settings.account` — the pinned default | no |
| `Session.account`, status `done` or `stopped` | no |

The pin is excluded because `parseSettingsPatch` already refuses to validate it
against the account list, and says why: "an account can be removed from
accounts.json while a stale pin names it, and rejecting the patch would make
settings unsavable" (`src/server.ts:262-266`). The New dialog already falls back
to freest. Unlink must not fight a staleness tolerance that is designed in, and
clearing the pin would be a settings write the user did not request.

"In use" means **actively running** — exactly the existing `busy()` predicate
(`src/server.ts:875-877`), which gets extracted to a named helper shared by
`tick`'s `Ctx` and the unlink check rather than copied. `needs-you` counts: it is
not computing, but it is a live child process parked on an approval prompt, so
unlinking under it strands a real process rather than a record.

Blocking on *any* referencing session was rejected — forty finished sessions on
an account would make it permanently unremovable. The consequence of allowing it
is bounded and acceptable: **an unlinked account's dead sessions become a
read-only archive.** `send` already requires a live handle
(`src/server.ts:631`), so a stopped session could never be sent to regardless of
account. The only capability lost is `resume` (`:713-714`). Transcript, diff,
git graph, detail, merge, push, delete, stop, auto and codex-settings all touch
neither `accounts` nor the credential dir. The UI degrades cleanly: the sidebar
meter is already written as `account ? [accountMeter(account)] : []`
(`web/app.js:1015-1016`), and the session title renders `s.account` as a plain
string.

### Deleting credentials

**Only ever remove a directory that is exactly
`~/.switchboard/accounts/<name>`.** An existing hand-written entry may point at
`~/.claude-alt`, which Switchboard never created and must never delete. Any
account whose env points outside the app-managed root is removed from
`accounts.json` with its directory left on disk, and the UI says so.

Provider logout is best-effort: attempt `claude auth logout` / `codex logout`
against the dir first so the refresh token is revoked rather than orphaned,
ignore failure, then delete. A network hiccup must not block removing an
account.

**Ordering:** checks → write `accounts.json` without the entry → splice memory →
logout → `rm -rf`. Durable record first, so a failed `rm` leaves a stray
directory — harmless and sweepable — rather than deleting credentials and then
failing to persist, leaving a live entry pointing at nothing.

The startup sweep removes `.pending-*` staging dirs only. An orphaned
`~/.switchboard/accounts/<name>` with no matching entry is left alone; a cleanup
routine that deletes credential directories on a heuristic is how data gets
eaten after an unrelated bug.

<!-- ponytail: usage samples are keyed by account name in state.json and are not
     cleaned up on unlink, so unlinking and re-linking under the same name
     within the 5h window inherits the old pace samples. They age out on their
     own. Add cleanup only if this ever actually confuses someone. -->

## UI

The design brief is to be invisible. `web/style.css` derives ten accents across
twelve canvases in OKLCH, and `test/palette.test.ts` parses the file and asserts
contrast on the combinations — so every new surface uses existing tokens and the
existing `.field` / `.hint` / `.check` / `<menu>` vocabulary. A hardcoded hex
fails that test, which is the point.

**First-run screen** — `<section id="welcome" hidden>`, toggled against `#grid`
exactly as `<section id="session" hidden>` already is. Not a `<dialog>`: a modal
with no escape is hostile, and this is not an interruption, it is the whole app
until something is linked. Shows when `state.accounts.length === 0`, during
which `#new-btn` stays disabled because the New dialog's account select would be
empty.

**Link dialog** — one `<dialog id="link">` whose body swaps by phase, rendered
from the SSE snapshot rather than local state. One deviation from the existing
dialogs: `#new`, `#del` and `#settings` all use `<form method="dialog">`, where
submit closes; here submit *advances*, so this form handles submit and closes
itself only at the end.

**Closing mid-link does not cancel.** Esc hides the dialog and the child keeps
running, since the user may want to look elsewhere while the browser tab is
open. A `#link-chip` in the header reopens it — the same pattern as
`#queue-badge` (`web/index.html:25`), a hidden button that appears when there is
pending state. Cancel remains an explicit button inside the dialog.

**Accounts live in Settings**, which already owns "Default account". It gains an
Accounts section: each account with provider, plan and an Unlink button, plus
**Link Claude account** / **Link Codex account**, which close Settings and open
the link dialog. No new chrome in `#bar`.

**Unlink confirm** — `<dialog id="unlink">` mirroring `#del`'s shape: heading,
subject line, `.hint`, `<menu>` with Cancel and a destructive confirm.

**Logic goes in `web/lib.js`, not `app.js`.** A pure `linkView(link)` — phase in,
`{heading, showUrl, showCodeBox, showNameForm, hint, error}` out — beside
`accountView` and `cardAction`, tested with no DOM. `app.js` takes that object
and sets `hidden` flags.

The phase region gets `aria-live="polite"` (precedent: `#thumbs`,
`web/index.html:94`) so the transition from waiting to linked is announced. The
code input takes the same `autocomplete="off" spellcheck="false"` treatment as
the branch and repo inputs.

## Testing

A `writeFakeLoginCli(dir, {provider, mode})` helper parallel to
`test/helpers/fake-codex.ts`: a generated real executable that prints the URL on
the correct stream, optionally emits the `Paste code here` prompt and reads
stdin, writes plausible credentials into the dir named by
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`, and answers `auth status --json` / `login
status`. Modes: `ok`, `no-prompt`, `bad-code`, `no-url`, `slow`.

**The Codex fake never binds port 1455.** It prints a URL and exits, so
`npm test` opens no socket and no browser — which keeps this inside the AGENTS.md
rule about no paid, networked or real-account tests.

The state machine runs against the real fake executable by default, so stream
parsing, stdin relay and exit handling are genuinely exercised; the injected
`spawnLogin` seam is for conditions a real child cannot produce on demand.
Timeouts are passed in as parameters, as `probeLimits(env, timeoutMs = 30_000)`
already does (`src/agents/claude.ts:435-437`).

- **`link.ts`** — URL scraped from either stream; a decoy URL printed first is
  ignored; prompt detected → code relayed → completion; no prompt → straight to
  `verifying`; no URL in window → redacted-tail failure; timeout and cancel both
  kill the child and remove staging; identity readback for both providers
  including the `id_token` decode; duplicate identity refused; **an `auth.json`
  with no `id_token` still links, with a numbered fallback name and no duplicate
  check**; staging renamed on confirm and absent on every failure path.
- **`accounts.ts`** — missing file loads as `[]`; name validation rejects `..`,
  `/`, empty, over-length, uppercase and collisions; write is temp-then-rename.
  And directly: rewrite `accounts.json` on disk mid-link, then confirm — the
  hand edit must survive on disk while only the new entry enters memory.
- **`server.test.ts`** — each 409 out of phase; unlink refused with a live
  session and with each queued shape; unlink allowed over `done`/`stopped`,
  after which `resume` returns "account no longer configured"; linking disabled
  when the `accountStore` seam is absent.
- **`ui.test.ts`** — `linkView` per phase, no DOM.

Two tests to write first:

1. **Unlink never removes a directory outside `~/.switchboard/accounts/`.** Set
   up an account whose env points at a `~/.claude-alt`-shaped path, unlink,
   assert the directory still exists. This is what stands between a bug and a
   user's real credentials.
2. **The snapshot contains neither the staging path nor the submitted code.**
   Drive a full link with a sentinel in each, serialize `snapshot()`, assert
   absence. Enforces the AGENTS.md rule that account env values never reach SSE.

`test/palette.test.ts` needs no changes, provided the tokens-only rule holds —
and fails loudly if it does not.
