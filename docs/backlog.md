# conch backlog

Everything Tyler has reported or asked for, and where it stands. Cross off or
delete as they go. Newest at the top of each section.

## Short-term plan

Where we are, so it does not get lost between sessions.

1. **Nail the basics.** Nearly there — sends work on both agents, speech no
   longer talks over you, sessions no longer block each other, and the composer
   is on every pane.
2. **Auto / manual mode** — remove mute, rename pause to what it actually is
   (see below). FIRST, because the words chosen here run through the apps, the
   CLI and the plugin's vocabulary, and everything after would have to be
   rewritten around them.
3. **The mic should fill the composer** instead of injecting past it, so typed
   and spoken text combine.
4. **Write the behaviour rules for both apps** and make them agree.
5. **Act on the plugin audit** — the findings are in, the fixes are partly
   done; the rest wants the vocabulary settled first.
6. **Then the vision**, which Tyler is going to describe, and which everything
   above is groundwork for.

### Decided: mute goes, and pause becomes a MODE

Tyler's reframe, which is better than either name: these were never two
features, they are two modes of the same one.

- **Auto** (today's "unpaused") — finished turns read themselves aloud and the
  mic opens on its own. Hands-free.
- **Manual** (today's "paused") — everything still works and updates; it simply
  does not speak first or open the mic on its own. You read, and press recite
  on anything you want aloud.

That is what pause already IS, described honestly, and it makes mute redundant:
mute's only unique property is FORGETTING finished turns, which has already
cost Tyler two of them. A mode nobody would choose on purpose is not a mode.

The backlog objection — that resuming dumps the whole backlog at once — has its
own answer, also his: resume ONE session, or the ones you choose, using the
per-session controls that already exist. The queue is not the problem; being
forced to take all of it at once was.

## Bugs

### Open

- [ ] **A conversation can render empty until you scroll it.** Tyler opened
      asset generator, saw nothing while the row said it was waiting for him,
      and the content appeared only once he scrolled. He waved it off, but an
      empty pane over a session with content is indistinguishable from a broken
      one — and in the feed it would be the whole screen. Likely the lazy stack
      not laying out until the scroll view is touched.
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
