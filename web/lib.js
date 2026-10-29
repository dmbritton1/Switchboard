// DOM-free view logic, imported by app.js and covered by test/ui.test.ts.
// Everything else in app.js is DOM assembly, verified by using it — this file
// is the part with branches worth locking down.

const ORDER = { 'needs-you': 0, working: 1, done: 2, stopped: 3 };

const MIXED = 'Selected worktrees belong to different repos — pick worktrees from one repo';
const basename = (p) => p.split('/').filter(Boolean).pop() ?? p;

const byBlocked = (a, b) => ORDER[a.status] - ORDER[b.status] || b.statusSince - a.statusSince;

/**
 * Grid order. `blocked` is the default and the original behavior: blocked
 * first, then running, then finished, most recently changed first within each.
 * `newest` is a flat recency list. `account` groups by account name and falls
 * back to `blocked` inside each group, so grouping never costs you the
 * blocked-first reflex within the account you are looking at.
 */
export function sortSessions(sessions, mode = 'blocked') {
  const cmp = mode === 'newest'
    ? (a, b) => b.statusSince - a.statusSince
    : mode === 'account'
      ? (a, b) => a.account.localeCompare(b.account) || byBlocked(a, b)
      : byBlocked;
  return [...sessions].sort(cmp);
}

/** Hides finished sessions when the setting asks. `stopped` is deliberately not
 *  hidden: it carries a Resume button and unfinished work, unlike `done`. */
export function visibleSessions(sessions, collapseDone) {
  return collapseDone ? sessions.filter((s) => s.status !== 'done') : sessions;
}

/**
 * Which action a card's single slot gets. `queue` is the scheduling queue from
 * the SSE snapshot; it does not exist until the scheduling work lands, so it
 * defaults to empty and the 'waiting' branch is simply never taken today.
 */
export function cardAction(session, queue = []) {
  if (session.pending) return { kind: 'approve' };
  if (session.status === 'working' || session.status === 'needs-you') return { kind: 'stop' };
  if (session.status === 'stopped') {
    const held = queue.find(
      (q) => q.state === 'waiting'
        && q.trigger?.kind === 'reset'
        && q.action?.kind === 'resume'
        && q.action.sessionId === session.id,
    );
    return held ? { kind: 'waiting', account: held.trigger.account } : { kind: 'resume' };
  }
  return { kind: 'none' };
}

/**
 * The accounts a session can be handed off to. Empty means the menu item is
 * hidden; otherwise it is exactly what fills the dialog's dropdown, so the gate
 * and the choices can never disagree.
 *
 * `working` and `needs-you` are excluded because handoff commits the source
 * worktree, and a running agent's half-written files must not be captured
 * underneath it — the same rule the server enforces. The session's own account
 * is excluded because handing off to it goes nowhere.
 */
export function handoffTargets(session, accounts) {
  if (session.status !== 'done' && session.status !== 'stopped') return [];
  return accounts.filter((a) => a.name !== session.account);
}

// Mirrors src/overlap.ts's MAX_LISTED_PATHS: web/lib.js is a browser module
// with no build step, so it can't import a constant from that TypeScript file.
// The duplication is a considered cost of that boundary, not an oversight —
// change both if the number ever moves.
const MAX_LISTED_PATHS = 10;

/**
 * A path list for a card tooltip, bounded so neither grows unread. Mirrors
 * src/overlap.ts's summarizePaths so the two surfaces read the same way,
 * except `total` is a separate argument here: `/status` now sends `files`
 * pre-capped at MAX_LISTED_PATHS plus the true `count` alongside it, so the
 * tail has to be computed from that true count rather than from the (already
 * capped) list's own length — otherwise a capped list would claim there is
 * nothing more to see.
 */
function summarizePaths(files, total = files.length) {
  if (total <= MAX_LISTED_PATHS) return files.join(', ');
  const shown = files.slice(0, MAX_LISTED_PATHS).join(', ');
  return `${shown}, and ${total - MAX_LISTED_PATHS} more`;
}

/**
 * The coupling badges for one session's /status response: `text` follows the
 * existing `+N −M · dirty`, `title` is the tooltip.
 *
 * Talking wins over overlapping for a given pair. Two sessions editing one file
 * and talking about it is coordination working; the same two in silence is a
 * merge conflict that has not happened yet, and only the second is worth a
 * warning. Flagging both would cry wolf on the healthy case.
 *
 * Advisory throughout: "also in", never "locked by". Nothing here prevents
 * anything, and wording that implies otherwise would be a lie.
 *
 * The badge text always reports the true overlap count; only the tooltip's
 * file list is capped, so the number never lies about how much actually
 * overlaps even when the list behind it is trimmed.
 */
export function couplingBadges(status) {
  const talking = status?.talking ?? [];
  const overlapping = status?.overlapping ?? [];
  const talkingIds = new Set(talking.map((t) => t.id));
  const silent = overlapping.filter((o) => !talkingIds.has(o.id));

  const parts = [
    ...talking.map((t) => `↔ ${t.branch}`),
    ...silent.map((o) => {
      const count = o.count ?? o.files.length;
      return `⚠ ${count} file${count === 1 ? '' : 's'} also in ${o.branch}`;
    }),
  ];
  const title = silent
    .map((o) => `${o.branch}: ${summarizePaths(o.files, o.count ?? o.files.length)}`)
    .join('\n');
  return { text: parts.join(' · '), title };
}

