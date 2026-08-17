# conch backlog

Everything Tyler has reported or asked for, and where it stands. Cross off or
delete as they go. Newest at the top of each section.

## Roadmap

Rewritten from scratch — the previous plan was written before the audit and
before half of it was done. Each phase ends somewhere worth stopping.

### Phase 1 — make one interaction model (in progress)

The audit's verdict is the problem statement: *"the three surfaces are not
three presentations of one interaction model. They currently implement
materially different products."* Everything here is that sentence being false.

1. **The mic must mean one thing.** Mac sends wake/stop to the daemon's mic;
   the phone runs LOCAL recognition and never sends; the terminal wakes the
   daemon mic but only in theater mode. Settle it — dictation fills the
   composer, on every surface — and the "mic fills the composer" item is the
   same work.
2. **Retire mute everywhere.** It is still live in the terminal and behind a
   hidden `M` on the Mac. Half-retired is worse than not retired.
3. **The composer, on every surface.** Including the layout fix below.
4. **Dismiss/restore, one feature.** Complete on Mac, dismiss-only in the
   terminal with unreachable restore code, absent on the phone — which drops
   `dismissedRows` while decoding.
5. **The dead footer keybar** — it advertises keys that are all swallowed,
   including `q` and Ctrl-C.

### Phase 2 — the things that make it usable daily

6. Start and close sessions from either app.
7. Context meter per session.
8. Claude / Codex mark beside each name.
9. Question options that can actually be answered.
10. Errors that report themselves.

### Phase 3 — the feed

11. Artifacts inline in the conversation; one pane, two perspectives.
12. Pinned artifacts that stay live without being re-sent.
13. Then the feed proper — see `vision.md`.

### Terminal parity, deliberately scoped

The terminal is not a third app to bring to parity feature-for-feature; it is
the surface you use while your hands are already on the keyboard. It should be
able to do everything the OTHER two can do to a session — read, answer,
interrupt, dismiss, restore, switch mode — and it does not need image
attachment, artifact rendering, or a phone's audio lease. What it must not do
is advertise controls that do nothing, which is what it does today.

## Bugs## Bugs

### Open

- [ ] **A conversation can render empty until you scroll it.** Tyler opened
      asset generator, saw nothing while the row said it was waiting for him,
      and the content appeared only once he scrolled. He waved it off, but an
      empty pane over a session with content is indistinguishable from a broken
      one — and in the feed it would be the whole screen. Likely the lazy stack
      not laying out until the scroll view is touched.
- [ ] **The relay drops every 100 minutes, exactly.** 13:42, 15:22, 17:02,
      18:42, 20:23 — five disconnects, all code 1006 (abnormal closure), all
      100 minutes apart. That regularity is a timer somewhere, not a network:
      most likely a relay-side idle or token lifetime that nothing refreshes
      ahead of. It reconnects within seconds so it has been invisible, but a
      message arriving in that window is a message that does not arrive.
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

Deduplicated — several of these were the same thing in different words, and a
few "features" are bugs wearing a polite name. Ranked by how much they annoy
Tyler against how hard they are, so the top of the list is what to cut a batch
from.

Merged along the way: "one pane, two perspectives" + "artifacts inline" are one
item; "context meter" + "context window per session" are one; "start a session
from conch" + "spawn sessions from the phone" are one.

### From the UI audit — findings worth acting on

The full audit is `docs/ui-audit.md` (650 lines). Its verdict: "The three
surfaces are not three presentations of one interaction model. They currently
implement materially different products." Highest-value items lifted out:

- [x] **The phone disconnected permanently on first background** — stop() was
      final and reconnectNow() refused after it. FIXED.
- [ ] **Mute is still live in two places** despite being retired: the terminal
      exposes both pause and mute, and the Mac still has a hidden `M` path.
      Retiring it in one surface and not the others is worse than not retiring
      it.
- [ ] **The footer keybar is entirely dead.** It paints a keyboard bar while
      input dispatch is disabled, and stdin is still raw — so every advertised
      key is swallowed, including `q` and Ctrl-C. A bar that lists keys none of
      which work.
- [ ] **The Mac mic, the phone mic and the terminal Space key do three
      different things.** Mac sends wake/stop to the daemon's microphone; the
      phone starts LOCAL recognition and never sends; the terminal wakes the
      daemon mic but only in theater mode.
- [ ] **A Mac draft can be lost on an unacknowledged send.**
- [ ] **An image-only send does nothing on the phone.**
- [ ] **Question options are inert** on both apps — they render and cannot be
      answered. Known, but the audit rates it higher than I did: it is the one
      row that exists to be acted on.
