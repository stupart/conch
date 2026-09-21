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

## Open

### UI / UX
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
- **open** — A real workspace pane: file tree, diffs and a terminal borrowing CotEditor's shape,
  plus a browser. Tyler: "where are we on being able to have a terminal and see the full file tree
  and diffs borrowing from this app: https://coteditor.com as well as a browser in the side panel".
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
- **open** — App icons need real artwork (~1024² PNG, no alpha) at `assets/conch-icon-1024.png`.
- **open** — A working/spinner glyph, and `needs`/`review` as filled badges.
- **open** — Search.
- **open** — No red spelling underline in the composer. Pre-existing; probed and NOT caused by the
  TextKit 1 fallback the caret fix introduced.

### Engineering
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
- **open** — Six versions of ONE artifact can crowd distinct artifacts off the daemon's
  `MAX_SESSION_REVIEWS` cap of 6 (`src/panel.ts`). Now that filings of a link group into one tab
  (`bfc4337`), the cap counts versions where the reader counts artifacts: a session iterating on
  one page six times loses every other deliverable it filed. A per-GROUP cap would fix it, but it
  is a wire-size change — the daemon would hold more than six — so it needs deciding rather than
  slipping in.
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
