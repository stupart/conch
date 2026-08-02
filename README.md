# 🐚 conch

A voice loop for Claude Code. Your sessions announce themselves out loud when they finish — then you just talk back.

![The conch dashboard — a live session ledger down the left (sorted so whatever needs you floats to the top, each row a colored status dot), and a pane on the right that reads along with the session conch is talking to: here, your spoken reply building word by word as it records.](docs/dashboard.png)

```
Claude finishes a turn
  └─> 🔔 ding + "dayloop: Done — the Stats tab renders and all 14 tests pass."
        └─> 🎙️ mic opens (only after speaking — the loop can't hear itself)
              └─> you: "great, now do the same for the horizontal layout"
                    └─> transcript lands in that session's prompt and submits
```

Speech-to-text runs entirely on your Mac via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal. No cloud, no API keys — `conch setup` installs the engine and downloads the models for you.

## How routing works

You don't pick a session — **the mic follows the voice**. When a session finishes a turn, it announces itself by name ("dayloop: ..."), and whatever you say next goes back to *that* session. The announcement is the address. If several sessions finish while you're mid-conversation with one, the newest announcement wins the mic next; the rest you'll have heard by name and can reach by typing (or wait — addressing a session by name is on the roadmap).

Because the loop is turn-based — speak, *then* listen, never both — the mic never picks up the Mac's own voice, so no feedback loop and no headphones required.

Prompts are injected via `tmux send-keys` targeted at the exact pane running that session, so it works even when the pane isn't focused. Not a tmux user? With `CONCH_KEYSTROKE_FALLBACK=1`, conch finds the Terminal window hosting the session (matched by tty), focuses it, and types there. If the window can't be found, your words go to the **clipboard** instead of being typed into the void — you'll hear "just paste."

## The macOS app

The native macOS app is conch's primary UI. It shows the live session ledger and conversation while conch speaks and listens, and renders a finished deliverable inline when a session publishes one for review.

The app is currently built from source. Open `mac-app/conch-mac.xcodeproj` in Xcode, select the `conch-mac` scheme, and press Run. Keep using the terminal dashboard (`conch`) as the SSH/remote fallback.

## Install

macOS. Two commands:

```bash
brew install stupart/tap/conch     # binary + sox/tmux/whisper-cpp
conch setup                        # models, hooks, service, and app plugins
```

`brew install` pulls the system dependencies (`sox`, `tmux`, `whisper-cpp`) automatically. `conch setup` then downloads the two speech models into `~/.cache/conch/models` (whisper large-v3-turbo ~1.6 GB, silero VAD ~900 KB), wires the Claude Code hooks, verifies the chain, starts the launchd service, and installs the conch plugin for whichever of Claude Code and Codex are present. It's idempotent — re-run it any time; it skips or safely refreshes managed pieces. Already have a whisper.cpp build and models (e.g. a [seashell](https://github.com/stupart/seashell) checkout)? Point `CONCH_WHISPER_CLI` / `CONCH_WHISPER_MODEL` / `CONCH_VAD_MODEL` (or `CONCH_SEASHELL_ROOT`) at them and setup leaves them untouched.

<details>
<summary><b>From source</b> (for hacking on conch)</summary>

```bash
git clone https://github.com/stupart/conch.git && cd conch
bun install
bun link           # puts `conch` on your PATH, running from source
conch setup        # installs/configures everything and starts the service
```