- [ ] **Dismiss/restore is three different features**: complete on Mac,
      dismiss-only in the terminal (restore code exists but nothing can reach
      it), absent on the phone — which drops `dismissedRows` while decoding.
- [ ] **The terminal never consumes the artifact link** it is sent.

### Newly reported

- [ ] **Manual mode should turn wake words off.** Manual means conch does not
      act on its own — it does not read finished turns aloud and does not open
      the mic by itself. A spoken wake word is conch acting on its own by
      definition, so it belongs on the same switch. The BUTTON must keep
      working in manual: that is a person asking, which is the whole
      distinction.

- [ ] **A failed send SPEAKS while conch is in manual mode.** Confirmed from
      the log: a send fell back to the clipboard with
      `system-dialog-blocking`, and conch then said "A system dialog is open on
      the Mac and it's blocking me" out loud — in manual mode, which exists
      precisely so it does not speak first. Manual gates the announcement queue;
      these failure lines call `speak()` directly and bypass it entirely. Every
      direct `speak()` call in the daemon needs the same gate the queue has, or
      this recurs the next time a new one is added.
      Also from the same incident: the failure took 9 seconds to say because
      Kokoro hard-restarted mid-sentence and the `say` fallback timed out, so
      the session looked like it was "speaking" for the whole of it while
      nothing was audible.

- [ ] **The conversation goes black, then glitches back when you scroll, and
      snaps to the end on its own.** Reading a long reply is currently not
      possible on the Mac. Almost certainly the same family as "renders empty
      until you scroll": a lazy stack plus a scroll-to-bottom that re-fires on
      every publish. The daemon republishes often, so anything keyed off "state
      changed" rather than "the conversation actually grew" will yank the view
      out from under a reader. Highest-priority bug on the list — an app you
      cannot read is not usable.
- [ ] **Links are not clickable.** They render blue and underlined, which is a
      promise. Possibly just the machine being slow, so confirm before
      rewriting anything.
- [ ] **The Mac composer keeps its draft when you change session.** Type to one
      session, switch, and your words are still sitting there addressed to the
      wrong agent. The phone gets this right — its draft is persisted PER
      SESSION — and the audit flagged the same thing: "the composer is not
      keyed per session".

- [ ] **The phone cannot dismiss its keyboard.** Once the cursor is in the
      input there is no way out — no swipe-down, no tap-outside — so you cannot
      scroll and read before sending, or change your mind. Nothing to do with
      dismiss/restore, which is about hiding a SESSION from the ledger; this is
      focus, and it is the more annoying of the two.
- [ ] **The Mac composer wastes its height as it grows.** The buttons stay
      vertically centred in a row that is now several lines tall, so they float
      in an empty column while send drifts down the right. The phone already
      solves this: field on top, controls in a row beneath, one container.
      Adopt it.
- [ ] **Images added to the Mac composer show as filenames, not images.** A
      picture you are about to send should look like the picture.
- [ ] **conch should know about skills and plugins** — which are available to a
      session, and ideally turning them on and off. Related to the existing
      "toggle plugins, skills and MCP servers" item; this is the read half,
      which has to come first.

### Batch 1 — annoying and cheap. Do these together.

- [ ] **The mic must FILL the composer, not send past it.** Press it expecting
      to add to what you typed and the spoken half vanishes into the session
      instead. Typed and spoken text cannot be combined at all. The phone
      already treats the draft as shared; the Mac injects the transcript
      directly. Needs a dictation mode that publishes its final text back to the
      app rather than injecting it.
- [ ] **Which agent is this?** A quiet Claude / Codex mark beside each session
      name. The backend is already on the wire and nothing shows it.
- [ ] **Context meter per session.** Tokens used against the limit, on the
      conversation pane. It is the number that decides whether to keep going or
      start fresh, and today the only warning is the answers getting worse.
      Codex publishes `event_msg:token_count`; Claude's is derivable.
- [ ] **A conversation can render empty until you scroll it.** An empty pane
      over a session that says it is waiting for you is indistinguishable from a
      broken one — and in the feed it would be the whole screen. Likely the lazy
      stack not laying out until the scroll view is touched.
- [ ] **Reclaim the top of the Mac window.** 42pt of header carrying a wordmark,
      above the list that is the actual content.