/**
 * The `@` mention menu, the same shape commandMenu returns for slash commands:
 * `{ query, matches }`, or null when the caret is not inside a mention.
 *
 * A mention runs from an `@` to the caret with no whitespace between, so the
 * menu closes as soon as the sentence moves on.
 */
export function mentionMenu(text, caret, sessions) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, matches: sessions.filter((s) => s.branch.includes(query)) };
}

/**
 * What picking a session inserts. Not just the branch name: the agent would be
 * left inferring that a name with an `@` in front means "go talk to that", and
 * that inference fails invisibly — an agent answering from its own knowledge
 * looks exactly like one that had nothing to say. One sentence removes the doubt.
 */
export function mentionInsert(session) {
  return `${session.branch} (another session on this repo — reach it with send_to_session)`;
}

/**
 * The buttons a pending request gets: `{ label, description, command }`, where
 * `command` is merged into the decide call. An AskUserQuestion carries
 * `options`, and each one answers the question outright, captioned with the
 * agent's own explanation of that choice; Skip denies it normally so the agent
 * falls back to asking in prose, which the composer can answer. Everything else
 * is the usual Allow/Deny, which needs no caption.
 */
export function decideSpecs(pending) {
  if (!pending.options?.length) {
    return [
      { label: 'Allow', command: { allow: true } },
      { label: 'Deny', command: { allow: false } },
    ];
  }
  return [
    ...pending.options.map(({ label, description }) => ({
      label,
      description,
      command: { answer: label },
    })),
    { label: 'Skip', description: 'None of these — answer in your own words instead.', command: { allow: false } },
  ];
}

/** A queue item's trigger, rendered for the queue strip. */
export function triggerLabel(t) {
  if (t.kind === 'at') return new Date(t.time).toLocaleString();
  return `when ${t.account} resets`;
}

/**
 * A queue item's target, rendered for the queue strip. `sessions` is passed in
 * rather than read from a module global, the way `selectionState` already
 * takes `sessions` and `selected` as arguments — that's what keeps this DOM-free
 * and testable.
 */
export function targetLabel(action, sessions) {
  if (action.kind === 'create') return `${action.branch} · new worktree`;
  const s = sessions.find((x) => x.id === action.sessionId);
  const branch = s ? s.branch : 'deleted session';
  return action.kind === 'resume' ? `${branch} · resume` : `${branch} · message`;
}

/**
 * Label and button states for the selection bar. The same-repo rule is the
 * authoritative one server-side (selectedRepo() in server.ts) — this is the
 * courtesy that disables the buttons instead of erroring after the click.
 */
export function selectionState(sessions, selected) {
  const chosen = sessions.filter((s) => selected.has(s.id));
  if (!chosen.length) {
    return { count: 0, label: '', merge: { enabled: false, reason: '' }, push: { enabled: false, reason: '' } };
  }
  const repos = new Set(chosen.map((s) => s.repo));
  const mixed = repos.size > 1;
  const busy = chosen.find((s) => s.status === 'working' || s.status === 'needs-you');
  return {
    count: chosen.length,
    label: mixed
      ? `${chosen.length} selected across ${repos.size} repos`
      : `${chosen.length} selected · ${basename(chosen[0].repo)}`,
    merge: {
      enabled: !mixed && !busy,
      reason: mixed ? MIXED : busy ? `"${busy.branch}" is still running — stop it or wait` : '',
    },
    push: { enabled: !mixed, reason: mixed ? MIXED : '' },
  };
}

/**
 * The transcript with consecutive tool messages folded into one collapsible
 * run, so a stretch of Read/Bash/Edit chatter costs one line instead of twenty.
 * Everything else passes through as `{ kind: 'msg', msg }`, and a run of one is
 * demoted back to a plain message — wrapping a single line in a disclosure
 * widget trades noise for noise.
 *
 * `at` is the index of the run's first message. The transcript is append-only,
 * so that index is a stable key for "did the user expand this run?" across the
 * full rebuild render() does on every SSE snapshot.
 */
export function groupTranscript(transcript) {
  const out = [];
  for (const [i, msg] of transcript.entries()) {
    const last = out.at(-1);
    if (msg.kind !== 'tool') out.push({ kind: 'msg', msg });
    else if (last?.kind === 'tools') last.msgs.push(msg);
    else out.push({ kind: 'tools', at: i, msgs: [msg] });
  }
  return out.map((g) => (g.kind === 'tools' && g.msgs.length === 1
    ? { kind: 'msg', msg: g.msgs[0] }
    : g));
}

/**
 * The one line a collapsed run shows. Tool names, not summaries: the summaries
 * are the thing being hidden, and the names are what tells you whether the run
 * was reading around or rewriting your files. Unresolved state (running, failed)
 * is on the label because that is what decides whether it is worth opening.
 */