Requires [Bun](https://bun.sh). Running from source means edits take effect immediately; the brew binary is a frozen `bun build --compile` build.
</details>

Setup leaves conch running as a background service that launches at login and self-heals within ~15s of a crash. In any Claude Code session that was already open during setup, type `/hooks` once to reload its configuration; sessions opened afterward pick conch up automatically. Finish a turn and conch will speak it, play a tink, and open the mic. Allow macOS microphone access when prompted; if the prompt was missed or the loop stays quiet, run `conch doctor`.

Want manual granularity? The two integrations can be skipped independently, and their standalone commands remain idempotent:

```bash
conch setup --no-service --no-plugin
conch service install     # install/refresh the launchd service later
conch install-plugin      # install for whichever supported apps are present
```

Prefer to run the loop in the foreground? Use `--no-service`, then start it in any pane — you get the full dashboard (session panel + status line):

```bash
conch daemon
```

No daemon running at all? The hooks still work standalone: bell + spoken announcements, no voice-back. That's a perfectly good way to use conch.

### Natural voices (optional, recommended)

Without MLX installed, conch speaks through macOS `say`. Install [mlx-audio](https://github.com/Blaizzy/mlx-audio) and the daemon upgrades itself to [Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16) — dramatically more natural, running warm and local on Apple GPU (~340MB model, auto-downloaded on first use):

```bash
brew install uv
uv tool install --with "misaki[en]" \
  --with "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \
  "mlx-audio[server]"
```

That's it — the daemon uses the `mlx_audio.server` launcher only to locate its isolated Python, then starts a Conch-owned worker with no HTTP listener. The worker loads Kokoro once, warms the MLX/G2P path, and accepts private JSON lines over stdin/stdout. A request timeout or crash hard-kills that exact child and starts a fresh one; while it is loading or restarting, speech immediately degrades to `say`.

**Every session gets its own voice**: labels are hashed onto a ring of 8 Kokoro voices, so dayloop always sounds like dayloop and you can tell sessions apart by ear. Audition the ring with `conch voices` (or press `v` in the dashboard to hear each LIVE session in its assigned voice), pin any session with `conch voice dayloop bm_george` (persisted), or customize the ring with `CONCH_TTS_VOICES` (any of Kokoro's 50+ voices). Force `CONCH_TTS=say` to opt out, or set `CONCH_TTS=server` to temporarily restore the legacy HTTP backend.

The worker itself adds no package beyond the installed `mlx-audio`, NumPy, `misaki[en]`, and English spaCy model. The `[server]` extra above is kept only for the one-variable rollback path.

## Commands

| Command | What it does |
|---|---|
| `conch setup [--no-service] [--no-plugin]` | Run once: deps, models, hooks, doctor, service, and available-app plugins |
| `conch uninstall [--models]` | Remove managed hooks, instructions, service, tmux session, and plugin; also remove downloaded models only with `--models` |
| `conch version` / `--version` | Print the installed package version |
| `conch service [install\|off]` | Optionally install/refresh or remove launchd supervision |
| `conch install-plugin` / `uninstall-plugin` | Optionally manage the Claude Code and Codex plugin separately |
| `conch install [--codex]` | Optionally wire Claude Code or Codex hooks separately |
| `conch daemon` | Run the voice loop: announce → listen → inject |
| `conch wake [name]` | Reopen the mic — last announced session, or by name (bind it to a hotkey) |
| `conch recite [name]` | Read the latest response aloud — last announced session, or by name |
| `conch rename <session> <label>` | Save a conch display label and migrate its pinned voice |
| `conch sessions` | List live Claude Code sessions |
| `conch mute` / `unmute` | Silence announcements + mic |
| `conch pause` / `resume` | Step away: stay quiet but HOLD finished sessions, replay on resume |
| `conch hook` | Hook entrypoint (Claude Code calls this, not you) |
| `conch listen` | Mic check: capture one utterance, print the transcript |
| `conch speak <text>` | TTS check |
| `conch voices` | Audition the voice ring — each voice introduces itself |
| `conch voice <s> [v]` | Show or pin a session's voice (persisted) |
| `conch set <key> <value>` | Save a curated setting and apply it live when possible |
| `conch get <key>` | Show one effective setting and its source |
| `conch unset <key>` | Remove a saved value and revert to env/default |
| `conch settings` | List all curated settings, effective values, and sources |
| `conch doctor` | Verify dependencies, live microphone input, and the configured TTS path |

## Voice commands

While the mic is open (you'll hear a *tink*), a bare command word talks to conch instead of the session:

| You say | What happens |
|---|---|
| "stop" / "got it" / "enough" *(while it's reading)* | stops reading, opens the mic for your reply |
| "no response" / "no response needed" / "cancel" | closes the mic, moves to the next queued session |
| "continue" / "keep going" / "read the rest" | reads more, then listens again |
| "repeat" / "say that again" | re-speaks the last thing conch said |
| "conch, did the tests pass?" | with `voice-qa` enabled, answers from that session's last reply without sending a prompt |
| anything else | goes to the session as your prompt |

By default conch reads the **whole** final message aloud (`CONCH_READ_FULL=0` for headline-only), pausing briefly between chunks — those pauses are your window to interject: "stop" to cut it short, "no response" to close out, or just start dictating your reply and the rest is skipped.

Commands only match as the *entire* utterance — "continue working on the login bug" is a prompt, not a command. Filler wrapping is fine ("Oh, continue." works). A soft *bottle* sound means the window closed on silence.

**Came back after the window closed?** Press **space** in the daemon's terminal, or run `conch wake` (bind it to a global hotkey via Raycast/Shortcuts) — the mic reopens for the last announced session. `conch wake dayloop` targets any live session by name (`conch sessions` lists them), and the status line shows exactly who's listening.

**Leaving?** `conch mute` silences announcements and the mic until `conch unmute`; in the dashboard, **m** does the same globally whenever no session is parked. Mute forgets what finishes, so there is no reminder loop, and a closed window costs nothing (no sox, no whisper). `CONCH_AWAY_AFTER_SECS` adds opt-in auto-silence after N seconds of keyboard/mouse idle, but note it's off by default for a reason: idle time doesn't count *voice* activity, so it would mute a fully hands-free session mid-conversation.

**Stepping away for a bit?** `conch pause` (or **p** with no session parked) is mute's patient sibling: it stays quiet *and* **holds** every session that finishes while you're gone, then replays them on `conch resume` or the next **p**. Joining meetings often? `conch set meeting-autopause true` enables a default-off CoreAudio watcher that silently pauses when another app takes the default microphone, then restores your prior pause state when it releases.

With the default-off `resume-digest` setting enabled, two or more held sessions are composed into one short Haiku briefing, followed by one "Who first?" listen. If Haiku is unavailable, conch uses a deterministic label briefing; a failed listen or session match falls back to the normal full replay, so held work is never discarded.

The three default-off fast-model features (`announce-summary`, `voice-qa`, and `resume-digest`) shell out to your installed, authenticated `claude` CLI; conch adds no model SDK or runtime package.

**Want to focus on one thing?** Use **↑↓** to park the cursor on a session. Its latest output follows into the pane and stays there; **esc** releases the cursor back to automatic follow. Press **r** to read that output aloud, or **Enter** for its actions menu: preview/pin a voice, prioritize its next hand-off, rename it, or safely dismiss it from conch while leaving the Claude process running. Recite is immediate and read-only: it cuts any active read or mic, reads the latest reply from the top, then returns to rest. While it is parked, **p** pauses or resumes just that session, holding only its latest turn and replaying that turn from the top on resume; **m** mutes or unmutes just that session, forgetting what finishes with no replay. With no parked cursor, **p** and **m** are global. These controls take effect instantly: an active read stops, the mic closes, and its in-flight capture is dropped.

**Permission prompts** ("dayloop needs you: permission to run npm install") open the mic too, but only accept yes/no: "yes" presses Enter on the highlighted option, "no" presses Escape, anything else is ignored — free text near a permission dialog is deliberately refused. And idle "waiting for your input" nags are filtered: conch checks whether the session's last reply actually asked you something, and stays quiet when the session is just idle ("I'll ping you when it lands").

## The dashboard

Run the daemon in a visible terminal (`conch daemon`), or just type **`conch`** to attach to the one `conch service` keeps running in the background — either way you get the dashboard from the screenshot above: a **live session ledger** on the left, a **read-along pane** on the right, so you can see who needs you at a glance without conch ever nagging you aloud:

```
  🐚 conch
  ─────────────────────────────────────────────────────────────────
   boatker      ❗ │ yeah let's make theater the default and
   honeyb       ❗ │ auto-open the dashboard at login so i never
   dayloop      ○ │ have to think about it▌
   tokenworks   ○ │
 ▎ arch site    ● │
   conch        ● │
   poaster      ⏸ │ pause to send · space to stop · say send to submit now
   ↑↓ park · esc back · wheel scroll · drag copy · \ pane · , settings · ⏎ actions · r recite · space talk · p pause · m mute · ? help · q quit
```

Sessions that need input sort to the top. Each row carries a **colored status dot** — `❗ needs a response`, `○ waiting for you`, `● working…`, `● recording`, `⏸ paused`, `🔇 muted` — and the **session conch is currently talking to** takes a cyan accent bar and lights up in place as it moves through the turn (`▶ speaking` → `● mic open` → `● recording` → `… transcribing`). The **pane on the right reads along**: your words build there as you speak them while it records, and when conch reads a reply back the pane scrolls through it, dimming what's already been spoken.

You don't have to touch it — but you can. **↑↓** park a cursor on a session and make the pane follow its latest output until **esc** releases it; **Enter** opens that parked session's trapped actions menu; **r** recites the parked output (or the active/last session when no cursor is parked); **space** talks to the parked session (or the active one); **p** toggles pause and **m** toggles mute, targeting the parked session while the cursor is parked and the whole app otherwise. The mouse wheel scrolls long pane output, and dragging in the pane selects and copies text through both the macOS clipboard and OSC 52 (including tmux passthrough). **\\** hides the pane for a full-width ledger; **,** opens live settings; **l** toggles a log in the pane; **?** shows the full key + voice-command help; **q** quits. Set `CONCH_NO_MOUSE=1` to keep the dashboard but restore terminal-native mouse selection. The play-by-play is always written to `/tmp/conch-daemon.log` whether or not the log is on screen, so the dashboard stays clean by default.

An ordinary exit restores mouse tracking automatically. If the daemon is killed with untrappable `SIGKILL` and the shell starts printing mouse reports, recover with `printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'`.

**Windows follow the voice too.** When conch starts talking to a session, that session's Terminal window rises to the front *without stealing your keyboard focus* — you keep typing wherever you are, and the session you're hearing is already there when you look up. (`CONCH_REVEAL_ON_TURN=0` to disable.)

The daemon also spawns a **warm whisper-server** (model stays loaded), which makes every transcription seconds faster and is what powers the live partials — the growing recording is re-transcribed about once a second while you speak. No server binary? Everything still works via the slower cold path, minus partials. `CONCH_WHISPER_PORT=0` disables the server.

State is also written to `/tmp/conch-state.json` (`{state, label, partial, ts}`) for menu-bar apps or status bars to consume.

## Config

Curated settings can be changed without editing shell profiles:

```bash
conch settings
conch get end-silence
conch set end-silence 2.75
conch unset end-silence       # revert to env/default
```

Values are saved in `~/.config/conch/settings.json`; writes are atomic for readers and intended for one `conch` CLI writer at a time. Environment variables take precedence over saved values. `set` reports whether a value applied live, is masked by an environment variable, waits for the next hook, or was saved for the next daemon start. `get` and `settings` ask the daemon for live truth and fall back to local resolution when it is down.

The full environment-variable surface remains available (put overrides in the hook's env or your shell profile):

| Variable | Default | |
|---|---|---|
| `CONCH_VOICE` | system default | `say` voice — try `Ava (Premium)` |
| `CONCH_SAY_RATE` | `210` | macOS `say` rate in words per minute; `0` preserves the system default (~175) |
| `CONCH_SPEAK_SENTENCES` | `2` | how much of the reply to read aloud |
| `CONCH_SPEAK_MAX_CHARS` | `350` | hard cap on spoken length |
| `CONCH_ANNOUNCE_SUMMARY` | `0` | summarize long hook announcements with Haiku; falls back to the literal snippet |
| `CONCH_VOICE_QA` | `0` | answer "conch, …" from the active session's last reply without injecting it |
| `CONCH_RESUME_DIGEST` | `0` | brief two or more held sessions once, then ask who should go first |
| `CONCH_BELL` / `CONCH_SPEAK` | `1` | disable the ding / the voice |
| `CONCH_BELL_SOUND` | Glass.aiff | any afplay-able file |
| `CONCH_LISTEN_WINDOW_SECS` | `30` | how long the mic waits for you to *start* talking |
| `CONCH_MAX_UTTERANCE_SECS` | `120` | cap on a single utterance once you're talking |
| `CONCH_END_SILENCE_SECS` | `3.5` | pause length that ends your utterance (drop it for snappier turns) |
| `CONCH_MIC_GAIN_DB` | `0` (off) | software mic gain in dB (`-20` to `30`; `conch set mic-gain …`); boosts conch capture without changing macOS input volume |
| `CONCH_CONTINUE_SENTENCES` | `6` | sentences per read-aloud / "continue" chunk |
| `CONCH_GAP_SECS` | `0` (none) | interjection gap between read-aloud chunks |
| `CONCH_BARGE_THRESHOLD_PCT` | `0` (off) | mic level that interrupts reading mid-chunk; after upgrading an existing supervised install, run `conch service install` once to shed the old forced env and restart |
| `CONCH_MIC_CUES` | `1` | tink on mic-open, bottle on silent close |
| `CONCH_AUTO_SUBMIT` | `1` | press Enter after injecting |
| `CONCH_HOLD_SUBMIT` | `1` | hold Enter; pauses segment dictation, "send"/"go" or a long pause submits |
| `CONCH_HOLD_SUBMIT_SECS` | `8` | silence before held dictation auto-submits |
| `CONCH_KEYSTROKE_FALLBACK` | `0` | allow typing into the frontmost window when no tmux pane is found |
| `CONCH_TYPING_GRACE_SECS` | `2` | if you touched the keyboard/mouse this recently, a finished turn stays visual (bell + panel) and the mic won't open — so typing can't trigger phantom words; `0` disables |
| `CONCH_REVEAL_ON_TURN` | `1` | raise a session's window (without stealing focus) when conch starts talking to it |
| `CONCH_NO_MOUSE` | `0` | set to `1` to disable dashboard mouse capture and use native terminal selection |
| `CONCH_SAY_VOLUME` | `0.4` | `say` fallback loudness — tuned to match Kokoro (raw `say` is ~3× louder) |
| `CONCH_SEASHELL_ROOT` | `~/whisper-cli` | first place probed for the whisper.cpp build + models; falls back to a brew `whisper-cpp` install and `~/.cache/conch/models` |
| `CONCH_WHISPER_PORT` | `8642` | warm whisper-server port; `0` = cold cli only |
| `CONCH_AWAY_AFTER_SECS` | `0` (off) | opt-in: silence everything after N seconds of keyboard idle |
| `CONCH_MEETING_AUTOPAUSE` | `0` (off) | silently pause while another app is using the default microphone |
| `CONCH_TTS` | `worker` | `worker` (owned, no HTTP) / `server` (legacy rollback) / `say`; old `auto` aliases to `worker` |
| `CONCH_TTS_PORT` | `8880` | legacy `server` mode only; `0` disables that backend |
| `CONCH_TTS_SERVER` | `mlx_audio.server` | legacy server binary and launcher whose shebang locates the uv-tool Python |
| `CONCH_TTS_WORKER_PYTHON` | derived | optional worker interpreter override; normally read from `mlx_audio.server` |
| `CONCH_TTS_VOICES` | 8-voice ring | comma-separated Kokoro voices; sessions hash onto the ring |
| `CONCH_TTS_SPEED` | `1.35` | Kokoro/voice synthesis speed (`conch set voice-speed …`) |
| `CONCH_TTS_BATCH_CHARS` | `240` | coalesce later short sentences up to this size; `0` disables (sentence one always stays separate) |

## Roadmap

- **Name-addressing** — "hey dayloop, ..." routes to any session, not just the last announcer
- **Phone remote** — hear from and talk back to your sessions over a websocket when you're away from the machine
- **Always-listening mode** — seashell's concurrent VAD architecture, once extracted from its TUI, replaces the per-window sox capture
- **Linux** — swap `say`/`afplay` for espeak/paplay, keystroke fallback for xdotool

## Credits

Built on [seashell](https://github.com/stupart/seashell)'s local-first STT engine.

conch is a small open experiment from [Blueprint Studio](https://blueprintstudio.ai) — we build AI products that feel good to use. MIT.
