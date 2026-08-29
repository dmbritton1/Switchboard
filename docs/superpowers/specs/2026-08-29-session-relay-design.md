# Session relay — design

Let a Claude session send a message to another session on the same repo, so two
agents working different branches of the same problem can coordinate instead of
discovering each other's work at merge time. The human approves each message
through the approval card that already exists.

This is phase 1 of a larger idea — agents collaborating across accounts. It
covers Claude sending. Codex sending is deliberately out of scope; see the end.

## Sending is the only asymmetric half

A relayed message arrives as a prompt: `registry.appendPrompt` then
`handle.send`, the same path a follow-up typed into the composer takes. Both
providers already do that — Codex persists follow-ups as `queued` and delivers
them `sent` in FIFO order, which is documented and tested.

So a session *receiving* a relay needs nothing built, on either provider. All
the provider difference lives in sending, and that is the whole reason this
phase is worth shipping alone: registering the tool on the Claude adapter gets
Claude→Claude and Claude→Codex at once, without touching Codex at all.

## Approval opens a channel, not a message

The earlier sketch of this feature put the hold on the receiver: B gets a
message and waits for the human to release it. That needed new session state, a
new control on the card, and a new meaning for `needs-you`, which is currently
bound to `session.pending` and resolves through the adapter's approval callback
into the SDK. A held message is not an SDK approval, so none of that fit.

Putting the gate on the sender costs nothing, because a relay *is* a tool call.
`canUseTool` (`src/agents/claude.ts:319`) fires for every tool call including
MCP ones, builds an `ApprovalRequest`, and emits it as the approval card.

But approving every message would be the wrong unit. A useful exchange between
two agents is many messages, and a card per message turns collaboration into
clicking. So the approval opens a **channel** between the two sessions: the
first relay between a pair asks, and once it succeeds the pair talks freely.

A channel is an unordered pair of session ids with a count of exchanges since it
was last confirmed. It is process-local, like `AccountLimitSnapshot`, and needs
no persistence: `Registry.load` forces every session to `stopped` on start
(`src/sessions.ts:578`), and a stopped session has no live handle, so no channel
can outlive the process in a form that could still be used.

A channel is a property of the pair, not of a direction, so opening one binds
both ends: once A's send is approved, B may reply without a card of its own,
even if B is the more closely supervised of the two. That is deliberate. The
alternative — keying channels by direction so each session's owner approves only
its own outbound messages — buys a distinction that costs a second map entry per
conversation and a checkpoint that fires per direction rather than per exchange.
Approving a send is taken as approving the conversation it starts.

Nothing hooks the approval decision. The gate is consulted before the tool runs;
if the human allows, the tool executes; a successful `relay()` marks the channel
open. A denial means the tool never ran, the channel stays closed, and the next
attempt asks again. The existing Allow/Deny card is the whole interface.

## Checkpoints replace the hop limit

Counting hops per session was the wrong shape — a chain is a property of a pair,
not of either end. The channel's exchange count replaces it.

When the count crosses the cap (10), the channel closes *after* delivering that
message. The next relay between that pair therefore asks again, and the card
carries a note saying how many messages have been exchanged. Allow reopens the
channel and resets the count; Deny leaves it closed. That is the continue-or-stop
choice, using the two buttons the card already has.

This is a periodic check-in rather than a wall. The conversation never dies
silently and never runs unbounded, and the human decides at each checkpoint
whether it is still worth what it is spending.

`auto` means one thing here and means it completely: never ask about relays. It
skips the opening approval and it skips checkpoints too, so an `auto` session
opens channels and carries them past every checkpoint without a card.

That removes the only loop protection this design has, and the trade is
deliberate. `auto` already means "I have decided not to supervise this session":
such a session runs unbounded Bash, makes unlimited edits, and spends its budget
without asking. Relaying is consistent with that posture. What differs is the
blast radius — an ordinary `auto` session spends one account, and an `auto`
relay chain spends two — so this is a setting to turn on knowing that, not a
default to drift into.

## Transport: in-process, not a subprocess

The Claude SDK accepts stdio, SSE, HTTP and in-process MCP servers. This uses
in-process (`createSdkMcpServer`), matching `browser.ts` and `simulator.ts`.

A stdio subprocess would be the right choice if Codex were sending in this
phase, since Codex is a separate process and cannot call into Switchboard's JS.
It is not, so a subprocess here would be machinery built for a phase that may
not survive its own open question. The duplication that would normally argue for
building the shared transport first does not arise: what the two transports
would share is the relay function below, not the MCP plumbing around it.

## Components

### `src/relay.ts` — the relay function

`relay(deps, fromSessionId, targetSessionId, text): Promise<RelayResult>`,
where `deps` carries the Registry and the live handle map.

Rules, in order, each failing before anything is delivered:

1. The target exists. Otherwise `unknown-session`.
2. The target is not the sender. Otherwise `self`.
3. The target's `repo` equals the sender's. Otherwise `different-repo`. This
   reuses the boundary `merge` and `push` already enforce, and same-repo
   sessions are exactly the ones whose work can collide.
4. The target has a live handle. Otherwise `not-live` — a stopped session cannot
   act on a message, and silently accepting one would strand it.

On success it appends the text to the target's transcript as a prompt and hands
it to the target's handle, exactly as the `send` command does. Delivery timing
is therefore whatever that path already does: a target mid-turn queues the
message and picks it up when the turn ends.

`relay()` does not itself check whether the pair is approved. The gate lives in
`canUseTool`, which runs first and is what puts the card up; by the time
`relay()` is called the human has already allowed this send, and re-checking
here would reject the very first message of a channel — the one the approval was
for. What `relay()` does on success is *open* the channel and increment it.

