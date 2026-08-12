# conch backlog

Everything Tyler has reported or asked for, and where it stands. Cross off or
delete as they go. Newest at the top of each section.

## Bugs

### Open

- [ ] **Mac audio degraded.** `say` — macOS's own TTS — timed out after 18s, and
      Kokoro hard-restarts on synthesis timeouts. Tracks the machine's memory
      pressure rather than conch; revisit when the Mac is healthy.

### Fixed

- [x] **Return made a newline instead of sending.** The common act should be the
      unmodified key; Shift-Return breaks a line now.
- [x] **A permanent empty black bar under the composer.** Reserving a row fixed
      the layout shift and created this. A transient hint does not deserve
      permanent layout — it floats over the conversation instead.
- [x] **No speech controls near the composer, and no sign dictation was
      working.** Talking is what conch is for, and its control was further from
      the text field than the button that attaches a picture. The mic now sits
      in the composer and carries the state — listening, transcribing,
      speaking.
- [x] **Text sent from the Mac app never arrives at a Codex session.** Codex
      publishes no pid, so those rows arrived `pid=0` and every message fell
      through to the clipboard as "session-not-routable" — while Claude
      sessions worked. Same button, silently different outcome per agent.
      Resolved from the lock the live process holds on its own thread file.
- [x] **"Permission prompt" shown when the agent merely asked a question.**
      Claude Code fires `permission_prompt` for `AskUserQuestion` too, and the
      label printed that internal name verbatim. Says "needs an answer" now.
- [x] **Layout shift under the composer.** The hint bar only existed when it had
      text, so a 32pt bar appeared the moment conch spoke and shoved the
      conversation up. Reserved slot, fades in place.
- [x] **Composer wrapped a line early.** Guessed 110 characters per line, which
      cannot be right at two window widths. Measured now.
- [x] **Typed text not vertically centred.** `TextEditor` applies its own inset
      on top of ours, so typed text and placeholder were positioned by
      different rules.
- [x] **"Reading aloud" with nothing playing.** Three routes into the speaking
      state, only one bounded. All three bounded; the phone bounds its own
      claim too.
- [x] **Phone sends silently failing.** Two causes: a modal dialog froze every
      AppleScript call for 122 seconds with the queue stacked behind it, and
      folding the daemon into the app reset its Apple-events permission
      (macOS decides that per responsible process).
- [x] **A queued message reported as failed.** Delivery was confirmed by
      watching the transcript grow, which a busy session cannot do.
- [x] **Clipboard fallback reported as delivered.** 15 of 72 sends in one day
      said "delivered" for words that never reached a session.
- [x] **Every Codex message rendered twice.** A rollout records the same text as
      both `response_item:message` and `event_msg:agent_message`.
- [x] **Codex sessions rendered as a string of tool calls.** Codex sends nearly
      everything as one `exec` whose argument is a line of JavaScript.
- [x] **Codex rows vanishing after a while**, and not appearing on the phone.
- [x] **`<task-notification>` shown as messages Tyler had sent.**
- [x] **Markdown shown as raw source**, tables as walls of pipes.
- [x] **Mac app doing nothing on Talk/Resume.**
- [x] **Phone keyboard's return key sending instead of newlining.**
- [x] **`conch:review` producing no review row.**

## Features

### Wanted

- [ ] **Errors should find us, not the other way round.** Nothing in either app
      reports a failure anywhere a person or an agent could later read. The
      daemon logs to `/tmp/conch-daemon.log`; the Mac app writes to NSLog, and
      the phone writes nowhere at all. Order of work: (1) both apps report
      errors to the daemon over the channel telemetry already uses, (2) the
      daemon appends them to a structured file with the state at the time, (3)
      an agent watches that file and investigates unprompted. Step 3 is
      worthless before step 1.
      Two things are already errors we swallow: a message landing on the
      clipboard instead of in a session, and a Codex row with no pid.