export function toolRunLabel(msgs) {
  const names = [...new Set(msgs.map((m) => m.name))];
  const failed = msgs.filter((m) => m.status === 'error').length;
  return `${msgs.length} tool calls · ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
    + (failed ? ` · ${failed} failed` : '')
    + (msgs.some((m) => m.status === 'running') ? ' · running' : '');
}

/**
 * How a resolved tool call presents its output: `label` goes on the call's one
 * line, `fold` says whether the full text is worth hiding behind a disclosure.
 *
 * Long output is measured, not shown — the size is what tells you whether
 * opening it is worth it. A short single-line result is exempt: it is already
 * its own best summary, and folding it would cost a click to reveal less than
 * the click did.
 */
export function resultMeta(result) {
  const text = (result ?? '').replace(/\n+$/, '');
  if (!text) return { label: '', fold: false };
  const lines = text.split('\n');
  if (lines.length === 1 && text.length <= 80) return { label: text, fold: false };
  return { label: `${lines.length} line${lines.length === 1 ? '' : 's'}`, fold: true };
}

// A prompt this many lines, or this many characters, is long enough that
// showing it in full pushes every reply below it off screen — a pasted spec
// or stack trace reads as "prompt, prompt, prompt, then finally the agent
// says something." Chosen to comfortably fit a short paragraph or two, the
// common case, while still catching anything meant to be read by scrolling.
const PROMPT_FOLD_LINES = 6;
const PROMPT_FOLD_CHARS = 600;

/**
 * Where to fold a long user prompt, or null if it is short enough to show in
 * full. `head` and `rest` always concatenate back to the original text
 * exactly — no ellipsis or other marker is spliced in — so the visible part
 * is never gibberish and the full prompt is still exactly what was sent, not
 * a lossy reconstruction of it.
 *
 * A prompt with real line breaks (the common paste) folds at a line boundary,
 * which keeps whole paragraphs intact on each side. One with no line breaks
 * to speak of (or absurdly long ones) instead folds near the character cap,
 * on the nearest word boundary so the visible edge doesn't end mid-word.
 */
export function promptFold(text) {
  const lines = text.split('\n');
  if (lines.length <= PROMPT_FOLD_LINES && text.length <= PROMPT_FOLD_CHARS) return null;
  if (lines.length > PROMPT_FOLD_LINES) {
    return {
      head: lines.slice(0, PROMPT_FOLD_LINES).join('\n'),
      rest: `\n${lines.slice(PROMPT_FOLD_LINES).join('\n')}`,
    };
  }
  let cut = text.lastIndexOf(' ', PROMPT_FOLD_CHARS);
  // No space anywhere near the cap (one very long token) — just cut on it.
  if (cut < PROMPT_FOLD_CHARS * 0.5) cut = PROMPT_FOLD_CHARS;
  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

/**
 * The message that actually reaches the agent: what the user typed, then the
 * paths of whatever they attached, one per line.
 *
 * The paths ride in the text because no adapter accepts attachments — see
 * docs/superpowers/specs/2026-07-30-file-upload-design.md. They are appended
 * at send time instead of being typed into the box, so the composer can show a
 * removable chip rather than a path the user has to delete by hand.
 */
export function composeMessage(text, paths) {
  return [text.trim(), ...paths].filter(Boolean).join('\n');
}

// Every pasted screenshot arrives named "image.png", and the upload route
// overwrites by name — so two pastes in one message would collide and both
// paths in the prompt would point at the second image. Stamp them unique.
export function pastedName(name, at = Date.now(), i = 0) {
  return `paste-${at}-${i}-${name || 'image.png'}`;
}

export const CODEX_FAILURE_LABEL = Object.freeze({
  codex_platform_unsupported: 'Unsupported platform',
  codex_binary_missing: 'Codex executable missing',
  codex_binary_not_executable: 'Codex executable is not runnable',
  codex_version_unreadable: 'Codex version unavailable',
  codex_version_mismatch: 'Codex version mismatch',
  codex_auth_unavailable: 'Codex login unavailable',
  codex_start_failed: 'Codex failed to start',
  codex_resume_failed: 'Codex failed to resume',
  codex_app_server_unavailable: 'Codex app-server unavailable',
  codex_protocol_mismatch: 'Codex app-server protocol mismatch',
  codex_app_server_initialization_failed: 'Codex app-server initialization failed',
  codex_transport_crashed: 'Codex app-server transport crashed',
  codex_request_timed_out: 'Codex app-server request timed out',
  codex_stream_failed: 'Codex stream failed',
  codex_usage_limited: 'Codex usage limit reached',
  codex_sandbox_denied: 'Blocked by worktree sandbox',
  codex_user_stopped: 'Stopped by you',
});

export async function postCommand(body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: `Switchboard request failed: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}

export function commandFailure(result) {
  if (result.ok) return '';
  return String(result.data?.error ?? `Command failed with HTTP ${result.status}`);
}

export function retainedSessionError(sessionId, result) {
  const message = commandFailure(result);
  return message ? { sessionId, message } : null;
}

/** Keep upload metadata in the browser while sending only server-issued paths. */
export function addAttachment(list, attachment) {
  return list.some((item) => item.path === attachment.path)
    ? list
    : [...list, attachment];
}

export function removeAttachment(list, path) {
  return list.filter((item) => item.path !== path);
}

export function sendPayload(sessionId, text, attachments) {
  return {
    cmd: 'send', id: sessionId, text,
    attachments: attachments.map((item) => item.path),
  };
}

/** Transactional composer state: a rejected command remains retryable. */
export function settleSendState(text, attachments, result) {
  return result.ok ? { text: '', attachments: [] } : { text, attachments };
}

/** Detach browser-live FileList entries before the input is reset. */
export function snapshotFiles(iterable) {
  return Array.from(iterable ?? []);
}