- [ ] **Shrink AGENTS.md.** Byte-identical to SKILL.md, but SKILL loads on
      demand while AGENTS is ALWAYS resident for Codex — so every Codex session
      permanently carries a twenty-line Homebrew install pitch. The generator
      enforces the duplication and a test enforces the generator, so the bug is
      load-bearing. Always-on wants five lines: what conch is, the artifact
      trigger, and "load the skill for the rest".

### Batch 2 — annoying, more work

- [ ] **Start and close sessions from conch**, on either device. New, or from a
      resume command. Closing must be a clean exit rather than a kill, so it
      stays resumable (`claude --resume <id>`, `codex resume <id>`), behind a
      confirmation, and nowhere a thumb lands by accident. Without starting,
      conch can only ever attend to work begun at a desk — which is most of the
      point.
- [ ] **One pane, two perspectives.** The conversation and the artifact are the
      same pane with a swap button. Artifacts appear inline where they happen,
      full-width and rounded; click or swap to make one the main thing. Then the
      experiment: overlay the live conversation on the artifact, TikTok-comment
      style, hide and unhide. The constraint that stays: a session list and ONE
      content pane per session. This is the feed's shape inside today's app.
      *(A swap button is being built now as the first step.)*
- [ ] **PIN the artifact and keep it live.** The agent declares what the
      artifact IS once; conch keeps it current — watch the file and re-render,
      reload the URL, accept a replacement where the type needs it. Corrects the
      plugin's current "send it again as it changes", which puts the burden in
      the wrong place.
- [ ] **Errors should find us.** Neither app reports a failure anywhere a person
      or an agent could later read: the Mac writes to NSLog, the phone writes
      nowhere. (1) both apps report to the daemon over the channel telemetry
      already uses, (2) the daemon appends them structured with the state at the
      time, (3) an agent watches and investigates unprompted. Step 3 is
      worthless before step 1. Two we already swallow: a message landing on the
      clipboard, and a Codex row with no pid.
- [ ] **Render materials inline instead of dropping them one pattern at a
      time.** Claude Code files its own notes under `type:"user"`, so conch must
      decide what each one IS. Today that is a growing DROP list —
      `<task-notification>`, `<system-reminder>`, `[Request interrupted…]`,
      `[Image: …]` — each added after Tyler saw it quoted back as something he
      said. Classify by shape, and render each material as itself: an image as
      an image, not a path.

### Batch 3 — worth doing, not urgent

- [ ] **Behaviour rules for both apps, written down and made true.** *(Codex is
      auditing all three surfaces now; the audit is the input to this.)*
- [ ] **Document the plugin contract, not the conversation.** No return shapes,
      no enum for `conch_mode`, no units for `conch_config`, no example calls —
      while the one thing specified verbatim is the Homebrew sales pitch.
- [ ] **Rename `review_to_front`.** The name teaches "approval gate" every time
      an agent reads the tool list, whatever the description says. Renaming an
      MCP tool breaks callers mid-flight, so it wants doing deliberately with
      the text marker kept as an alias.
- [ ] **Sessions messaging each other through conch**, addressed the way Tyler
      addresses them. conch already owns delivery, addressing and the
      transcript; agents just cannot use any of it.
- [ ] **Subagents as children of their session** in the ledger, transcripts
      readable, ideally talkable-to. `subagent` is already a tool kind.
- [ ] **Turn plugins, skills and MCP servers on and off** from conch, per
      session.
- [ ] **Better phone transcription.** `tools/transcription-bench.ts` is written
      and waiting on one recording to settle on-device vs Apple's servers vs
      Mac-side whisper vs a paid API.
- [ ] **Better phone reading, configurable** — Kokoro from the Mac or a paid
      API, since one person's laptop has RAM to spare and another's is
      suffocating.
- [ ] **A design pass on the Mac app**, once it is fluid.

### Batch 4 — blocked, or genuinely low value

- [ ] **Approvals — the four-way decision.** Blocked: selecting "don't ask
      again" means pressing keys through a menu that cannot be verified on a
      machine running bypass permissions. Ten seconds with permissions on
      unblocks it.
- [ ] **Checkpoint / revert.** Blocked the same way: driving `/rewind` against a
      live session, where being wrong destroys work.
- [ ] **One universal adapter shape**, so a third backend is a table entry
      rather than a fork through the daemon.
- [ ] **conch Channel MCP server** — protocol delivery instead of keystrokes.
- [ ] **Live Activities** on the phone.
- [ ] **Thread management** — archive, pin, snooze. Dismiss and restore already
      cover most of it.

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
