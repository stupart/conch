# conch

**All your agents, in one place.**

conch is an agent manager for Claude Code and Codex on the Mac. Every session you have running shows up in one
window. Each one shows you its work: what it made lands in a review pane, marked where you should look, next to the
version before it. And each one talks it through: it reads its reply aloud in its own voice, and you answer by talking.
So you can work from wherever you are: the Mac app, your iPhone, or just your voice.

![The conch Mac app. On the left, sessions grouped by project, each row saying what it needs or what it is doing, with subagents under their session. In the middle, the "Landing page hero" conversation: the request, the agent's plan, and its reply. On the right, the page that session published, open in the review pane at its dev-server address, with the session's other results in tabs above it.](docs/images/conch-mac.png)

## Install

macOS 14 or later.

```bash
brew install stupart/tap/conch   # the conch CLI, and conch.app linked into /Applications
conch setup                      # speech model, Claude Code hooks, the conch plugin, background start
```

`conch setup` downloads the whisper speech model (about 574 MB, unless it finds one already), wires Claude Code's
hooks, installs the conch plugin for Claude Code and Codex, checks everything with `conch doctor`, and leaves conch
running in the background: as the Mac app, which opens at login and hosts conch's daemon, or as a launchd service when
there is no app. It is safe to run again. Then:

- In any Claude Code session that was already open, type `/hooks` once. Sessions opened after setup pick conch up on
  their own.
- Allow the microphone when macOS asks.
- Finish a turn. conch reads it aloud, plays a tink and opens the mic. If it stays quiet, run `conch doctor`.

> **The release trails `main`.** Homebrew installs the latest release, v0.3.0 at the time of writing. Much of what is
> described here landed after it, including agent marks, version compare, approvals, the Mac setup window, accounts,
> and natural voices that set themselves up. To run `main` today, [build from source](#build-from-source).

## What it does

**Every session in one place.** The sidebar lists every Claude Code and Codex session on your Mac, grouped by folder,
including the ones you started yourself in a terminal. Each row says what that session needs from you (an answer, a
permission, work to look at) or what it is doing right now, with its subagents underneath. Start a new session or
resume an old one from the app, choose its model, effort and account, and restart or close it from there. Several
Claude and OpenAI accounts can sit side by side, with their usage.

**Each agent shows you its work.** When a session has something for you to look at, it publishes it through the conch
plugin, and it opens in the review pane beside the conversation: a live page or dev server, a local page, a picture, a
video, a PDF, Markdown, a folder as its file tree, or a Figma design. Ready for you, in the app and in a small bar under
the menu bar, steps through what is waiting.

- **Marks.** The agent can mark the one thing to check (an arrow, a box, a highlight, a note) on the page, the picture
  or your screen. You see the marks on the Mac and on your phone.
- **Versions and compare.** Publishing the same thing again files a new version. Compare two with a before/after
  slider, side by side, or a text diff.
- **Approve.** When an agent is waiting on your yes ("Open the PR"), a ✓ in the session bar gives it.

**Each agent talks it through.** When a session finishes a turn, conch reads the reply aloud in that session's own
voice, then opens the mic. Answer out loud and your words go back to that session; say "hey acme-web, …" to reach a
different one. The mic never opens while conch is speaking, so it never hears itself, and you don't need headphones.
Permission prompts and an agent's questions can be answered the same way. Voice commands, manual mode, and how conch
keeps quiet while you're typing, away or in a meeting: [docs/voice.md](docs/voice.md).

**Draw on your screen.** Press ⌃⌥⌘P and draw over anything on your screen, then send the picture to the session whose
work you're looking at. Or record a Show: up to two minutes of your screen with your drawing and your voice, sent to the
session as a storyboard. (Show needs macOS 15.)

**Help with conch.** Stuck, or not sure how something works? The New session sheet's **Help with conch** (or
`conch help-session`) opens a Claude Code session that knows where conch keeps its settings, errors and logs on your
Mac, and why the loop usually goes quiet.

A more playful view of your sessions, the lagoon, is in the works.

## Claude Code and Codex

|  | Claude Code | Codex |
|---|---|---|
| In the session list, with live activity and subagents | Yes | Yes |
| Finished turns read aloud; reply by voice | Yes | Yes |
| Publishes work to the review pane, with marks | Yes, through the conch plugin | Yes, through the conch plugin |
| Start, resume, restart; model and effort per session | Yes | Yes |
| Accounts and usage | Claude accounts | OpenAI / ChatGPT accounts |
| How your words reach it | Typed into its tmux pane or Terminal window | The same, or through the Codex app for a task open there |
| Permission prompts | Answered by voice, in the app, or on the phone | Announced and shown as needing you; you answer in Codex |
| Multiple-choice questions | Answered with its picker's own keys | Your answer goes in as a message |
| Rename | conch's label, and `/rename` in the session | conch's label only |

