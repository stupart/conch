# conch backlog

Tyler says it; it lands here the same turn. Nothing moves to **done** without evidence
beside it — a commit, a measurement, or a picture. "Should be fixed" is not evidence.

Status: **open** · **doing** · **done** (with proof) · **won't** (with the reason)

---

## Direction — the deconstructed UI

Tyler, 2026-09-19. Longer-term shape rather than discrete bugs; recorded whole because the
pieces only make sense together.

**The conversation panel IS the input box, taken with you.** "bring your favorite parts of the ui
with you". One input box visible at a time. Drag it off the conch window and toss it, and it
becomes the overlay; the app keeps the rest. The overlay is not a second UI, it is the same input
box relocated.

**The overlay has to say which conversation it is.** And a way to cycle. Best case it INFERS the
session from what you are looking at — "would be so great if it knew just based on what you were
looking at what convo it was". A small local model could do that.

**Annotate the screen as a prompt.** A mode where you record, click, draw, leave comments and
annotate, and all of it goes as the prompt along with anything you say. A button on the
conversation panel, or over the deliverable pane.

**Full screen means the deliverable's own home, not conch's.** Today's full-screen button fills
the conch window. Instead it should open the thing where it actually lives — the same idea as the
existing "Open in browser", but for the deliverable — and bring the conversation panel with it.
Chat and panel stay the in-app toggles; full screen becomes the deconstructed mode. Panel mode
still covers "fill the app".

**Agents get real control of their panes.** Live web pages inside a deliverable pane, watching an
agent drive one, and the user able to reach in and interact — the way the Codex app does it.

---

## Plan — the deconstructed UI, approved 2026-09-25

Tyler: "I like the current Mac app - keep it - this is just the deconstructed ui stuff". This
extends the conversation panel (the overlay, `Fog*` in code) and the pill; it is not a new mode.

