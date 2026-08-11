# What we have, what t3code has, what we take

t3code (pingdotgg/t3code, MIT) solves the same problem from the opposite end.
It owns the agents it runs and gives them a rich, complete UI. conch attaches to
agents you already started and gives them a voice. Their breadth is worth
having; our interaction model is the thing worth protecting.

This is the working list. Each row in "what we take" is one design → build →
test → iterate pass, in order.

## What we have

**The interaction model — this is the differentiator, none of it is theirs.**
- A turn-based voice loop: a finished turn announces itself aloud, the mic
  opens, whisper transcribes, the words are injected back into the session.
- Attaches to sessions **you already started**, in your own terminal. Nothing
  is spawned, nothing is owned, a running session never learns conch is there.
- Works with Claude Code (hooks) *and* Codex (rollout polling — Codex has no
  hook mechanism, so conch observes from outside rather than asking it to
  change).
- `review_to_front`: an agent can push a deliverable to the front of your
  screen, on any device.
- Three viewers on one daemon: Mac app, iPhone app, terminal TUI.
- Voice out via Kokoro MLX, an mlx_audio server, or `say`.
- Phone: LAN bridge plus a relay for when you're away, QR pairing, voice input,
  image upload, per-session reply.
- Per-session pause and mute; settings read live from the daemon.

**What we are missing that is table stakes.**
- No composer on the Mac app. You cannot type or attach an image — the thing
  Tyler hit immediately.
- One undifferentiated `tool` row for every kind of tool call, so a Codex
  session renders as an unreadable string of them.
- No way to interrupt a running turn.
- No way to answer a question an agent asks.
- No plan/todo rendering, no diffs, no queued messages.

## What they have

- **A canonical event model.** `ProviderRuntimeEvent`, a 48-variant union with
  a shared base (`eventId, provider, threadId, createdAt, turnId?, itemId?,
  requestId?`). Every provider is normalised into it.
- **A finer item vocabulary.** `CanonicalItemType`: `user_message`,
  `assistant_message`, `reasoning`, `plan`, then the tool lifecycle types —
  `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`,
  `collab_agent_tool_call`, `web_search`, `image_view` — plus
  `review_entered/exited`, `context_compaction`, `error`, `unknown`.
- **A flat two-layer thread.** `OrchestrationMessage` for chat bubbles,
  `OrchestrationThreadActivity` for everything else. Not nested parts.
- **Streaming** as a plain boolean plus `delta` / `complete` commands.
- **Tool rows dispatch on `itemType`**, with an opaque `data` blob: terminal
  for commands, a real diff for file changes, globe for search, wrench for MCP.
- **Plans** as `RuntimePlanStep {step, status: pending|inProgress|completed}`.
- **Approvals**: `CanonicalRequestType` requests, resolved by a four-way
  `accept | acceptForSession | decline | cancel`.
- **Questions**: `UserInputQuestion {header, question, options, multiSelect}`.
- **Turn control**: `turn.start`, `turn.interrupt`, `checkpoint.revert
  {turnCount}`, `session.stop`. Queueing needs no command — starting a turn
  while one runs *is* the queue.
- **Thread management**: archive, pin, snooze, settle.
- One large `MessagesTimeline.tsx` (2,383 lines) renders it all; their own
  mobile app reimplements the fold natively rather than sharing it.

## What we take

Their vocabulary and their fold semantics; our stack, our look, our voice loop.
Not their renderer — their own mobile app didn't reuse it either.

1. ~~**Mac composer**~~ — DONE. Type, attach images by picker or drag, and
   dictation appears in the field while you speak.
2. ~~**Item-kind split**~~ — DONE as `ToolKind`, mapping both agents' names for
   the same operation onto one vocabulary in the daemon, so neither app learns
   either agent's spelling.
3. ~~**Per-kind tool rows**~~ — DONE for glyphs: terminal, pencil, doc, glass,
   globe, wrench, checklist. Still to do: a file change should render its DIFF
   rather than its filename (item 9).
4. ~~**Plans as first-class rows**~~ — DONE. Both `TodoWrite` and Codex's
   inline `update_plan` become one checklist, done steps struck through.
5. ~~**Interrupt**~~ — DONE on Mac and phone. The daemon presses Escape in the
   session's pane, which is what a person would do; neither agent exposes a
   cancel an outside process could call.
6. ~~**Queued messages**~~ — DONE, and it needed no queue: both agents accept
   typed input mid-turn and queue it themselves. What was missing was that
   conch confirmed delivery by watching the transcript grow, which a busy
   session cannot do, so a message that queued fine was reported as failed.
7. **Questions** — answer an agent's multiple-choice question by voice. This is
   the one where our interaction model beats theirs outright.
9. ~~**Diffs**~~ — DONE. `card.tsx +12 −4`, expanding to the lines that moved,
   with the anchor lines an edit restates on both sides trimmed away.

## Deferred, and why

Not abandoned — each is real, and each is worth doing if conch becomes
something other people run. None is worth guessing at.

8. **Approvals — the four-way decision.** conch already answers permission
   prompts by voice; the gap is only "yes, and don't ask again". Selecting that
   means pressing keys through a menu whose layout cannot be verified on a
   machine running bypass permissions, where no prompt ever appears. A wrong
   guess does not fail safely — it picks a different option, which can approve
   something nobody intended. Unblocked by one look at a real prompt.
10. **Checkpoint / revert.** Undoing N turns means driving `/rewind` or an
    escape sequence against a live session, where being wrong destroys work
    rather than merely failing. Same shape as approvals: cheap once the
    behaviour has been observed once, reckless before that.
11. **Thread management** — archive, pin, snooze. Safe and real, just low value
    next to everything above; conch already has dismiss and restore, which
    covers most of what pinning would.

## Found along the way

Not on the original list, and worth more than most of it:

- The daemon was sending a full state frame at up to 10Hz even when nothing had
  changed. The phone decodes each one as a complete state on the main actor, so
  every redundant frame was a full re-render of a busy screen.
- An open mic survived backgrounding once the app declared background audio,
  with no listening timeout — the clearest path to heat and battery drain.
- A modal dialog on the Mac froze every AppleScript call for 122 seconds at a
  time, with the daemon's whole queue stacked behind it.
- Folding the daemon into the app reset its Apple-events permission, because
  macOS decides that per responsible process.
