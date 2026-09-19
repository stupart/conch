# conch backlog

Tyler says it; it lands here the same turn. Nothing moves to **done** without evidence
beside it — a commit, a measurement, or a picture. "Should be fixed" is not evidence.

Status: **open** · **doing** · **done** (with proof) · **won't** (with the reason)

---

## Open

### UI / UX
- **open** — The bar above a deliverable. Green check + session name + full title + expand, with
  the path and "Open in browser" under it. Clutter above what should be a preview of the work.
  Tyler: "i don't get what its for an it adds clutter / jank". Mac **and** iPhone.
  Earlier, same thing: "just liek and image or preview of the work with little or no text".
- **open** — Sent messages do not appear in the Mac transcript. Wants the phone's shape: the
  message lands instantly on send, then confirms with a checkmark.
- **open** — Left sidebar cannot be collapsed or reopened, and the split cannot be dragged, so the
  main area cannot be made smaller.
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
