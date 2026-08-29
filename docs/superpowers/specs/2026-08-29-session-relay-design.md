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

## The gate is the tool-approval flow that already exists

The earlier sketch of this feature put the hold on the receiver: B gets a
message and waits for the human to release it. That needed new session state, a
new control on the card, and a new meaning for `needs-you`, which is currently
bound to `session.pending` and resolves through the adapter's approval callback
into the SDK. A held message is not an SDK approval, so none of that fit.

Putting the gate on the sender costs nothing, because a relay *is* a tool call.
`canUseTool` (`src/agents/claude.ts:319`) fires for every tool call including
MCP ones, builds an `ApprovalRequest`, and emits it as the approval card. The
human approves the message on the sending session's card, and only then does it
go.

The per-session toggle this feature seemed to need also already exists: `auto`.
Off, the human approves each message; on, the agents collaborate unattended.
That is the same fork, with no new field, no new default, and no new UI.

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
5. The chain is under the hop cap. Otherwise `hop-limit`.

On success it appends the text to the target's transcript as a prompt and hands
it to the target's handle, exactly as the `send` command does. Delivery timing
is therefore whatever that path already does: a target mid-turn queues the
message and picks it up when the turn ends.

The function returns a discriminated result rather than throwing, because its
caller is a tool handler whose return value the model reads.

### Hop counting

One new field, `Session.relayHops: number`, defaulting to 0.

On a successful relay, the target's count becomes the sender's plus one. Over
the cap (3), the relay is rejected with `hop-limit` and nothing is delivered.
Any human-originated prompt to a session — a `send` from the composer, or the
prompt a session is created with — resets that session's count to 0, because a
human speaking is what ends a chain.

With approval on, the cap is close to unreachable: each hop needs a click. It
earns its place only for sessions running with `auto` on, which is exactly the
configuration where nothing else stops a loop.

An earlier decision had the cap divert a message to `needs-you` instead of
rejecting it. Rejection replaces that: with the gate on the sender there is no
receiver-side held state to divert into, and a rejected tool call surfaces to
the human through the sending agent anyway.

### `StartOpts.relay` — how the adapter reaches the Registry

Adapters do not know their session id and have no Registry access; they emit
events and stay ignorant of the store. That separation is worth keeping.

So `StartOpts` gains an optional `relay` callback. The server builds it per
launch, closing over the session id and the Registry, and the adapter wires it
into a tool handler. The adapter calls a function it was handed, the same way it
already calls `emit`.

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

Pure autocomplete. `web/lib.js` already has `commandMenu` driving the
slash-command menu; an `@` menu mirrors it, listing same-repo sessions by branch
and inserting the branch name as plain text.

There is no plumbing behind the mention. The agent already has `list_sessions`
and `send_to_session`; naming a session in a prompt is enough for it to act. The
menu exists so the human can name one correctly without checking the grid, and
adding delivery semantics to the mention itself would duplicate the tools.

## Error handling

Every `RelayResult` other than success leaves the target untouched — no
transcript entry, no hop increment. The sending agent receives the reason as its
tool result and can react.

A relay whose approval the human denies never reaches `relay()` at all; the SDK
returns the denial as the tool result, which is the existing behaviour for every
denied tool call.

## Testing

Offline throughout, using the simulator adapter and the existing `boot()`
harness.

- `relay()` unit tests over the five rejection rules and the success path,
  driving the Registry directly.
- Hop counting: a chain reaching the cap is rejected; a human `send` to a
  session in that chain resets it and the next relay succeeds.
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