- [ ] **The mic button should FILL the composer, not send past it.** Tyler
      pressed it expecting to add to what he had already typed: "intended
      behaviour is that it would append to the input box here and send". Today
      it wakes the session and conch injects the transcript directly, so typed
      text and spoken text cannot be combined and the spoken half appears to
      vanish. The phone already treats the draft as shared between typing and
      dictation; the Mac should do the same, which means a dictation mode that
      publishes its final transcript instead of injecting it.
- [ ] **Close a session from either app** — properly, so it can be resumed
      later from conch or from a terminal. A clean exit, never a kill: both
      agents leave a resumable transcript when they shut down normally
      (`claude --resume <id>`, `codex resume <id>`) and leave a mess when they
      are killed. Needs a confirmation, and must not sit anywhere a thumb lands
      by accident — ending a session by mistake is the most expensive misclick
      the app could offer.
- [ ] **Artifacts inline in the conversation**, the way a document appears in a
      chat, expanding on click rather than replacing the pane. The pane swap is
      why there was nowhere to type while looking at one; a composer on both
      panes fixes the symptom, inline artifacts remove the mode entirely.
- [ ] **Context window per session.** How full is this session? It is the number
      that decides whether to keep going or start fresh, and conch reads the
      transcripts already — token counts are in Codex's `event_msg:token_count`
      and derivable for Claude.
- [ ] **Turn plugins, skills and MCP servers on and off** from conch, per
      session. Currently means editing config by hand and restarting.
- [ ] **Subagents as children of their session** in the ledger — a disclosure
      triangle under the parent, their transcripts readable, ideally talkable-to.
      conch already classifies `subagent` as a tool kind, so the signal is there.
- [ ] **Reclaim the top of the Mac window.** A 42pt header carrying a wordmark
      and little else, above a list that is the actual content.
- [ ] **A design pass on the Mac app once it is fluid.** Tyler: "i just want the
      design to be much better overall but i guess its even more important that
      it works fluidly so lets nail that first".

- [ ] **Better phone transcription.** `tools/transcription-bench.ts` measures
      the options on Tyler's own voice — awaiting a recording to decide between
      on-device, Apple's servers, Mac-side whisper, and a paid API.
- [ ] **Better phone reading, configurable.** Best installed Apple voice ships
      now; Kokoro streamed from the Mac or a paid API as an option, since one
      person's laptop has RAM to spare and another's is suffocating.
- [ ] **Spawn sessions from the phone.** "not really free from the desk without
      that feature." Terminal for Claude, tmux for Codex; agents must not live
      in conch's own tmux session.
- [ ] **One universal adapter shape**, so a third backend is a table entry
      rather than a fork through the daemon.
- [ ] **conch Channel MCP server** — protocol-level delivery instead of
      keystrokes, and phone-side permission relay.
- [ ] **Approvals — the four-way decision.** Deferred: selecting "don't ask
      again" means pressing keys through a menu that cannot be verified on a
      machine running bypass permissions. Needs one look at a real prompt.
- [ ] **Checkpoint / revert.** Deferred for the same reason: driving `/rewind`
      against a live session, where being wrong destroys work.
- [ ] **Thread management** — archive, pin, snooze. Safe, low value next to the
      above; dismiss and restore already cover most of it.
- [ ] **Live Activities** on the phone, so a session's state shows on the lock
      screen without the app running.

### Done

- [x] Daemon folded into the Mac app — one thing to install, toggle, delete.
- [x] Composer on the Mac: type, attach images by picker or drag, dictation in
      the field.
- [x] Diffs, plans, questions, per-kind tool glyphs — both apps.
- [x] Answering a multiple-choice question by voice.
- [x] Interrupt a running turn, from either device.
- [x] Phone telemetry: memory, battery, thermal, Low Power, free storage.
- [x] Only-on-when-needed: connection, mic, telemetry and polling all stop when
      the phone is backgrounded.
- [x] Image path: ImageIO downsampling off the main actor, capped attachments,
      lazy base64.
- [x] Codex sessions visible and announced without touching a running one.
- [x] The app photographs itself for debugging, rather than the desktop.
- [x] TestFlight archive and export.
- [x] Review contract lives in the plugin, never in a user's CLAUDE.md.