The function returns a discriminated result rather than throwing, because its
caller is a tool handler whose return value the model reads.

### Channel state

A map keyed by the unordered pair of session ids, holding `{ open, exchanges }`.
Process-local, held by the server beside the handle map.

`relayGate()` reads it; `relay()` writes it. A successful send opens the channel
and increments `exchanges`, and closes it again once the count crosses the cap,
so the next attempt is gated and the human is asked to continue or stop. Deleting a session drops every channel naming it.

No field is added to `Session`. An earlier draft put `relayHops` there, which
was wrong twice over: it made a pair's property look like a session's, and it
put it in persisted state that could outlive the handles that give it meaning.

### `StartOpts.relay` and `relayGate` — how the adapter reaches the Registry

Adapters do not know their session id and have no Registry access; they emit
events and stay ignorant of the store. That separation is worth keeping.

So `StartOpts` gains two optional callbacks, both built by the server per launch
and both closing over the session id and the Registry. The adapter calls
functions it was handed, the same way it already calls `emit`.

`relay(target, text)` performs the send. `relayGate(target)` answers whether this
send needs a card, returning `{ ask, note? }`; `canUseTool` consults it for
`send_to_session` and appends `note` to the summary, which is how a checkpoint
card explains itself. The gate is a separate callback because `canUseTool` runs
*before* the tool does and so cannot learn the answer from the send.

The session's identity comes from that closure and never from a tool argument,
so an agent cannot send as another session by naming one.

This is a cooperative rail, not access control. `/command` has a Host guard and
an Origin guard but no authentication (`src/server.ts:236,261`), and `curl`
sends no Origin — so any agent can already POST to it directly and bypass all of
this. The rails make the tool well-defined; they do not constrain a determined
agent. Making them constraining is a different project that starts with
authenticating `/command`.

### The MCP server

Built inside `claudeAdapter.start()` when `opts.relay` is present, and merged
into the existing module-level `mcpServers` map for that launch only. Two tools:

**`list_sessions()`** — the sessions this one may reach: same repo, excluding
itself. Each carries id, branch, account and status. Status is load-bearing: it
is the difference between "this will be picked up shortly" and "that session is
stopped and will never see it". Account is included because working across
accounts is the point.

**`send_to_session(session, text)`** — delivers, returning what happened:
delivered, queued behind the target's current turn, or rejected with the reason.
An agent told `not-live` should say so rather than assume it got through.

No tool for reading another session's transcript. Moving context between
sessions is already solved by handoff's rendered document; a live transcript
peek is a second, worse answer to a settled question.

### The approval card

`summarize` (`src/agents/claude.ts:42`) gains a case for `send_to_session` so
the card reads as the target and the message rather than a generic tool name.
The message text is the thing the human is approving, so it has to be on the
card.

### `@session` in the composer

An `@` menu mirroring the slash-command menu `commandMenu` already drives in
`web/lib.js`, listing same-repo sessions by branch.

Picking one inserts not just the branch name but a short instruction naming what
it is — that `feat-login` is another session on this repo, reachable with
`send_to_session`. Still plain text with no plumbing behind it, but the agent is
told what the token means rather than left to infer it from an `@`.

That inference is the only thing the cheaper version would have been relying on,
and it fails invisibly: an agent that answers from its own knowledge instead of
messaging looks exactly like an agent that had nothing to say. One sentence of
inserted text removes the doubt.

The mention still does nothing by itself. It does not fetch the other session's
context, does not notify it, and does not send anything — the agent decides, and
the first send opens a channel through the normal approval.

## Error handling

Every `RelayResult` other than success leaves the target untouched — no
transcript entry, no change to the channel's count. The sending agent receives the reason as its
tool result and can react.

A relay whose approval the human denies never reaches `relay()` at all; the SDK
returns the denial as the tool result, which is the existing behaviour for every
denied tool call.

## Testing

Offline throughout, using the simulator adapter and the existing `boot()`
harness.

- `relay()` unit tests over the four rejection rules and the success path,
  driving the Registry directly.
- Channels: the first relay between a pair is gated and the second is not; a
  denial leaves the channel closed so the next attempt is gated again.
- Checkpoints: crossing the cap closes the channel, so the next relay from a
  supervised session is gated and allowing it resets the count — while a session
  with `auto` on carries past the same checkpoint without a card.
- Deleting a session drops the channels naming it.
- Delivery: a relay to a live session appends the prompt and calls the target's
  handle; a relay to a stopped session does neither.
- `list_sessions` filtering: same-repo only, self excluded.
- The `@` menu as a pure function in `lib.js`, tested the way `commandMenu` and
  `handoffTargets` are.

The approval card itself is covered by the existing `canUseTool` path; the only
new thing worth asserting there is that `summarize` renders the target and
message.

## Out of scope

- **Codex sending.** Needs the MCP server registered through
  `new Codex({ config: { mcp_servers: … } })` — verified supported by the
  installed SDK — plus an unresolved question: whether an MCP tool can run at
  all under `approvalPolicy: 'never'`, or fails closed. It is also unattended by
  construction, since Codex has no approval callback and therefore no card, so
  it needs a server-side gate that this phase does not design. Codex
  *receiving* works in this phase already.
- **Overlap detection.** Computing which sessions have touched the same files,
  from the paths `worktreeStatus` currently discards. A better primary answer to
  "stop them stepping on each other" than messaging is, and deliberately
  deferred rather than dropped.
- **Reading another session's transcript.**
- **Authenticating `/command`.**