`conch setup` wires Claude Code's hooks and installs the plugin for both. Codex needs no hooks: conch reads Codex's
own session files, read-only, every few seconds. `conch install --codex` adds conch's Codex hooks as well; Codex asks
you to trust them the next time it starts. Accounts are added in Settings → Providers
([Claude](docs/claude-accounts.md), [Codex](docs/codex-accounts.md)). `conch uninstall --codex` or `--claude` removes
one agent's wiring and leaves the other.

## iPhone

The iPhone app is the same list in your pocket: each session saying what it wants, its conversation, what is ready for
you to look at (with the agent's marks, and compare), and a Talk button. Replies are read aloud on the phone, through
your AirPods, and the mic opens when the reading stops, so a whole turn costs one tap. From the phone you can also
answer permission prompts and questions, start or resume a session, send a session a photo or a video, and reach most
of the Mac app's session controls. Drawing on the screen, the shell and the floating panels stay on the Mac.

**Getting it.** The iPhone app isn't on the App Store or a public TestFlight yet. To run it today, open
`mobile/conch-ios/conch-ios.xcodeproj` in Xcode, choose your own team and bundle identifier, and run it on your phone.
Development installs from a free Apple account stop launching after seven days. Build notes are in
[mobile/README.md](mobile/README.md).

**Connecting it.** The phone connects to your Mac, never to a conch service. Phone access is off until you pair: open
Settings → Phone app in the Mac app, or run `conch pair`.

- **On the same Wi-Fi**, type the Mac's address and a six-digit code, which works once, for two minutes. This bridge is
  plain HTTP, so use it only on a network you trust.
- **From anywhere** (cellular, another country, no VPN or open port), deploy the small relay in [relay/](relay/README.md)
  to your own Cloudflare account, run `conch set phone-relay-url <its URL>`, and scan the QR. The Mac and the phone
  both dial out to it, and everything between them is encrypted end to end. Once a relay is set, the Wi-Fi bridge
  stays closed unless you turn it on (`conch set phone-lan on`).

## Privacy

conch is local-first. It has no server and no account of its own.

- **Your sessions run on your Mac.** conch watches the Claude Code and Codex sessions on this Mac and types into them;
  it runs no agents of its own. The agents talk to Anthropic and OpenAI as they always do, and anything you send a
  session through conch (your words, a picture of your screen, a Show) reaches that agent the same way typing would.
- **Speech stays on the Mac.** What you say is transcribed on the Mac by whisper.cpp, and replies are spoken by Kokoro
  on the Mac's GPU, or by macOS `say`. No audio goes to a speech service.
- **The phone talks only to your Mac.** It recognizes your speech with iOS's own recognizer, on the device wherever
  the phone supports that (otherwise iOS may use Apple's servers), and reads replies aloud with iOS's own voice. Your
  words reach the Mac as text.
- **The relay can't read what it carries.** Session state, conversations, your messages, files, photos and videos are
  encrypted end to end (AES-256-GCM, with keys derived from a secret in the pairing QR that never reaches
  Cloudflare). The relay stores nothing. It can see the room ID, IP addresses, when the devices connect, and how much
  passes between them. The Wi-Fi bridge is not encrypted: anyone on that network can read its traffic and reuse its
  token.
- **What else leaves the Mac.** The one-time downloads (the whisper and Kokoro models from Hugging Face, and the voice
  environment's Python and packages), a once-a-day check of GitHub for a newer release (not when running from source),
  and, only if you turn them on, `announce-summary` and `voice-qa`, which send a reply's text through your own `claude`
  CLI. There is no analytics; conch's own measurements stay in a local file.
- **What stays on disk.** Settings, published results and logs live in `~/.config/conch`, `~/.cache/conch` and
  `/tmp`. The screen log, which records which session's work was on screen and for how long, never leaves the Mac;
  turn it off with `conch set screen-log false`.
- **Permissions.** Each is one grant to conch.app. Microphone: your spoken replies. Accessibility: which app and page
  you're on, and typing your replies into Terminal. Automation: finding a session's Terminal window and pressing keys
  there. Screen Recording: the picture you draw on, a Show, and window snapshots for your phone.

## Reference

### Commands

| Command | What it does |
|---|---|
| `conch setup [--service \| --no-service] [--no-plugin]` | Set everything up; safe to re-run |
| `conch doctor` | Check the speech engine, the microphone, voices and agents, and say what to fix |
| `conch` | Open the terminal dashboard (see below) |
| `conch sessions` / `conch resumable [query]` | List live sessions / past sessions you can resume |
| `conch start [claude \| codex] [options]` | Open a new session in Terminal (`conch start --help`) |
| `conch wake [name]` / `conch recite [name]` | Open the mic for a session / read its latest reply aloud |
| `conch pause` / `conch resume` | Manual (hold finished turns quietly) / auto |
| `conch rename <session> <name>` | Give a session a name in conch |
| `conch model <session> <model>` | Switch a live session's model |
| `conch voices [setup]` / `conch voice <session> [voice]` | Audition the voices, or set them up now / show or pin a session's voice |
| `conch settings` / `get <key>` / `set <key> <value>` / `unset <key>` | List, read, change or reset a setting ([docs/configuration.md](docs/configuration.md)) |
| `conch pair` | Connect the iPhone app |
| `conch install --codex` | Wire conch's Codex hooks |
| `conch install-plugin` / `uninstall-plugin` | Install or remove the conch plugin for Claude Code and Codex |
| `conch service [install \| off]` | Install or remove the launchd service |
| `conch help-session` | Open a Claude Code session that knows conch |
| `conch listen` / `conch speak <text>` | Test the microphone / test speech |
| `conch uninstall [--models] [--claude \| --codex]` | Remove conch's wiring; `--models` also removes the downloaded models and voices |
| `conch version` | Print the version |

### Terminal dashboard

Without the Mac app, `conch` attaches to the terminal dashboard that the launchd service keeps running, and
`conch daemon` runs the loop in the foreground with the same dashboard. It is also the way in over ssh. The session
list is on the left and a pane that reads along with the active session is on the right; press `?` for its keys. With
the Mac app installed, the app hosts the daemon and is the dashboard.

### Settings

`conch settings` lists every setting with its value and where that value came from; `conch set` changes one and
applies it live where it can. Every setting, its default, and the environment variables that have no setting are in
[docs/configuration.md](docs/configuration.md).

### Build from source

```bash
git clone https://github.com/stupart/conch.git && cd conch
bun install
bun link                    # puts `conch` on your PATH, running from source
scripts/build-app.sh        # builds and installs conch.app
conch setup                 # sees the app and leaves the daemon to it
```

You need [Bun](https://bun.sh) and Xcode (not just the Command Line Tools). Running from source means edits take
effect immediately; the Homebrew binary is a frozen `bun build --compile` build.

**The app is not optional.** macOS attributes the daemon's microphone use to the app that started it, and conch.app is
what carries the microphone entitlement. Without it, the recorder opens the device and receives silence.

`scripts/build-app.sh` signs with a **Developer ID Application** certificate for the project's team, `5DRS8F56M2`, and
refuses to build without one (`security find-identity -v -p codesigning` lists yours). To sign as yourself, change the
team in the script and the Xcode project. On a second Mac of the same team, create a new certificate there rather than
exporting the key from the first: the app's designated requirement pins the team, not the certificate, so macOS keeps
the microphone grant.

Keep one install per Mac. A Homebrew `conch` and a linked checkout both on `$PATH` is how the app and the daemon end up
on different versions; `conch doctor` names both when that happens.

**The gate.** There is no hosted CI, so every check runs on your Mac:

```bash
scripts/ci-local.sh          # bun install --frozen-lockfile, bun test, tsc --noEmit, swift test (design/ConchDesign)
scripts/ci-local.sh all      # + the Mac and iOS app builds, and how far HEAD is past the last release
scripts/install-hooks.sh     # once per clone: pre-push runs the fast set
```

It keeps each check's log in `build/ci-local/` and exits non-zero if anything failed. Any subset works:
`scripts/ci-local.sh tsc swift`.

### The plugin from this repo's catalog

`conch setup` installs the conch plugin locally (`conch@conch`). To install it yourself from this repo instead:

```
/plugin marketplace add stupart/conch
/plugin install conch@conch-plugins
```

The plugin still needs the conch CLI. If `conch setup` already installed `conch@conch`, keep that and don't add the
catalog copy too, or the conch tools are registered twice. The same goes for an older `conch@blueprint-studio-marketplace`:
install the new one, check it works, then `/plugin uninstall conch@blueprint-studio-marketplace`.

### More

- [docs/voice.md](docs/voice.md): the voice loop, voice commands, permission prompts by voice, natural voices
- [docs/configuration.md](docs/configuration.md): every setting and environment variable
- [docs/architecture.md](docs/architecture.md): how the daemon, the apps and the agents fit together
- [docs/install-journeys.md](docs/install-journeys.md): each install path, step by step, and where it can go quiet
- [docs/screen-context.md](docs/screen-context.md): how conch knows whose work is on your screen
- [relay/README.md](relay/README.md): the relay's threat model, and deploying your own

## Credits

Built on [seashell](https://github.com/stupart/seashell)'s local-first speech-to-text engine. conch.app carries
whisper.cpp, sox, tmux, uv and the silero VAD model, with their licences.

conch is a small open experiment from [Blueprint Studio](https://blueprintstudio.ai). We build AI products that feel
good to use.

## License, name and artwork

The code is MIT licensed ([LICENSE](LICENSE)). The conch name and logo, the app icons and agent marks (the artwork in
the apps' `Assets.xcassets`), the crab characters and other artwork, and the films are not covered by that license:
please don't use them for forks or for products built from this code.
