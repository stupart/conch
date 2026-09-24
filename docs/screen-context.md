# Screen context

The daemon's answer to one question: **what is on Tyler's screen right now, and
which agent session owns it?** The code is `src/screen-context.ts`.

Two things Tyler said (09-25) set its shape:

> the portion of the deamon that says what is on screen is modular so we could
> potentially add a light local (or cloud) vision model to it if we find clear
> use in that vs it being programatic.

> it might not only be local host things in browsers that agents are showing -
> could be Mac apps, Figma, iphone sim, terminal, video in media player, image in
> preview, live urls, other apps.

So the service has three parts, and each one is a list: you add an entry, you
don't edit a function.

```
observers ──observation──▶ resolvers (in order) ──▶ showing ──▶ published state (`showing`)
 (evidence)                (pure functions)          (memory)    conch_on_screen
                                                                  local log (JSONL)
```

## Contracts

### Observation: raw evidence from one observer

```ts
{
  v: 1,
  source: "conch-staged",            // an id in SCREEN_OBSERVERS
  at: 1790000000000,                 // epoch-ms, when the observer saw it
  app?: { bundleId, pid?, name? },   // the app showing it
  window?: { title? },
  surface: ...,                      // below
  staged?: { sessionId, reviewId?, artifact?, link? },  // conch put it there itself
}
```

`surface` is a tagged union:

| kind | fields | e.g. |
|---|---|---|
| `file` | `path` (absolute) | a markdown deliverable in an editor |
| `url` | `url` (http/https) | a localhost preview, a live site |
| `terminal` | `tty?` | a session's own terminal |
| `simulator` | `udid?`, `bundleId?` | the iPhone Simulator running a build |
| `app` | `bundleId`, `document?` | an app, when nothing more can be read |
| `design` | none | Figma |
| `conch` | `sessionId`, `view: panel \| overlay \| main` | conch's own window or overlay |
| `unknown` | none | an observer saw something it can't name |

The socket takes it as `{kind: "screen-observation", observation}` and checks it
strictly, like the other socket messages (`validateScreenObservation`). It
checks types and bounds, refuses control characters, and requires a known
surface kind and a registered observer. It rebuilds the value, so no field it
didn't check survives. It answers `screen-ack` at once, or `screen-error` with
the field that failed. It never waits on the resolvers. The message is
evidence, not a command, so it is handled before any session is resolved.

### Resolver: a pure function

```ts
resolve(observation, context) → { sessionId?, reviewId?, artifact?, confidence 0..1, reason, candidates? } | null
```

`context` holds the live sessions (`cwd`, `workDirs`, `pid`, `tty`), the
deliverables they still hold (`reviewId`, `link`, `artifact`), the time, `$HOME`,
`realpath`, and, for a page on a localhost port, who listens there
(`listeners`). Anything slow or impure, such as a real path or a port's
listeners, is gathered into the context first, so the resolvers themselves stay
pure.

`SCREEN_RESOLVERS` runs in order and **the first to answer wins**. Put stronger
evidence first. When the evidence fits two sessions equally, a resolver returns
`candidates` and no `sessionId`, with the confidence split between them. It
never guesses.

| # | id | matches | confidence |
|---|---|---|---|
| 1 | `staged` | conch put it there (`staged`), or conch's own window names the session | 1.0 |
| 2 | `deliverable-link` | a file's real path, or a URL's origin and path, equal to a held deliverable's link; the newest version wins | 0.9 |
| 3 | `terminal-tty` | a terminal's tty is a session's tty | 0.8 |
| 4 | `localhost-port` | a page on `localhost`, `127.0.0.1` or `[::1]`: a session whose process is up the listening process's parent chain (it started the server; the nearest wins) | 0.7 |
| | | else the listener's working folder inside a session's folder, as `folder` matches | 0.6 |
| 5 | `folder` | a file inside the most specific session `cwd`/`workDirs`. `$HOME` is skipped, because a session started there would own every file | 0.5 |
| — | *vision* (slot) | a model's match of a screenshot to a held deliverable | the model's |