- **Wave 1**, shipped 2026-09-25
  - Typed deliverables (#405): `kind`, a stable `artifact` + `version`, `conch_deliverables`,
    remove (`review-remove`, agent `review_remove`, Remove on the Mac tab), daemon-side link
    checks. Remove only appeared once #411 stopped the Mac dropping `features`.
  - Screen context (#403): observers → ordered resolvers → `showing`; `conch_on_screen`; a local
    screen log. Tyler: "modular so we could potentially add a light local (or cloud) vision
    model", and the raw log is for Atlas and time tracking later.
  - The panel (#404): header, session switcher, Previous/Next over every held deliverable, no
    content → full-screen transcript, optional reply line.
  - Phone (#402): every held deliverable, HTML with its folder's assets, markdown images.
- **Wave 2**, shipped 2026-09-25 (lab: `conch-design/panel-lab.html`; research:
  `conch-design/canvas-research-2026-09-25.md`)
  - Full screen shows the deliverable in the panel with the reply floating over it (#406).
  - The canvas (#410): clear glass over the screen, click-through unless the pen is down,
    ⌃⌥⌘P; Send a still to whoever owns what's on screen.
  - Agent ink: `scene.marks` on `review_to_front` (#408), drawn on the Mac (#412) and the phone
    (#416), never where it wasn't found.
  - Show (#413): a screen recording sent as keyframes and a storyboard; narration (#415) is
    recorded and transcribed by the daemon, which holds the mic like a dictation.
  - Figma in the review pane (#407).
  - Still to do: the motion pass — Tyler tunes `panel-lab.html`, then its values are ported.
- **Wave 3**, shipped 2026-09-25
  - Recognising what Tyler opened himself (#409): the front window (Accessibility, never
    prompted), and a localhost page → the session that started its server.
  - The phone (#414, #416): relay throughput, dev servers through conch (`conch-dev://`), agent
    marks, Remove, and Mac-only work (an app window, the Simulator, a document) as a snapshot.
  - Still to do: phone → Mac video.
- **Then** (Tyler, 2026-09-25): connect it to the Mac app "so its fluid back adn forth", and a
  clean onboarding — "download or connetc your agents, get a walking thorough of everything, make
  sure permissions are rrec and so on".

## Open

### UI / UX
- **done** (#388) — A long message shows twice in the conversation (2026-09-23, the brand identity
  session). Tyler: "Im seeing messages twice in the conch ui". Claude Code records text that
  conch pasted (anything over `PASTE_OVER_CHARS`) as `\n\n<pasted_content id="6a36">…</pasted_content
  id="6a36">`, so the row showed the raw tags and the app's own "Sent" bubble never matched it. The
  wrapper is now stripped wherever conch reads a Claude user record. The first such message in that
  transcript really was sent twice (two prompts nine minutes apart), so that part was not a bug.
- **done** — Background agents as a small group under their session, each one selectable, the way
  Claude Code's own agent view is. Tyler (2026-09-23): "have the agents show under smaller as like
  a group and you can select on them as well just like is possible in the Claude Code ui". The
  daemon built the published model from `live`, so C4's nested rows never left it; it now uses
  `visible`, agents get their own four published conversations, and both apps draw them as a
  compact group under the parent ("3 agents · 2 running" on the Mac, small rows on the phone).
- **open** — The iPhone cannot open a deliverable that is a file on the Mac. Four `open-link`
  failures on 2026-09-21 17:09 from `source: ios`, all reading "That's a file on your Mac, not a
  page: /Users/…/Asset Generator/mcp-plugin-workflow-review-2026-09-17.md". The message is
  honest and the phone genuinely cannot reach that path, so the fix is not "open it anyway" —
  it is either serving the file through the bridge conch already runs, or not offering the
  control for a link the phone cannot follow.
- **open** — The composer still cuts a blank band in the PANEL view. The conversation arm layers
  it in a `ZStack` and hands the stack its measured height as `bottomInset` (`af61d67`,
  `992d843`), but that is the only call site: the side-by-side arm keeps `floatingComposer` as a
  plain sibling in the VStack, so it takes layout space and clips. Tyler: "the input panel is
  still crating that cutoff blank space on the panels view (we fixed it on the conversation
  view)". In flight.
- **open** — Spell check does not work in the input box, and the flag is already set:
  `ComposerView.swift:945` sets `isContinuousSpellCheckingEnabled = true`, but the field typed
  into is a SwiftUI `TextEditor` (~:467) while that setting is applied to the bridged NSTextView
  (~:841). The switch exists and does not reach the editor. In flight.
- **open** — A SECOND control that fills the window with the deliverable and floats the
  deconstructed input over it. Tyler, 2026-09-21: "maybe it like makes that thing fullscreen with
  the deconstructed input ui stuff showing over top?" This read as a reversal of `#338`, which had
  just repointed that same control to open the deliverable where it LIVES — from Tyler's own
  Direction note, "Full screen means the deliverable's own home, not conch's" — so it went back to
  him rather than being built on a guess. Decided the same day: BOTH. The arrow keeps going out;
  fullscreen becomes its own gesture. Not built yet, and it is second in line behind the thing it
  floats: the deconstructed input UI does not exist yet.
- **open** — The left sidebar cannot be dragged into the order you want. Tyler: "i would like to
  be able to drag around and reorganize the left side bar oranixation of things." Grouping is
  DERIVED today (`SessionGrouping.folders`), so there is no user-owned order to drag, and a
  manual order has to answer what happens to a dragged row when its folder changes. In flight.
- **open** — Filling the stage with a deliverable (⌘3) still does not mark it viewed. Only a tab
  click and the inline card do (`bfc4337` fixed the card; the tab always did). Same class of gap:
  the dot stays on something you are looking at full screen. Found by the versions agent and left
  deliberately rather than widened into its PR.
- **open** — The files pane shows the whole working folder; it should be scoped to what the
  session is actually working on. Tyler, 2026-09-20: "for the files deally thats more scopped
  to whats being worked on by the projects but can leave for now". The material is already
  there — `ConchFileChanges` knows every path this session touched — so a "changed only" view,
  or a root inferred from where the changes cluster, needs no new wire.
- **open** — The terminal might belong IN the input box as a mode rather than as its own tab.
  Tyler: "terminal should probably just be like a mode in this input boc instead of a seperate
  thing maybe? not sure". Unresolved on purpose: one input box that changes meaning is fewer
  things on screen, but it also makes the composer modal, and a mode you forget you are in
  sends a command to an agent or a message to a shell.
- **open** — The deliverable pane's address bar shows the whole URL, so the origin is buried
  mid-string where it used to lead. That bar's stated job is telling a third-party page apart
  from conch's own chrome, and with navigation now free (`ae69957`) it is the only thing doing
  that job. Seen on screen 2026-09-20: `https://github.com/stupart/seashell/pull/13`. Safari
  solves this by emphasising the domain and dimming the rest; this should too.
- **open** — "Open in browser" is clipped under the stage control, which is overlaid
  `.topTrailing` on the same corner the origin bar's trailing button occupies. Pre-existing —
  visible in captures from before the address bar landed — but the longer address makes it
  reliably reachable-looking and unreachable.
- **open** — The terminal pane puts a second text field directly above the session composer, so
  two inputs sit one line apart with nothing saying which has focus. Found the hard way while
  verifying the pane: a click that missed the terminal field left keystrokes to be read as
  global shortcuts, which set conch speaking. Wants a visible focus treatment, and probably a
  key that puts the cursor in the terminal.
- **open** — Old deliverables render as live in-conversation cards. Tyler: "this one is showing
  green circle with a check tho becuase of a really old deliverable that shows at the bottom of teh
  chat. maybe old deliverables show in teh deliverable area as tabs but not as like in-convo ui
  elements? only new ones show as in-convo ui elements?" `ConversationStackView` takes one
  `artifact: ReviewInfo?` and pins it at the end of the stack — the comment even says "for
  one-artifact-per-session IS where it happened", and that assumption is what breaks. `ReviewInfo`
  already carries `at`, `id` and `viewedAt`, so gating the inline card needs no new plumbing.
- **open** — Status colour semantics are backwards. Tyler: "does orange dot mean its waiting for
  me? We should make that green or blue or something and have working be like yellow or orange or
  some sort of working icon or no icon or color at all since its working".
  DECIDED: waiting becomes green like review, keeping its existing `circle.inset.filled` glyph so
  the check alone distinguishes review — Tyler: "maybe do same green circle just with no check?".
  The glyph is already right; only the colour moves. `needs` stays red as the blocking state.
  MEASURED: review's own `#30B35A` FAILS the 3:1 a mark needs on light (2.58 on bg, 2.72 on
  surface) — the same trap the palette note records for the review gold at 1.3:1. `#279B4C` clears
  it (3.39 / 3.57). Today's orange fails too (2.11 / 2.22), so this is not a regression introduced.
  Reverses a documented decision: waiting was moved to orange to read "as attention rather than
  inert grey" and to separate it from review, which were "20/255 apart in a single channel".
- **open** — The bar above a deliverable: `ReviewSurface.caption` (ReviewView.swift:113) — check +
  session label in brand cyan + summary + expand. Tyler: "i don't get what its for an it adds
  clutter / jank". Earlier, same thing: "just liek and image or preview of the work with little or
  no text". **Mac only** — iOS's `ReviewCard` is already just check + summary.
  NOT the web origin bar beneath it (globe + origin + "Open in browser"): that is a deliberate
  trust boundary, because a deliverable is an agent-authored URL rendered full-bleed in conch's own
  chrome and a third-party sign-in page would otherwise be indistinguishable from conch's UI.
  `test/review-mark.test.ts` pins that checkmark in three places.
- **open** — A real workspace pane: file tree, diffs and a terminal, plus a browser. Tyler: "where
  are we on being able to have a terminal and see the full file tree and diffs … as well as a
  browser in the side panel".
  STATUS, looked up rather than guessed — one of four exists:
  BROWSER, DONE `ae69957` — the pane browses now, with an address bar. `DeliverableWebView` renders HTML
  deliverables full-bleed. What is missing is arbitrary browsing and a page an agent drives while
  you reach into it — the Direction note above, not a new engine.
  DIFFS, partial: `DiffLine` (`ConversationStackView.swift:1280`) draws an edit's changed lines
  inline in the transcript. `Models.swift:563` says outright "Not a unified diff" — that was a
  deliberate choice for scanning a stack, so a real diff VIEW is additive, not a fix.
  FILE TREE, DONE `21f614b`: the session's working folder is a tab in the work half, with the
  files it changed marked in place — a folder holding a change marked more quietly than the
  changed file, so the route to the work reads without every folder claiming to be edited.
  Listing is cached and off the main thread; flattening is a pure function with unit tests.
  TERMINAL, DONE `6a975fd` — a command runner in the work half, scoped by the measurements below.
  A spike compiled and ran
  a real PTY from Swift: `forkpty` typechecks from a bare `import Darwin` with no bridging
  header (proven against a negative control), the child is a real session leader with `isatty`
  true, and `TIOCSWINSZ` resizing works. No SwiftPM dependency is needed — which matters,
  because the Xcode project has zero remote package references and adding SwiftTerm would be
  the first.
  NOT sandboxed, so spawning a shell is permitted: `ENABLE_APP_SANDBOX = NO` in both configs,
  the entitlements file carries only audio-input, and `codesign -d --entitlements` on the
  SHIPPED binary agrees. Re-signed with `--options runtime` and run: spawns fine, so the
  hardened runtime does not block it either.
  SCOPE, from the byte counts rather than taste: across 51,854 bytes of real output from
  `git status`, `git diff`, `bun test`, `npm test`, `ls` and `swiftc` errors, 100.0% of escape
  sequences were SGR colour — two non-colour sequences in 6,417. Alternate-screen, cursor
  addressing and OSC titles: zero occurrences, in every capture. So a ~200-line colour-only
  scrollback view is correct-enough, and a full VT100 emulator buys nothing measurable. What it
  cannot do, said plainly: vim, htop, or an interactive rebase.
  THE BLOCKER that was not a parsing problem: `git diff` through a PTY HANGS on the pager
  waiting for a keypress there is no way to send — 723 of 21,934 bytes delivered, killed at
  25s. `GIT_PAGER=cat`/`PAGER=cat` in the spawn environment turns the worst case into the best
  one (complete output, 0s, pure SGR). Reuse `DaemonHost.daemonPath(inherited:)` for PATH:
  `bun` and `npm` are not on the default one.
  The inputs for the first three already exist — the daemon publishes file changes with paths
  (`fileChange`, `src/conversation.ts:653`) and every session carries its `cwd`
  (`Models.swift:864`). A terminal does not: it needs a PTY the daemon owns, which conch has never
  had, and that is the piece that makes this a project rather than a pane.
- **open** — Copy a session's name from the sidebar (right-click, beside the rename that is there).
- **open** — Overlay image paste. `ConversationFog.draft` is a plain `String` with no attachment
  concept anywhere in Components.swift, so this is a feature, not a patch.
- **open** — Glass reads dark over a light desktop: `.glassEffect` takes its base from the system
  appearance, so in Dark mode it stays a dark card on a light ground.
- **open** — Mobile input box grows without clipping lines.
- **done** — App icons need real artwork (~1024² PNG, no alpha) at `assets/conch-icon-1024.png`.
  Conch-Icon-v3 (the shell with its eyes out, 2026-09-23), through `scripts/make-icons.sh`.
- **open** — A working/spinner glyph, and `needs`/`review` as filled badges.
- **open** — Search.
- **open** — No red spelling underline in the composer. Pre-existing; probed and NOT caused by the
  TextKit 1 fallback the caret fix introduced.

### Engineering
- **open** — MCP servers accumulate per Codex session: 15 alive, **756 MB** combined (2026-09-21).
  One per long-lived session is the design; `pgrep -f 'cli.ts mcp'` shows pid `92162` owning
  FOUR (Sep 19, 14:50, 15:20, 16:13) and `54952` owning two. Measured while checking whether
  `/reload-plugins` had spawned duplicates — it had not, only 3 of the 15 were recent, so the
  accumulation predates it and is not the plugin reload's doing. `docs/daemon-side-effects.md`
  records "8 alive now, ~40 MB each ≈ 320 MB"; it is twice that.
- **open** — `records/history.sqlite` had not ingested the "Asset Generator" Codex thread past
  2026-09-16 — a five-day gap on a thread that was live at the time of measuring (2026-09-21).
  Found while locating a message in the record: the live path had it, the record did not, which
  is why the record could not be used to check what the app was showing.
- **open** — `stripEchoedQuestion` and `codexAsyncQuestionOptions` are defined TWICE, in
  `src/conversation.ts` and `src/records-codex.ts` (`2860ee2`), and the copies already disagree:
  one takes `ReadonlySet<string> | undefined`, the other `readonly string[]`, and the remember
  helpers have different names. Two live parsers of the same wire format is the reason they
  exist separately, but a rule about Codex's self-quote is one rule. Flagged at review as
  non-blocking because the behaviour is correct and gated; recorded because divergence has
  already started rather than being a future risk.
- **open** — The installed plugin is ten days stale, so agents run against an old contract.
  `~/.config/conch/plugin-dist/plugins/conch/AGENTS.md` is dated 2026-09-11; the repo's copy is
  today's. Measured 2026-09-21: zero files under plugin-dist mention `conch_working_folders`
  (`#345`), so the tool WORKS — `.mcp.json` there execs live source,
  `bun run ~/Projects/Conch/src/cli.ts mcp` — while no agent is ever told it exists. Refresh is
  `conch install-plugin` (`cli.ts` → `runInstallPlugin` → `materializeAtomically`), NOT a daemon
  start. Left for Tyler: it rewrites his MCP config, and the repo template
  (`${CLAUDE_PLUGIN_ROOT}/bin/conch-mcp`) differs from what is installed.
- **open** — A question an agent asks raises no signal on the row. conch files it correctly —
  verified in `records/history.sqlite`, the `AskUserQuestion` call recorded against this session
  with status `completed` — and `ConversationStackView` draws a real `questionRow` with clickable
  options. But it renders only INSIDE that session's conversation, so with the window closed
  (or another session in front) there is nothing to notice. Tyler, 2026-09-21: "i dont' think it
  surfaced your question in the mac app for me". A permission prompt reaches `needs-you` through
  the Notification hook (`ACTIONABLE` in `src/hook.ts`); a question has no such path, though the
  set already names `elicitation_dialog`.
- **open** — `~/.config/conch/records/history.sqlite` is **1.1 GB** (plus a 3.1 MB WAL), noticed
  2026-09-21 while querying it. Nothing measured about what it costs yet — recorded because
  unbounded growth in the file every session writes to is worth knowing before it bites.
- **done** — The deliverable ledger lives in `/tmp`, so artifact tabs vanish when the machine
  reboots or macOS sweeps it. Moved to `~/.config/conch/reviews.json`; the daemon reads the
  `/tmp` file once while the new one is absent. Measured before moving: the file was intact and
  every deliverable survived the 10:05 daemon restart, and this Mac had not rebooted in 24 days —
  so this was a reboot-only loss, not the one Tyler saw on an app relaunch (next item). `src/status.ts`: `REVIEWS_FILE = process.env.CONCH_REVIEWS_FILE ||
  "/tmp/conch-reviews.json"`, restored by `ledger.restoreReviews()` at `src/daemon.ts:674`. Every
  other durable conch file is in `~/.config/conch/` (device-id, labels.json, records/,
  settings.json, state.json) — this one is the exception, and it is the one holding the thing
  Tyler noticed losing: "the deliverables / artifacts tabs get lost when the app re-installs or
  restarts". Note the trigger is probably the DAEMON restarting or a reboot, not the app.
  Found 2026-09-21 while briefing the fix; in flight.
- **done** — Which deliverable tab is SELECTED is in-memory only and resets every launch:
  `WorkspaceModel()` is a plain `@StateObject` (ContentView.swift:12) and nothing encodes
  `SessionPresentation`. A second, separate loss from the ledger one above — fixing the ledger
  will not restore the selection. Confirmed app-wide: no `AppStorage` names a stage.
- **done** — A conch-internal per-session state file the agent can write, holding the left-panel
  enabled state, the deliverables/artifacts that session is showing, and the parent working
  folder(s) it is ACTUALLY in. Split by who owns each fact: the deliverables were already the
  daemon's (`reviews.json`, now durable); the folded folders and the picked tab are the Mac's
  (`WorkspaceMemory`, UserDefaults); the folders are the agent's — `conch_working_folders`
  writes `~/.config/conch/working-folders.json` like labels, the row carries `workDirs`, and
  the Mac's grouping and file tree, and the phone's grouping, follow the first one. Tyler, 2026-09-21: per-project was the first idea, but
  conch-internal "coudl be better incase theres multipel instances or it gets moved and restarted
  somewhere else", with conch keeping the mapping. The folders matter on their own: "sometimes
  its different than the folder i start the session in and that info would be more accurate for
  file-tree / file viewer and lefsidebar organization" — today `workingFolder` is derived from
  `row.cwd`, which is the folder the session STARTED in. In flight.
- **open** — Close can still fail in a way nobody has reproduced. One double-press run against a
  session that had sat ~10 minutes did not exit, and its poller saw no "press again" hint on
  screen at all, while nine further runs closed cleanly. No retry was added on purpose: a second
  attempt would blow the app's 12 s close budget. The absent hint is the tell — it suggests the
  keystroke never landed rather than that the window was missed, so if a close fails again this
  is the path to pull, not the press count. Found while fixing `f68f389` and left rather than
  widened into it.
- **open** — Nine guards still slice by a FIXED character count from a marker, which breaks the
  moment the code they read grows. Found 2026-09-21 when `composer.slice(loadAt, loadAt + 400)`
  failed while the rule it pins was still true — `load` had gained a doc comment and a branch,
  and the call it asserts moved past the window. The two in `mac-phase1-source` are fixed;
  these are not: `adopted-daemon-respawn:28`, `daemon-owner:98`, `daemon-side-effects:471,586`,
  `design-system-source:70`, `phone-speaking-latch:24`, `reveal-command:58`,
  `phone-telemetry:59`, `setup:431`. The idiom that works is already in the same files —
  `slice(at, source.indexOf("\n    }", at))`, an end marker searched FORWARD from the start.
  A count is a guess about how long a function will stay.
- **open** — Running real agent sessions inside conch's own terminal. Tyler: "could test having
  the real reaw sessios runnign in the terminal in th app that could be quite cool... is that
  possible for me to move one in here?"
  MEASURED 2026-09-20, and the answer is NO for existing sessions: tmux is not running at all
  (`error connecting to /private/tmp/tmux-501/default`), so `inject.ts` is taking its
  `osascript-focused` route and the sessions live in Terminal.app windows. A running process is
  bound to its controlling tty and cannot be re-parented onto a new pty from outside, so nothing
  can be MOVED in. Two things would make it possible, and they are separable:
  (1) conch hosts the sessions it starts in tmux — then any session can be attached from
  anywhere, and injection becomes the exact `send-keys` route instead of synthetic keystrokes;
  (2) the pane grows a real emulator — alternate screen and cursor addressing — because an agent
  TUI is exactly the case the colour-only scrollback was scoped out of. Neither is an increment.
- **open** — A streaming snapshot still costs ~75 ms at 300 rows, after BOTH the MemoRow fix
  and the republish fix. MEASURED 2026-09-20: 63% of it is SwiftUI's own graph walk, with
  `ConversationItem`/`Conversation` equality (~1200 samples) and `_stringCompare` (62 ms)
  underneath it — row keys AND `hasSamePresentation` both compare full item TEXT, so every
  token that arrives re-compares every message in the window. Wants a cheaper identity (the
  revision the daemon already sends, or a hash taken once per item) rather than more
  memoisation. `ConversationStackView.swift` and `Models.swift`.
- **open** — Why five overlapping captures of one sentence reach the exit drain at all. Both
  dictation fixes treat convergence points, not the source. Start at
  `src/dictation-controller.ts`, the capture→re-arm→transcribe path; the diagnostic is logging
  capture PCM byte ranges beside their transcripts.
- **open** — Post-launch session failures are structurally invisible: `runInTerminal` `exec`s, so
  conch never sees the agent's exit code and a crashed launch reads to the sheet as a hang.
- **open** — Top-corner docking lands 33 pt short of the true top edge; AppKit constrains a
  restored frame below the menu bar while `FogDock` computes against `screen.frame`.
- **open** — `scripts/build-app.sh` only relaunches an app it found running, so killing conch for a
  test and then installing leaves it down. Left conch not running twice in one session.
- **open** — `conch.conversationFullScreen` default so the capture manifest can drive full screen.
  Deliberately not added yet: the existing comment records a decision that a launch never restores
  a full-screen frame, and that should not be reversed silently.
- **open** — Token-level streaming. Out of reach for hand-started sessions: the transcripts carry
  no delta records, so per-message is the on-disk granularity. Needs `-p
  --include-partial-messages` (conch must launch it) or the Codex app-server daemon.

---

## Done

- **done** — Six versions of ONE artifact can crowd distinct artifacts off the daemon's
  `MAX_SESSION_REVIEWS` cap of 6 (`src/panel.ts`). Now that filings of a link group into one tab
  (`bfc4337`), the cap counts versions where the reader counts artifacts: a session iterating on
  one page six times loses every other deliverable it filed. Fixed without the wire-size change a
  per-GROUP cap would be: the cap still holds six filings, but drops superseded versions of an
  artifact before it drops another artifact (`capReviews`), now that every filing carries the
  `artifact` it is a version of. Pinned by `test/deliverables.test.ts`, "the cap drops superseded
  versions before it drops another artifact".
- **done** — One way out of a deliverable, and it opens the page you are on. The origin bar held
  four elements doing three jobs, and the two that looked like duplicates were not: the button
  opened `addressText` (where the pane IS) while the header arrow from `1997452` opened
  `review.link` (where it was FILED), so following a link in the pane made them disagree. Both
  test files already pinned the invariant — "Where you ARE, not where the deliverable was filed"
  — so it moved onto the arrow rather than being deleted with the button. `0389929`. Removing it
  also closed the clipping recorded above: it was the control the `.topTrailing` stage control
  overlaid. The first cut held the address as `@State` in the view, which compiled and was
  wrong — ⌘3 is answered by the PANE, which cannot see a view's private state, so the key would
  have opened the filed link while the arrow opened the live one. The pane owns it now.

- **done** — The transcript runs underneath the composer, and the card is narrow enough to see it
  do it. `af61d67` floated the composer over the conversation, its measured height handed to the
  stack as `bottomInset` with the spacer BELOW the bottom anchor, so scroll-to-bottom still
  reaches the document's true end. That half shipped asserting the other half: the code comment
  AND the test docstring both said "the card is narrower than the pane" while card and reading
  column were both `maxMeasure` = 700, so no line was ever visible either side and the page
  looked like it stopped at the card. Nothing checked the claim because nothing asserted it.
  `992d843` adds `composerMeasure` = 580 and a guard reading BOTH constants as numbers with a
  ≥100 pt gap required. Confirmed by looking at the running build, not inferred: "Linear" reads
  to the left of the card (2026-09-21 10:06).

- **done** — Close session works on Claude Code. Claude Code 2.1.266 treats Ctrl-D like Ctrl-C —
  one press only shows "Press Ctrl-D again to exit" and it leaves on a second within ~800 ms —
  and conch pressed once, so Tyler's close logged "session did not exit cleanly after Ctrl-D"
  (`~/.config/conch/errors.jsonl`, 2026-09-20T23:24:55Z, session `37426f84`) and the row stayed
  while the pid lived on. `exitKeystrokes` now belongs to the adapter (Claude 2, Codex 1 — Codex
  leaves on one press and its tab is gone within ~200 ms, so a second would land in whatever
  replaces it). Both presses ride ONE AppleScript with `delay 0.15` between and the front-window
  guard before each, since two osascript launches cannot promise the 800 ms window. `f68f389`.
  Measured 8/8 through the real close path on disposable sessions, plus one deliberate single
  press that reproduced the old failure. The fix is daemon-side, so the daemon was restarted
  onto it (pid 1997, 10:05) — rebuilding the app alone would have deployed nothing.

- **done** — The window stops re-rendering four times a second for a snapshot that has not
  changed. Main thread at true idle: 99 ms/s → **6 ms/s** (Time Profiler on the Release app,
  2026-09-20) — a flat 27 ms per 250 ms poll with nothing on screen changing, now ~1 ms.
  The cause was NOT `hasSamePresentation`, which was doing its job: at true idle the daemon
  does not rewrite the file at all (8 reads over 2 s byte-identical, `ts` included) and `state`
  was correctly left alone. Other `@Published` stores on the same poll republished the whole
  window anyway — `daemonMessage`/`isLedgerFrozen` (stored TWICE, from `accept()` and
  `evaluateLiveness()`), `newerDaemonWarningVisible`, `liveness`, and a mutating call on the
  `@Published` outbox whose `didSet` also wrote UserDefaults. `@Published` fires on assignment
  whether or not the value changed. Each is now stored only on change. `e10d704`
  CORRECTS this backlog's own earlier note: `SelectionOverlay.updateNSView` is **SwiftUI's own
  type**, reached through `.textSelection(.enabled)` — not a conch view and not ours to
  optimise. `ComposerView.body` is ~1 ms/s; the header buttons 0.02 ms each and already skipped.
  Written down because this file named it as the suspect, and the next person would have gone
  looking for a symbol that does not exist.
- **done** — The deliverable pane browses the web. DECIDED BY TYLER against my advice, with the
  trade-off stated: the pane used to hand any off-origin navigation to Safari, because a
  deliverable is an agent-authored URL in conch's own chrome and a third-party sign-in page was
  otherwise indistinguishable from conch's UI. The boundary is now DISCLOSED rather than
  ENFORCED — anywhere is reachable, and the bar always says where you are, reading the live url
  via KVO rather than the filed link. `file:` is still pinned to the published file, and a typed
  address is parsed as a web address (`DeliverableLink.url(for:)` would read "github.com" as a
  file path). The old lock had no test at all; the guards replacing it are mutation-checked. `ae69957`
- **done** — The transcript scrolls without the four stalls measured under it. The stack's body
  ran on every snapshot from ANY session (~4/s) and rebuilt every row: 44 markdown re-parses a
  second at 30 rows, 236 with history paged in, hitches 8 ms at 30 rows to 58–67 ms at ~300.
  Under that, `recordedRows` was a computed property re-read for every row it was passed to —
  n×n items per snapshot, **67% of the main thread at rest** with 520 rows, hitches 200–475 ms,
  quadratic in how far back you had read. Paging jumped because the restore ran 6–24 ms AFTER
  the frame changed, and `loadOlder()` re-captured on every scroll tick so pages were
  "compensated" by 2 pt. Streaming stopped following because the bottom anchor sat inside the
  14 pt padding and landed 14 pt short — past the 8 pt the follow test allows. After: 0 parses
  at rest, main 67% → 20% with ~700 rows, no hitch ≥ 50 ms, 51/51 pages absorbed in the same
  millisecond. 15 mutations, each broken→fails, restored→passes. `6cd4b43`
- **done** — A terminal in the work half: `zsh -lc <command>` on a real pty, in the session's
  own folder, with colour. A command runner rather than an interactive shell because a login
  shell's prompt is redraw a colour-only parser must swallow — measured, not chosen. `PAGER`
  and `GIT_PAGER` are pinned to `cat`, or `git diff` hangs on a keypress the pane cannot send.
  No dependency, no entitlement: `forkpty` from a bare `import Darwin`, app unsandboxed. `6a975fd`
- **done** — The file tree, as a second axis rather than a fourth page. `StageMode` still has
  three positions; what sits in the work half (a deliverable, or the files) is its own
  question, so side-by-side and fill-the-stage work on the files for free. Picking a file
  reuses `ReviewContent`, so there is no second viewer. Also fixed a live defect: ⌘2/⌘3 did
  nothing in a session that had never filed a deliverable. `21f614b`
- **done** — A message sent from the Mac appears the instant it is sent, and confirms with a
  checkmark once the daemon proves it landed. The phone's own `ConchOutbox`, not a second one:
  begun in `StateStore.send` so the conversation fog gets a bubble too, settled from the
  published receipt (before the `lastDeliveryAt` guard, or a relaunch's entries never settle),
  retired by the transcript's own copy. `34faa7f`
- **done** — The sidebar collapses AND the split drags. ⌘B and a menu item existed but nothing on
  screen said so — Tyler: "i see the sidebar drag but how do i full close / collapse it?" A
  `sidebar.leading` button now leads the title strip, inside the traffic lights, posting the same
  notification ⌘B does; it stays visible while collapsed. Width drags and is remembered, bounded
  180…520. `ec165a6` + `e4c890a`
- **done** — Overlay is an Apple Liquid Glass panel: rounded rect, hairline, grab bar, voice-tinted
  mesh, pre-26 fallback. `1c153b6`
- **done** — Panel floats 24 pt off the corner so all four corners round. `0a44d89`
- **done** — Words and buttons come inside the glass with it. `3371088`
- **done** — Panel resizes to the whole screen; the lab's 1280×900 cap stopped a 1117 pt screen
  217 pt short. `98b4785`
- **done** — Reply line's focus ring, for real: AppKit draws it on the enclosing `NSScrollView`,
  not the text view. `caf451a`
- **done** — Full screen keeps its background: the glass is excluded there by design and the blur
  had been hidden whenever glass was in use, so it had neither. `caf451a`
- **done** — Caret sits on the line. Not leading — the caret is drawn to the line fragment whose
  top is the ASCENT (ascender 14.50 vs capHeight 10.57). 7 px above/1 below → 3/4, measured on the
  shipped binary. `9469647`
- **done** — The introspector finds the editor whatever the nesting: the fixed two-superview hop
  missed 6 launches in 14, silently, taking the leading, the caret fix, spelling and drag types
  with it. `9469647`
- **done** — Pasted images attach: the paste bridge had the same fixed-depth bug twelve lines away.
  `9469647`
- **done** — A wider panel earns a wider column, not a wider margin: 620 → up to 1040 as it grows,
  keeping magnet travel. `4ebbec8`
- **done** — One markdown renderer for both transcripts: headings kept their hashes, tables were a
  wall of pipes, links had no underline. `fbd413b`
- **done** — The Arch Prime text that kept coming back. Four independent layers: Whisper doubled
  the clause (`46d8507`), the exit drain joined five captures (`a370445`), `live.dictated` is
  sticky by design (cleared by hand), and the applied id did not survive relaunch (`0fd6ea1`).
- **done** — Codex refuses the flag pair conch was sending it; `conflictsWith` at the shared
  chokepoint. `codex --help` exits 0 WITH the conflicting pair, so only a pinned argv catches it.
  `7ab89e5`
- **done** — Codex is not offered a model to override its own. `ffe54ab`, `194b045`
- **done** — A session waiting on permission says so. Codex threads parked on an approval reported
  "working" forever; separately `bypass-permissions: true` silenced every Claude announcement.
  `aabe101`
- **done** — conch sees a turn as it happens: Claude no trigger → p50 122 ms, Codex 5 s poll →
  p50 127 ms. `d9874f5`
- **done** — conch can photograph its own overlay and measure what it sees. `d3fb490`
- **done** — The overlay comes back the size it was left. Proven: wrote 1180×720, got 1180×720.
  `82484a1`
