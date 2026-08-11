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

1. **Mac composer** — type, attach images, see dictation land in the field.
   Ours to build regardless of t3code; it is the current blocker.
2. **Item-kind split** — adopt `CanonicalItemType` in `ConversationItem`.
   One enum change; every rendering complaint traces back to it.
3. **Per-kind tool rows** — command, file change, search, image, MCP, subagent.
4. **Plans as first-class rows** — agents emit todo lists constantly and we
   render them as noise.
5. **Interrupt** — stop a running turn from any device.
6. **Queued messages** — send while working, it lands next. No new command.
7. **Questions** — answer an agent's multiple-choice question by voice. This is
   the one where our interaction model beats theirs outright.
8. **Approvals** — the four-way decision. Earns nothing for a bypass-permissions
   user; it is the difference between a tool for Tyler and a product.
9. **Diffs** — a file change should render as a diff, not a filename.
10. **Checkpoint / revert** — undo N turns.
11. **Thread management** — archive, pin, snooze.