**Who listens on a port** (`portListenerLookup`) is gathered before the
resolvers run, because it takes subprocesses: `lsof -nP -iTCP:<port>
-sTCP:LISTEN -Fp` for the listening pids, then, side by side, `lsof -a -p
<pids> -d cwd -Fn` for their folders and `ps -Ao pid=,ppid=` for their parents.
Each probe has a 1 s leash (`probe.ts`); one that fails or runs out of time
leaves its part unknown, and no listener names no one. It is cached per port for
5 s, since the front-window observer re-reports a page every few seconds. A
staged observation skips it, because it already says whose it is. While a lookup
is out, the observation waits; anything observed meanwhile is newer, and wins.
The parent chain outranks the folder: a folder only says where a server runs,
and two sessions in one repo share it.

`artifact` comes from the held deliverable's own published record when it has
one, and otherwise from the link. Deliverables are matched only by their
`reviewId`, `link` and `artifact` strings, so this module does not depend on how
deliverables are typed.

### Showing: the answer

```ts
{ sessionId?, reviewId?, artifact?, surface, source, confidence, reason, candidates?, at }
```

The daemon keeps only the latest, and only in memory. It is published as a
top-level `showing` in the published state (`buildPublishedState`) and returned
by the `conch_on_screen` MCP tool. Any caller may use that tool, and it changes
nothing. `reason` starts with the resolver's id (`staged: conch put it on
screen`).

## Observers

### Built: `conch-staged`

This observer runs in the Mac app. It knows only what conch itself put on
screen:

- **The Ready pill and the panel's Next** both go through
  `ConchStatusItem.stage` (`StatusItem.swift`), whichever scene they bring
  forward:
  - **a link.** It reports from `NSWorkspace.open`'s own completion, including
    the app that opened it. That app used to be discarded.
  - **the terminal.** It reports after the daemon has acknowledged that there
    is a window to raise.
  - **conch's window on the session.**

  Each of these reports carries the session, the review id and the link.
- **The panel shows it itself.** A pick in the conversation panel (its
  switcher, Previous and Next) of a deliverable the panel draws, or of a
  session with nothing to open, goes full screen in the panel instead
  (`ReviewQueue.show`, `FloatingPanels.swift`). It reports a `conch` surface
  with `view: panel`, carrying the session, and the review id and link when a
  deliverable is what shows.
- **conch's own window shows a session.** This covers a pick in the dashboard
  or the menu (`ContentView`'s `workspace.viewing`). It counts only while conch
  is in front, and not when it repeats the last report. Otherwise the pill's
  own pick would overwrite the review it just staged.
- **conch comes back to the front.** Its window shows its session again
  (`ContentView`, on `didBecomeActiveNotification`), so whatever app was in
  front before stops counting.

It sends through `StateStore.reportShowing` and doesn't wait for an answer. On
its own it can't know when Tyler moves on; `front-window` is what does.

### Built: `front-window`

This observer also runs in the Mac app (`FrontWindowObserver.swift`). It
reports the app in front and, where it can be read without asking for anything,
what that app shows.

- **When.** It reads half a second after
  `NSWorkspace.didActivateApplicationNotification`, so a burst of switches is one
  reading. With the Accessibility grant it also reads every 3 s, because a new
  tab or document changes what is shown without activating anything. A newer
  reading replaces one still waiting, and an answer that arrives after the front
  app changed is dropped. conch itself is skipped: its window reports through
  `reportShowing`, which knows the session.
- **What, by app** (`ScreenAppKind` in ConchDesign):

  | app | surface | needs Accessibility |
  |---|---|---|
  | Terminal, iTerm2, Ghostty | `terminal`, no tty | no |
  | Simulator | `simulator` | no |
  | Figma | `design` | no |
  | any app whose front window has a document (Preview, QuickTime, TextEdit, Xcode) | `file` from `AXDocument`, or `url` when that is a web address | yes |
  | Safari | `url` from `AXURL` on the page's web area | yes |
  | Chrome, Brave, Edge | `url` from the address field's text | yes |
  | anything else, or any of the above without the grant | `app` with the bundle id | no |

  Chrome hides the scheme of what its address field shows, so a bare address
  gets `http://` back for localhost, `127.0.0.1` and `[::1]`, and `https://`
  for anything else (`ScreenAppKind.addressFieldURL`). A browser window is
  searched breadth first, through at most 300 elements, never into the page
  itself. Each Accessibility call runs off the main thread with a 0.25 s
  timeout.
