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

1. **The mic must mean one thing.** ← NEXT. Mac sends wake/stop to the daemon's
   mic; the phone runs LOCAL recognition and never sends; the terminal wakes the
   daemon mic but only in theater mode. Settle it — dictation fills the
   composer, on every surface — and the "mic fills the composer" item is the
   same work.
2. ~~**Retire mute everywhere.**~~ DONE — gone from every surface; `muted`
   survives only as an internal state name that renders as "manual".
3. **The composer, on every surface.** Mac and phone have one; the layout fix
   (field on top, controls beneath) is still owed on the Mac.
4. **Dismiss/restore, one feature.** Complete on Mac, dismiss-only in the
   terminal with unreachable restore code, absent on the phone — which drops
   `dismissedRows` while decoding.
5. **The dead footer keybar** — it advertises keys that are all swallowed,
   including `q` and Ctrl-C.

Added by use, not by audit — the controls have to be trustworthy before the
model they express is worth unifying:

6. ~~**A mic that always closes**~~ and ~~**a manual mode that means it**~~ —
   DONE. See Bugs/Fixed; both were "conch reported an intent and never checked
   whether it happened", which is the same defect Phase 1 is about.

### Phase 2 — the things that make it usable daily

7. ~~Start and close sessions from either app.~~ DONE on the Mac; phone owed.
8. ~~Context meter per session.~~ DONE.
9. ~~Claude / Codex mark beside each name.~~ DONE.
10. Question options that can actually be answered.
11. Errors that report themselves.

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

## Bugs

### Open

- [ ] **The Mac app does not respawn a daemon that dies.** `DaemonHost` adopts a
      running daemon at launch (`DaemonHost.swift:51`) without keeping a handle
      or watching for its death; the restart logic only covers a child the app
      launched (`:92`, `:134`). So the app stays `.adopted`, shows no failure,
      and — worst part — *hides the start toggle* (`SettingsView.swift:593`),
      leaving no way to recover but relaunching. The fix is to watch socket
      liveness and start one only once the adopted owner is gone.
- [ ] **A new session in an untrusted folder never appears.** Claude Code holds
      it on "Is this a project you trust?" and does not write
      `~/.claude/sessions/<pid>.json` until that is answered, so conch cannot
      see it and the app looks broken. conch should say it is waiting on the
      terminal rather than showing nothing.
- [ ] **Duplicate terminal mouse-up events?** The daemon log repeats
      `copied 94 chars / copied 5 chars / copied 709 chars` many times. I read
      these as clipboard delivery-fallbacks and was wrong: the only emitter is
      terminal mouse-selection copy on pointer-up (`status.ts:1137,1197`), and
      delivery re-presses Return twice before falling back exactly once
      (`daemon.ts:3386,3420`). There is no retry loop. If nobody was selecting
      text, the thing to investigate is duplicated mouse-up, not delivery.
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

- [x] **The mic could not be closed.** A `sox` recorder wedged on CoreAudio
      ignored SIGINT *and* SIGTERM and held the device for 8m36s writing a
      zero-byte file, while the daemon logged "closing mic" six times. Every
      control — the app's mic button, the spacebar, the stop command — routes
      through `stopSoxProcess`, so all three appeared dead at once and the UI
      sat in "listening" with nothing able to move it. SIGINT still goes first
      (it is what makes SoX flush the tail of your last word), now followed by
      a verify and a SIGKILL for a recorder that was never going to answer.
- [x] **The mic opened in manual mode with no user action**, and the log could
      only say `wake -> "conch"` — five senders enqueue an identical bare wake,
      so it was unattributable after the fact. Wakes now carry who asked, and
      manual mode default-denies: only a wake conch can attribute to a person
      opens the mic. NOTE: the original sender was never identified. This makes
      a recurrence diagnosable; it does not explain the first one.
- [x] **Sessions took up to 20 seconds to appear or disappear.** Both agents
      publish liveness in a directory and both keep it honest, so the poll is
      now an FSEvents watch with the timer demoted to a backstop.
- [x] **"pause to send" read as a control.** It meant a pause in your *speech*,
      next to a product that has a pause mode.
- [x] **A failed send SPOKE in manual mode.** Every direct `speak()` now passes
      the same gate the announcement queue does (`daemon.ts:1783`).
- [x] **The Mac composer kept its draft across sessions.** Drafts are keyed per
      session now, as the phone already did.
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
- [x] **Mute is still live in two places** — retired from every surface. What
      remains is internal: `muted` survives as a state name that renders as
      "manual" (`status.ts:106,346,380`). A rename, not a bug.
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

- [x] **Manual mode should turn wake words off** — RESOLVED, and the premise was
      wrong in a way worth recording: conch has no wake-word listener at all.
      Nothing listens ambiently; the `"conch"` name-match only runs on speech
      already transcribed during an open mic window, so a wake word could never
      have opened one. The real hole was that manual mode did not gate wakes at
      all, which the origin work closes. The BUTTON keeps working, which was
      always the distinction that mattered.

- [ ] **Renaming a session only renames it inside conch.** The label is a conch
      override (`~/.config/conch/labels.json`) shadowing the agent's own name,
      so the terminal title and `/resume` picker still show the old one. Claude
      Code has `/rename <name>` — a local `immediate` command, so injecting it
      costs no model turn — which is the route. No Codex equivalent found yet.

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
- [x] **Which agent is this?** DONE — the real Claude and OpenAI marks, masked
      out of the source logos and tinted to the faint text colour, beside each
      session name.
- [x] **Context meter per session.** DONE — a number, shown when you click into
      a session. The progress bar it started as was more furniture than signal.
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

- [~] **Start and close sessions from conch** — DONE on the Mac
      (`src/session-lifecycle.ts`: Terminal `do script` to start, clean Ctrl-D
      with pid-exit verification to close). Not on the phone yet. Two gaps found
      in use: a session in an untrusted folder never registers (see Bugs), and
      the ledger took 20s to notice (fixed). Original text: New, or from a
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
- [ ] **Stop holding 1.3GB for a mic that is shut.** `whisper-server` (628MB)
      and the Kokoro worker (650MB) are resident full time — ~8% of a 16GB
      machine — on a Mac already at 57MB free with `kernel_task` pegged.

      **Kokoro: tie it to MODE, not to a button.** Manual mode unloads it and
      uses `say`; auto mode warms it. This costs nothing in practice because
      `say` is *already* what speaks: 124 fallbacks to it in one log while
      Kokoro hard-restarted on synthesis timeouts. 650MB is currently held by a
      voice that is not talking. On-demand loading is NOT the answer for this
      one — measured warmups today were 18.4s, 14.9s, 10.5s and 30.6s, and they
      are slow *because* of the memory pressure they add to, so a cold start
      lands exactly when the machine can least afford it.

      **Whisper: pre-warm on the signal, not on a timer.** Tyler: "maybe
      whisper start on in auto mode tho, or it pre-warms itself when it knows
      its going to have to be on soon? i think its cold start is actually
      pretty quick." Right on both counts — it adopts an existing server in
      ~0s, and conch already knows a mic is coming (a turn ending in auto mode,
      the composer focused, a wake in flight). Warm on those, idle-unload
      after. Measure a genuine cold start first; every timing taken today is
      polluted by the thrash.

      Rejected, with the measurement: trimming the 8 loaded voices to 1. Each
      voice is 512KB against a 312MB model — it saves ~3.5MB of 650MB.
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