/** Convert the settings form's string controls into an omission-preserving payload. */
export function codexSettingsFromForm(values) {
  const model = String(values.model ?? '').trim();
  const settings = {
    ...(model ? { model } : {}),
    ...(values.reasoning ? { modelReasoningEffort: values.reasoning } : {}),
    ...(values.webSearch ? { webSearchMode: values.webSearch } : {}),
    ...(values.network === 'enabled' ? { networkAccessEnabled: true } : {}),
    ...(values.network === 'disabled' ? { networkAccessEnabled: false } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

/** A compact stopped-session menu label that still exposes explicit false. */
export function codexSettingsSummary(settings) {
  if (!settings || Object.keys(settings).length === 0) return 'Inherit';
  const values = [];
  if (settings.model) values.push(`Model: ${settings.model}`);
  if (settings.modelReasoningEffort) values.push(`Reasoning: ${settings.modelReasoningEffort}`);
  if (settings.webSearchMode) values.push(`Web search: ${settings.webSearchMode}`);
  if (settings.networkAccessEnabled !== undefined) values.push(`Network: ${settings.networkAccessEnabled ? 'Enabled' : 'Disabled'}`);
  return values.join(' · ');
}

export function usageLines(usage) {
  if (!usage) return [];
  const lines = [
    `input: ${usage.inputTokens}`,
    `output: ${usage.outputTokens}`,
  ];
  if (usage.cachedInputTokens !== undefined) {
    lines.push(`cached input: ${usage.cachedInputTokens}`);
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    lines.push(`cache write input: ${usage.cacheWriteInputTokens}`);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    lines.push(`reasoning output: ${usage.reasoningOutputTokens}`);
  }
  return lines;
}

/** Browser-local attachment lifecycle state, deliberately independent of DOM. */
export function createAttachmentController() {
  return {
    sessionId: null,
    generation: 0,
    pendingAttachments: [],
    uploadsInFlight: 0,
    sendInFlight: false,
    uploadError: '',
  };
}

export function changeAttachmentSession(controller, sessionId) {
  if (controller.sessionId === sessionId) return false;
  controller.sessionId = sessionId;
  controller.generation++;
  controller.pendingAttachments = [];
  controller.uploadsInFlight = 0;
  controller.sendInFlight = false;
  controller.uploadError = '';
  return true;
}

function currentAttachmentOperation(controller, operation) {
  return Boolean(operation
    && !operation.finished
    && operation.sessionId === controller.sessionId
    && operation.generation === controller.generation);
}

export function beginAttachmentUpload(controller) {
  if (!controller.sessionId || controller.sendInFlight) return null;
  controller.uploadsInFlight++;
  controller.uploadError = '';
  return {
    sessionId: controller.sessionId,
    generation: controller.generation,
    finished: false,
  };
}

export function addUploadedAttachment(controller, operation, attachment) {
  if (!currentAttachmentOperation(controller, operation)) return false;
  controller.pendingAttachments = addAttachment(controller.pendingAttachments, attachment);
  return true;
}

export function finishAttachmentUpload(controller, operation, error = '') {
  if (!operation || operation.finished) return false;
  const current = currentAttachmentOperation(controller, operation);
  operation.finished = true;
  if (!current) return false;
  controller.uploadsInFlight = Math.max(0, controller.uploadsInFlight - 1);
  if (error) controller.uploadError = error;
  return true;
}

export function dismissAttachmentUploadError(controller) {
  controller.uploadError = '';
}

export function attachmentComposerBusy(controller) {
  return controller.uploadsInFlight > 0 || controller.sendInFlight;
}

export function beginAttachmentSend(controller, text) {
  if (!controller.sessionId || attachmentComposerBusy(controller)) return null;
  controller.sendInFlight = true;
  return {
    sessionId: controller.sessionId,
    generation: controller.generation,
    text,
    attachments: controller.pendingAttachments,
    finished: false,
  };
}

export function completeAttachmentSend(controller, operation, result) {
  if (!currentAttachmentOperation(controller, operation)) {
    if (operation) operation.finished = true;
    return { applied: false, text: null };
  }
  operation.finished = true;
  controller.sendInFlight = false;
  const settled = settleSendState(operation.text, operation.attachments, result);
  controller.pendingAttachments = settled.attachments;
  return { applied: true, text: settled.text };
}

/**
 * The text for the retained session error, or '' when there is none.
 *
 * Deviation from the plan, which said to clear this region whenever `openId`
 * changes: the grid's Allow/Deny and Stop buttons act on a session other than
 * the open one, so clearing on navigation drops exactly the failure the user
 * needs. It is retained instead — and because it can therefore belong to a
 * session that is nowhere on screen, it is named. `sessions` is passed in
 * rather than read from a module global, like selectionState() above.
 */
export function commandErrorText(error, sessions, openId) {
  if (!error) return '';
  if (error.sessionId === openId) return error.message;
  const session = sessions.find((s) => s.id === error.sessionId);
  return session ? `${session.branch}: ${error.message}` : error.message;
}

/**
 * Convert an SSE transcript message into the small, untrusted view model used
 * by the browser renderer. IDs survive only where they are needed as internal
 * lazy-detail keys; no projection puts them into visible text.
 */
export function transcriptView(message) {
  if (message.kind === 'tool') {
    const suffix = message.status === 'running' ? '' : ` · ${message.status}`;
    return {
      kind: 'tool',
      id: message.id ?? '',
      className: `msg tool ${message.status}`,
      summary: `${message.name}: ${message.summary}${suffix}`,
      detailAvailable: message.detailAvailable ?? false,
      detailEvicted: message.detailEvicted ?? false,
      detailRevision: message.detailRevision ?? 0,
      truncated: message.detailTruncated ?? false,
    };
  }
  if (message.kind === 'reasoning') {
    return { kind: 'reasoning', className: 'msg reasoning', summary: message.text };
  }
  if (message.kind === 'todo') {
    return {
      kind: 'todo',
      className: 'msg todo',
      items: message.items.map(({ text, completed }) => ({ text, completed })),
    };
  }
  const attachments = message.kind === 'user' && Array.isArray(message.attachments)
    ? message.attachments
      .filter((name) => typeof name === 'string')
      .map((name) => name.split(/[\\/]/).filter(Boolean).pop() ?? '')
      .filter((name) => name && name !== '.' && name !== '..')
    : [];
  return {
    kind: 'text', className: `msg ${message.kind}`, summary: message.text,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Collision-free key for browser-local detail state. */
export function detailKey(sessionId, itemId) {
  return JSON.stringify([sessionId, itemId]);
}

/** Share one in-flight request for one exact session/item/revision key. */
export function requestOnce(requests, key, load) {
  const current = requests.get(key);
  if (current) return current;
  let request;
  request = load().finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

export function needsDetailFetch(view, cached) {
  return view.detailAvailable
    && !view.detailEvicted
    && (!cached || cached.revision !== view.detailRevision);
}

/**
 * The renderer's only detail-state branch table. Keeping it DOM-free makes a
 * destructive transcript rebuild equivalent to the prior render.
 */
export function detailPresentation(view, expanded, cached) {
  if (!expanded || (!view.detailAvailable && !view.detailEvicted)) {
    return { open: false, mode: 'hidden', text: '', fetch: false };
  }
  if (view.detailEvicted) {
    return {
      open: true,
      mode: 'evicted',
      text: 'Detail removed to stay within the storage limit.',
      fetch: false,
    };
  }
  if (!cached || cached.revision !== view.detailRevision) {
    return { open: true, mode: 'loading', text: 'Loading…', fetch: true };
  }
  if (cached.error) {
    return { open: true, mode: 'error', text: cached.error, fetch: false };
  }
  return { open: true, mode: 'content', text: cached.text ?? '', fetch: false };
}

/** Browser-local state for lazy transcript detail, kept DOM-free for testing. */
export function createDetailController() {
  return {
    expandedItems: new Set(),
    detailCache: new Map(),
    detailRequests: new Map(),
    detailSession: null,
    generation: 0,
  };
}

/** Reset every session-scoped collection on a real open, switch, or Back. */
export function changeDetailSession(controller, sessionId) {
  if (controller.detailSession === sessionId) return false;
  controller.expandedItems.clear();
  controller.detailCache.clear();
  controller.detailRequests.clear();
  controller.detailSession = sessionId;
  controller.generation++;
  return true;
}

export function setDetailExpanded(controller, sessionId, itemId, expanded) {
  const key = detailKey(sessionId, itemId);
  if (expanded) controller.expandedItems.add(key);
  else controller.expandedItems.delete(key);
  return key;
}

/**
 * Reconcile one SSE tool projection with browser-local state, then delegate
 * every visible branch to detailPresentation().
 */
export function detailControllerView(controller, sessionId, view) {
  const key = detailKey(sessionId, view.id);
  if (!view.detailAvailable || view.detailEvicted) controller.detailCache.delete(key);
  if (!view.detailAvailable && !view.detailEvicted) controller.expandedItems.delete(key);
  const presentation = detailPresentation(
    view,
    controller.expandedItems.has(key),
    controller.detailCache.get(key),
  );
  return {
    key,
    presentation,
    request: presentation.fetch && controller.detailSession === sessionId
      ? {
          key,
          requestKey: JSON.stringify([key, view.detailRevision]),
          sessionId,
          itemId: view.id,
          revision: view.detailRevision,
          generation: controller.generation,
        }
      : null,
  };
}

function detailRequestIsCurrent(controller, request, currentView) {
  return Boolean(request
    && controller.generation === request.generation
    && controller.detailSession === request.sessionId
    && currentView?.kind === 'tool'
    && currentView.id === request.itemId
    && currentView.detailAvailable
    && !currentView.detailEvicted
    && currentView.detailRevision === request.revision);
}

export function storeToolDetail(controller, request, currentView, detail) {
  if (!detailRequestIsCurrent(controller, request, currentView)
    || detail.revision !== request.revision) return false;
  controller.detailCache.set(request.key, {
    revision: detail.revision,
    text: detail.text,
    truncated: detail.truncated,
  });
  return true;
}

export function storeToolDetailError(controller, request, currentView, error) {
  if (!detailRequestIsCurrent(controller, request, currentView)) return false;
  controller.detailCache.set(request.key, {
    revision: request.revision,
    text: null,
    truncated: false,
    error,
  });
  return true;
}

export function invalidateToolDetail(controller, sessionId, itemId) {
  const key = detailKey(sessionId, itemId);
  controller.detailCache.delete(key);
  return key;
}

export async function fetchToolDetail(sessionId, itemId, fetchImpl = fetch) {
  const params = new URLSearchParams({ session: sessionId, item: itemId });
  let response;
  try {
    response = await fetchImpl(`/detail?${params}`);
  } catch {
    throw new Error('Detail request failed.');
  }
  if (!response.ok) throw new Error(`Detail request failed (HTTP ${response.status}).`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Detail request failed.');
  }
  if (!body || typeof body !== 'object'
    || (body.text !== null && typeof body.text !== 'string')
    || typeof body.truncated !== 'boolean'
    || typeof body.evicted !== 'boolean'
    || typeof body.revision !== 'number'
    || !Number.isFinite(body.revision)) {
    throw new Error('Detail request failed.');
  }
  return body;
}

/**
 * The account the New worktree dialog defaults to.
 *
 * Not simply the lowest `load`. Since real plan limits landed, an account that
 * has them reports true utilization while one that doesn't falls back to the
 * local token-spend estimate — which reads 0% until Switchboard has watched it
 * spend something, and is 0% forever for a provider it can't probe. Ranking
 * those two numbers against each other made every un-probed account the
 * "freest" one available, so the dialog silently defaulted to it. A real number
 * outranks an estimate (`real` in accountView() is the same test); ties fall
 * back to load.
 */
export function freestAccount(accounts) {
  return [...accounts].sort((a, b) => {
    const av = accountView(a);
    const bv = accountView(b);
    return Number(bv.real) - Number(av.real) || av.load - bv.load || a.name.localeCompare(b.name);
  })[0];
}

/**
 * Which sessions just entered a status worth notifying about.
 *
 * Keyed `id:status` rather than by id alone, so needs-you and done are tracked
 * independently and a session that goes needs-you -> working -> needs-you
 * notifies twice, which is two real interruptions.
 *
 * `seed` exists for one reason: EventSource reconnects on its own and the
 * server pushes a full snapshot on connect. Called with seed=true on the first
 * payload after a connect, this fires nothing and returns a seen-set covering
 * everything already on the board — without it, every dropped connection
 * notifies once per finished session for work that ended hours ago.
 *
 * The returned set is rebuilt from the current sessions each call, so a
 * deleted session's keys do not accumulate forever.
 */
export function newlyNotifiable(sessions, notifyOn, seen, seed = false) {
  const watched = sessions.filter((s) => notifyOn.includes(s.status));
  const next = new Set(watched.map((s) => `${s.id}:${s.status}`));
  const fire = seed ? [] : watched.filter((s) => !seen.has(`${s.id}:${s.status}`));
  return { fire, seen: next };
}

const durationLabel = (mins) => (mins % 1440 === 0 ? `${mins / 1440}d`
  : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`);

function viewWindow(value, stale) {
  if (!value || typeof value.id !== 'string' || !value.id
    || !Number.isFinite(value.usedPercent)
    || (value.windowDurationMins !== null
      && (!Number.isFinite(value.windowDurationMins) || value.windowDurationMins <= 0))) return null;
  return {
    id: value.id,
    label: typeof value.label === 'string' && value.label ? value.label : value.id,
    pct: Math.round(Math.max(0, Math.min(100, value.usedPercent))),
    windowDurationMins: value.windowDurationMins,
    resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null,
    reached: value.reached === true,
    stale,
  };
}

function viewBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => (block && typeof block.id === 'string' && block.id
    && typeof block.reason === 'string' && block.reason
    && typeof block.resettable === 'boolean'
    ? [{ id: block.id, reason: block.reason, resettable: block.resettable }] : []));
}

/** The compact, local-time ledger line for one already-normalized window. */
export function usageWindowLine(window) {
  return `${window.label} · ${window.pct}%${window.reached ? ' · reached' : ''}`
    + `${window.resetsAt === null ? '' : ` · resets ${new Date(window.resetsAt).toLocaleString()}`}`
    + `${window.stale ? ' · stale' : ''}`;
}

/**
 * Everything the meter and account panel need to decide what to say, without
 * retaining raw provider data. A snapshot is real only while it is authoritative,
 * fresh, and carries at least one timed window; untimed or stale windows remain
 * available for the expanded ledger but the collapsed meter deliberately falls
 * back to Switchboard's local estimate when no timed headline is available.
 */
export function accountView(a) {
  const l = a.limits;
  const fresh = l?.authoritative === true && l?.fresh === true;
  const windows = Array.isArray(l?.windows)
    ? l.windows.map((w) => viewWindow(w, !fresh)).filter(Boolean).sort(
      (x, y) => (x.windowDurationMins === null ? 1 : 0) - (y.windowDurationMins === null ? 1 : 0)
        || (x.windowDurationMins ?? 0) - (y.windowDurationMins ?? 0)
        || x.id.localeCompare(y.id),
    )
    : [];
  const primary = windows.find((window) => window.windowDurationMins !== null);
  const real = fresh && Boolean(primary);
  const estimatedLoad = Number.isFinite(a.pace) ? a.pace : 0;
  const load = real && Number.isFinite(a.load) ? a.load : estimatedLoad;
  const pct = real ? primary.pct : Math.round(estimatedLoad * 100);
  const plan = typeof l?.plan === 'string' && l.plan && l.plan !== 'unknown' ? l.plan : null;
  const error = typeof a.limitsError === 'string' ? a.limitsError : '';

  if (!real) return {
    load, pct, real: false,
    title: `${a.name} — ~${pct}% of its 5h budget (estimate)`,
    budgetLine: `${a.provider} · ~${pct}% of a ${a.budget.toLocaleString()} token budget · estimate`,
    note: l && windows.length
      ? fresh
        ? 'Provider limits include no timed window; the meter uses a local estimate.'
        : 'Provider limits are stale; the meter uses a local estimate.'
      : 'Estimated from observed token spend against the budget in accounts.json — not a real plan limit.',
    windows,
    blocks: viewBlocks(l?.blocks),
    plan,
    error,
  };

  return {
    load, pct, real: true,
    title: `${a.name} — ${primary.pct}% of the ${durationLabel(primary.windowDurationMins)} limit`,
    budgetLine: a.provider,
    note: '', windows,
    blocks: viewBlocks(l.blocks),
    plan,
    error,
  };
}

/** Reset scheduling is a Codex freshness boundary; timed work is always separate. */
export function resetScheduleView(account) {
  if (account?.provider !== 'codex') return { enabled: true, reason: '' };
  if (account.resetScheduling?.eligible === true) return { enabled: true, reason: '' };
  return {
    enabled: false,
    reason: typeof account?.resetScheduling?.reason === 'string' && account.resetScheduling.reason
      ? account.resetScheduling.reason
      : 'Codex limits are temporarily unavailable.',
  };
}

const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

/**
 * What the link dialog should show, from the snapshot's `link` key alone.
 *
 * Pure and DOM-free so the fiddly parts — the paste box appearing only when the
 * CLI actually prompted, the jump straight to naming when it did not — are
 * testable without a browser. app.js only sets `hidden` flags from this.
 */
export function linkView(link) {
  if (!link) return null;
  const provider = PROVIDER_LABEL[link.provider] ?? link.provider;

  if (link.phase === 'error') {
    return {
      heading: `Couldn't link ${provider}`,
      hint: '', showUrl: false, url: null, showCodeBox: false, showNameForm: false,
      suggestedName: null, identityLine: '', error: link.error ?? 'Something went wrong.',
      busy: false,
      // A failed link still holds #pending server-side (settled, but present)
      // until something clears it — the button that used to hide itself here
      // was the only thing that could. "Dismiss" rather than "Cancel sign-in":
      // there is no longer a sign-in running to cancel.
      cancelLabel: 'Dismiss',
    };
  }

  if (link.phase === 'naming') {
    const identityLine = link.identity
      ? `Signed in as ${link.identity.email}${link.identity.subscription ? ` · ${link.identity.subscription}` : ''}`
      : `Signed in to ${provider}.`;
    return {
      heading: `Name this ${provider} account`,
      hint: 'This name appears on the account meter and in the New dialog.',
      showUrl: false, url: null, showCodeBox: false, showNameForm: true,
      suggestedName: link.suggestedName, identityLine, error: null, busy: false,
      cancelLabel: 'Cancel sign-in',
    };
  }

  if (link.phase === 'verifying') {
    return {
      heading: `Linking ${provider}…`, hint: 'Checking who you signed in as.',
      showUrl: false, url: null, showCodeBox: false, showNameForm: false,
      suggestedName: null, identityLine: '', error: null, busy: true,
      cancelLabel: 'Cancel sign-in',
    };
  }

  if (link.phase === 'awaiting-user' && link.url) {
    return {
      heading: `Sign in to ${provider}`,
      hint: link.codeRequested
        ? 'Approve in the tab that opened, then paste the code it gives you.'
        : 'Approve in the tab that opened. This dialog updates on its own.',
      showUrl: true, url: link.url,
      showCodeBox: Boolean(link.codeRequested), showNameForm: false,
      suggestedName: null, identityLine: '', error: null, busy: false,
      cancelLabel: 'Cancel sign-in',
    };
  }

  return {
    heading: `Starting ${provider} sign-in…`, hint: '',
    showUrl: false, url: null, showCodeBox: false, showNameForm: false,
    suggestedName: null, identityLine: '', error: null, busy: true,
    cancelLabel: 'Cancel sign-in',
  };
}

/**
 * The command token at the start of `text`, or -1 if there isn't one. Ends at
 * any whitespace, not just a space: the new-session prompt is a textarea, where
 * the command is the first line and a newline ends it just as surely.
 */
function tokenEnd(text) {
  if (!text.startsWith('/')) return -1;
  const ws = text.search(/\s/);
  return ws === -1 ? text.length : ws;
}

/** Where a name sorts for `query`: whole-name prefix, bare-name prefix, or substring. */
function rank(name, query) {
  const lower = name.toLowerCase();
  // Commands are listed namespaced ("ponytail:ponytail-help") but typing the
  // bare name works too, so "help" has to reach past the plugin prefix.
  const bare = lower.slice(lower.indexOf(':') + 1);
  if (lower.startsWith(query)) return 0;
  if (bare.startsWith(query)) return 1;
  return lower.includes(query) ? 2 : 3;
}

/**
 * What the composer's command menu should show, or null for "no menu".
 *
 * The menu belongs to the first token only: once the caret is past it the user
 * is writing arguments, and a list of commands is just in the way.
 */
export function commandMenu(text, caret, commands, limit = 8) {
  const end = tokenEnd(text);
  if (end === -1 || caret > end) return null;
  const query = text.slice(1, end).toLowerCase();
  const matches = commands
    .filter((c) => rank(c, query) < 3)
    .sort((a, b) => rank(a, query) - rank(b, query) || a.localeCompare(b))
    .slice(0, limit);
  return matches.length ? { query, matches } : null;
}

/**
 * The leading command if it is one the agent will actually recognise, else null.
 * This is what gets coloured — highlighting an unknown token would promise the
 * user something that is about to be sent as plain text.
 */
export function commandToken(text, commands) {
  const end = tokenEnd(text);
  if (end === -1) return null;
  const token = text.slice(1, end);
  const known = commands.some((c) => c === token || c.slice(c.indexOf(':') + 1) === token);
  return known ? text.slice(0, end) : null;
}

// In picker order: ten accents by ascending OKLCH hue, starting near coral,
// then the twelve canvases — six light families, then their six dark twins.
// The hexes live in web/style.css, which is what test/palette.test.ts
// measures — these are only names.
export const ACCENTS = Object.freeze([
  'clay', 'coral', 'ochre', 'moss', 'fern', 'teal', 'slate', 'indigo', 'plum', 'mulberry',
]);
export const CANVASES = Object.freeze([
  'cream', 'linen', 'shell', 'mist', 'porcelain', 'bone',
  'obsidian', 'umber', 'ember', 'pine', 'midnight', 'graphite',
]);

const DEFAULT_THEME = Object.freeze({ accent: 'coral', canvas: 'obsidian' });

/**
 * The stored theme, or the default for anything that is not a known pair.
 * localStorage is user-editable and this value is read before the stylesheet
 * applies, so an unvalidated one paints an unstyled page. The two halves fall
 * back independently: an unrecognised accent should not also throw away a
 * perfectly good canvas.
 */
export function readTheme(raw) {
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_THEME };
  }
  return {
    accent: ACCENTS.includes(stored?.accent) ? stored.accent : DEFAULT_THEME.accent,
    canvas: CANVASES.includes(stored?.canvas) ? stored.canvas : DEFAULT_THEME.canvas,
  };
}

/**
 * Maps each commit to the branch whose line it sits on, for hover-tracing and
 * for colouring the graph.
 *
 * git only reports a ref at a branch's tip, so every commit below it is
 * anonymous. Walking back from each tip recovers the rest. The first tip to
 * claim a commit keeps it — the same first-claimer-wins rule assignLanes
 * already applies to lanes — and that includes trunk: its own name (`main`,
 * or whatever the checked-out branch is called) is a ref like any other, so
 * the spine gets attributed and coloured too, and a merged-in feature branch
 * still keeps its own name for the stretch that is only its own, because its
 * tip was seeded before trunk's walk ever reaches it.
 */
function branchNames(c) {
  return c.refs
    .filter((r) => !r.startsWith('tag: '))
    .map((r) => r.replace(/^HEAD -> /, ''))
    .filter((r) => r !== 'HEAD');
}

/**
 * A hue slot per branch name — the index of a `.hue-N` rule in the stylesheet,
 * which is where the actual colours live.
 *
 * Keyed on the name and not the lane: lanes are recycled as branches close, so
 * a lane colour renamed itself mid-graph and said nothing about which branch
 * you were looking at. Assigned by sorted position rather than by hashing the
 * name, which collides — five branches drew in three colours on the first repo
 * this was tried against. Sorting gives the first HUES branches a colour each;
 * past that they wrap, which hover-to-trace separates. The cost is that adding
 * a branch shifts the colours of the names sorting after it.
 */
export const HUES = 5;

export function branchHues(names) {
  return new Map([...new Set(names)].sort().map((name, i) => [name, i % HUES]));
}

export function attributeBranches(commits) {
  const at = new Map(commits.map((c) => [c.h, c]));
  const owner = new Map();
  // Seed each ref-bearing commit with its own name before any walk runs. A
  // merge's walk reaches every ancestor of both parents, including another
  // branch's tip (the merged-in branch's own history) — without a seed, that
  // walk would run first (it's the child, so it's earlier in topo order) and
  // claim the tip for itself before the tip ever gets to claim its own name.
  for (const c of commits) {
    const names = branchNames(c);
    if (names.length && !owner.has(c.h)) owner.set(c.h, names[0]);
  }
  for (const c of commits) {
    const names = branchNames(c);
    for (const name of names) {
      const queue = [c.h];
      const seen = new Set();
      while (queue.length) {
        const h = queue.shift();
        const cur = at.get(h);
        // Missing parent: outside the fetched window.
        if (!cur) continue;
        // Claimed by a different name: another branch's tip, which the seed
        // pass pre-claimed for itself — stop rather than swallow its history.
        const claimed = owner.get(h);
        if (claimed !== undefined && claimed !== name) continue;
        // Expanded already. The guard above deliberately lets a same-name node
        // through, so without this a node reachable by two paths inside one
        // branch re-expands its whole ancestry each time — exponential on
        // nested merges, in a function that reruns every 2s poll.
        if (seen.has(h)) continue;
        seen.add(h);
        owner.set(h, name);
        queue.push(...cur.p);
      }
    }
  }
  return owner;
}

/**
 * The one-line label for a file in the Diff pane. Binary files get a word
 * rather than `+0 −0`: git refuses to count their lines and so does this, and
 * a pair of zeroes would read as "nothing changed".
 */
export function diffSummary(file) {
  const name = file.old ? `${file.old} → ${file.path}` : file.path;
  return file.binary ? `${name} · binary` : `${name} · +${file.added} −${file.removed}`;
}

/**
 * Which class one line of a unified patch body wears. The `---`/`+++` file
 * headers are stripped server-side, so a leading `+` here is always content.
 */
export function patchLineClass(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return '';
}