- **What it can't see.** Which Terminal tab is in front: only Terminal's
  AppleScript says, and that would need the Automation grant. The booted
  Simulator device: no resolver would use it yet.
- **The permission.** It only checks `AXIsProcessTrusted()`, which never
  prompts. It never calls `AXIsProcessTrustedWithOptions` with the prompt
  option and never uses AppleScript, so it can't raise the Accessibility or the
  Automation dialog. Without the grant every report is app-level. Onboarding
  will ask for the grant; granting it later takes effect on the next reading,
  with no relaunch.
- **Staging still wins** (`ScreenReportGate` in ConchDesign, which both
  observers go through in `StateStore`):
  - A report that repeats the last one said, from either observer, isn't sent.
  - For 3 s after conch stages something into an app, that app's front-window
    reports are held, because the app is still getting there. Chrome shows the
    old tab, then the page conch opened. A held report isn't counted as said,
    so the first reading after the grace is sent if it still differs.
  - conch's own window is never held, since a pick there is Tyler's.
  - While the conversation panel fills the screen, nothing the front-window
    observer reads is sent: the app in front is behind the panel, and the
    panel's own `view: panel` report is what Tyler sees. The moment the panel
    docks or hides, the app in front is read again, so `showing` catches up
    (`ScreenReportGate.covered`, `StateStore.screenCovered`).
  - A report counts as said only once the daemon answers `screen-ack`. One it
    never heard is sent again at the next reading, and a published state with
    no `showing` (a daemon that has just started) makes the gate forget what it
    said, so a restart doesn't leave `showing` empty until Tyler switches app.
- **Titles.** A window title is never read, so it can't be sent or logged.

### Not built yet

These are listed roughly in the order they are likely to be worth building:

- **Terminal's tab** (`terminal-tab`). The front tab's tty, read over Terminal's
  AppleScript, so `terminal-tty` can name the session. It needs the Automation
  grant for Terminal, asked for by onboarding.
- **Simulator** (`simulator`). Take the booted device's front app bundle id,
  find the DerivedData folder whose `info.plist` has that `WorkspacePath`, and
  map it to a session by folder.
- **Vision** (`vision`): a light local model, or a cloud one. It uses OCR or a
  VLM to match a screenshot of the front window against the held deliverables.

## How to add one

### An observer

1. Add `{ id: "your-observer" }` to `SCREEN_OBSERVERS`. The socket refuses any
   source that isn't listed there.
2. Produce observations:
   - **In an app**, send `{kind: "screen-observation", observation}` over the
     socket. The Mac's `ConchScreenObservationReport` is the template.
   - **In the daemon**, give the entry a
     `start(emit) { …; return stop }`. `createScreenContext` starts it and
     stops it at shutdown.
3. If it sees a new kind of thing, add a `surface` kind to the union and to
   `validateSurface`, with its required fields in `REQUIRED_SURFACE_FIELDS`.

### A resolver

1. Write `{ id, resolve(observation, context) }`. It must be pure. If it needs
   something from outside, add a field to `ScreenResolveContext` and fill it in
   `screenContextFromPublished` (or wherever the daemon builds the context).
   Something slow that depends on the observation is looked up in `observe`
   before the resolvers run, the way `listeners` is.
2. Put it in `SCREEN_RESOLVERS` at the position its evidence deserves.
3. Use `oneOf` for ties, so that an ambiguous match returns `candidates` rather
   than a guess.

### Example: a vision model

A screenshot needs capturing (the Screen Recording grant) and a model call,
which takes time and costs money. None of that belongs in a resolver, so it
splits in two:

- **The observer** (`vision`) runs in the daemon or the app. It captures the
  front window only when the cheaper observers returned `unknown` or a
  low-confidence answer. It asks the model which held deliverable the
  screenshot shows. A local model (OCR text matched against the deliverables'
  summaries and paths) keeps the image on the Mac. A cloud model sends the
  image off the Mac, so it needs an explicit, separate opt-in. It emits
  `surface: {kind: "app", bundleId, document?}` or `{kind: "unknown"}`, and
  puts the model's pick in `staged`-like evidence, e.g. a `vision: {reviewId,
  confidence}` field added to the observation.
- **The resolver** (`vision`) goes in the last slot. It trusts that field at
  the model's own confidence, and only when nothing earlier answered. The
  ordering test (`screen-context.test.ts`, "the first that answers wins") shows
  a vision resolver in that slot.

## The local log

This is the raw record for later uses. Tyler: *"would like that raw data live
pumped into atlas in the future but can just use for conch for now. Could also be
the used for time tracking and seeing where my time is going per-project and
activity type ... as a separate future app - out of scope."* For now conch only
writes it.

- **Where:** `<config dir>/screen/YYYY-MM-DD.jsonl`, i.e.
  `~/.config/conch/screen/` (`CONCH_CONFIG_DIR` moves it; the tests use a temp
  dir). There is one file per UTC day. The directory is 0700 and the files are
  0600.
- **A line:** `{v:1, at, until, sessionId?, artifact?, reviewId?, surfaceKind,
  app?, projectCwd?, confidence}`.
  - `app` is the bundle id.
  - `projectCwd` is the session's first working folder, else its cwd. It is the
    "per-project" key.
  - `surfaceKind` is the "activity type" key.
- **When:** a state is written when it *ends*, with `at` and `until`. It is
  written only if it lasted at least 2 s, so a passing glance doesn't count. A
  glance is dropped, and the state it interrupted carries on as a single line.
  Identical consecutive states count as one state. At shutdown the daemon
  closes the open state.
- **Caps:** files older than 30 days are deleted, then the oldest files go
  until the total is under 50 MB. The file being written is never deleted.
- **Setting:** `screen-log`, on by default and local only. It is not in the
  agent-tunable list, so only Tyler can change it
  (`conch set screen-log false`, `CONCH_SCREEN_LOG=0`). When it is off, nothing
  is written, and the state the log was holding is forgotten.

## Privacy rules

1. **The log never leaves the Mac.** Nothing reads it except conch. It doesn't
   record the surface's path, URL or window title. The one location it keeps
   is `artifact`, because that says which deliverable, and it is a link an
   agent already published.
2. **The published `showing` reaches the paired phone.** Because of that, a
   surface keeps its path or URL only when it resolved to a session, i.e.
   something an agent put there. Anything else goes out as `{kind}` alone
   (`publishedShowing`). `front-window`, which sees whatever Tyler opens, gets
   this rule for free, as will any observer after it. None may bypass it.
3. **Nothing is sent to a model by default.** A cloud vision observer needs its
   own opt-in, separate from `screen-log`.
4. **No observer asks for a grant.** Accessibility, Automation and Screen
   Recording are for onboarding to ask for, saying what each one is for. An
   observer only checks, silently, and does what it can without one:
   `front-window` reports the app alone until Accessibility is granted.

## Future work (out of scope)

- **The Atlas export.** Stream the log's lines, or the live `showing` changes,
  into Atlas as they happen. The line format is versioned (`v: 1`) and
  self-contained (`at`/`until`, no joins), so an exporter can tail the files
  without reading conch's state.
- **Time tracking.** Sum `until - at` by `projectCwd` and `surfaceKind` per day.
  This would be a separate app that reads the same files.
- **Checkpointing the open state.** A daemon that is SIGKILLed loses the state
  that was still open. If time tracking ever needs that time back, write the
  open state on a timer.
