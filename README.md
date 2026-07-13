# 🐚 conch

A voice loop for Claude Code. Your sessions announce themselves out loud when they finish — then you just talk back.

```
Claude finishes a turn
  └─> 🔔 ding + "dayloop: Done — the Stats tab renders and all 14 tests pass."
        └─> 🎙️ mic opens (only after speaking — the loop can't hear itself)
              └─> you: "great, now do the same for the horizontal layout"
                    └─> transcript lands in that session's prompt and submits
```

Speech-to-text runs entirely on your Mac via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal, using [seashell](https://github.com/stupart/seashell)'s engine. No cloud, no API keys.

## How routing works

You don't pick a session — **the mic follows the voice**. When a session finishes a turn, it announces itself by name ("dayloop: ..."), and whatever you say next goes back to *that* session. The announcement is the address. If several sessions finish while you're mid-conversation with one, the newest announcement wins the mic next; the rest you'll have heard by name and can reach by typing (or wait — addressing a session by name is on the roadmap).

Because the loop is turn-based — speak, *then* listen, never both — the mic never picks up the Mac's own voice, so no feedback loop and no headphones required.

Prompts are injected via `tmux send-keys` targeted at the exact pane running that session, so it works even when the pane isn't focused. Not a tmux user? With `CONCH_KEYSTROKE_FALLBACK=1`, conch finds the Terminal window hosting the session (matched by tty), focuses it, and types there. If the window can't be found, your words go to the **clipboard** instead of being typed into the void — you'll hear "just paste."

## Install

Requirements: macOS, [Bun](https://bun.sh), sox (`brew install sox`), and a [seashell](https://github.com/stupart/seashell) install for the whisper.cpp build + models (or point `CONCH_WHISPER_CLI` / `CONCH_WHISPER_MODEL` / `CONCH_VAD_MODEL` at your own).

```bash
git clone https://github.com/stupart/conch.git && cd conch
bun install
bun run src/cli.ts doctor     # verify say / sox / whisper are reachable
bun run src/cli.ts install    # wire Stop + Notification hooks into ~/.claude/settings.json
```

Then run the loop in any pane:

```bash
bun run src/cli.ts daemon
```

No daemon running? The hooks still work standalone: bell + spoken announcements, no voice-back. That's a perfectly good way to use conch.

### Natural voices (optional, recommended)

By default conch speaks through macOS `say`. Install [mlx-audio](https://github.com/Blaizzy/mlx-audio) and the daemon upgrades itself to [Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16) — dramatically more natural, running warm and local on Apple GPU (~340MB model, auto-downloaded on first use):

```bash
brew install uv
uv tool install --with "misaki[en]" "mlx-audio[server]"
```

That's it — the daemon finds `mlx_audio.server`, spawns it, and **every session gets its own voice**: labels are hashed onto a ring of 8 Kokoro voices, so dayloop always sounds like dayloop and you can tell sessions apart by ear. Audition the ring with `conch voices` (or press `v` in the dashboard to hear each LIVE session in its assigned voice), pin any session with `conch voice dayloop bm_george` (persisted), customize the ring with `CONCH_TTS_VOICES` (any of Kokoro's 50+ voices), or force `CONCH_TTS=say` to opt out. If the server is down, everything degrades to `say` automatically.

## Commands

| Command | What it does |
|---|---|
| `conch install` | Merge hooks into `~/.claude/settings.json` (backs up first) |
| `conch daemon` | Run the voice loop: announce → listen → inject |
| `conch wake` | Reopen the mic for the last announced session (bind it to a hotkey) |
| `conch hook` | Hook entrypoint (Claude Code calls this, not you) |
| `conch listen` | Mic check: capture one utterance, print the transcript |
| `conch speak <text>` | TTS check |
| `conch doctor` | Verify external dependencies |

## Voice commands

While the mic is open (you'll hear a *tink*), a bare command word talks to conch instead of the session:

| You say | What happens |
|---|---|
| "stop" / "got it" / "enough" *(while it's reading)* | stops reading, opens the mic for your reply |
| "no response" / "no response needed" / "cancel" | closes the mic, moves to the next queued session |
| "continue" / "keep going" / "read the rest" | reads more, then listens again |
| "repeat" / "say that again" | re-speaks the last thing conch said |
| anything else | goes to the session as your prompt |

By default conch reads the **whole** final message aloud (`CONCH_READ_FULL=0` for headline-only), pausing briefly between chunks — those pauses are your window to interject: "stop" to cut it short, "no response" to close out, or just start dictating your reply and the rest is skipped.

Commands only match as the *entire* utterance — "continue working on the login bug" is a prompt, not a command. Filler wrapping is fine ("Oh, continue." works). A soft *bottle* sound means the window closed on silence.

**Came back after the window closed?** Press **space** in the daemon's terminal, or run `conch wake` (bind it to a global hotkey via Raycast/Shortcuts) — the mic reopens for the last announced session. `conch wake dayloop` targets any live session by name (`conch sessions` lists them), and the status line shows exactly who's listening.

**Leaving?** `conch mute` silences announcements and the mic until `conch unmute`; each event only ever speaks once regardless — there is no reminder loop, and a closed window costs nothing (no sox, no whisper). `CONCH_AWAY_AFTER_SECS` adds opt-in auto-silence after N seconds of keyboard/mouse idle, but note it's off by default for a reason: idle time doesn't count *voice* activity, so it would mute a fully hands-free session mid-conversation.

**Permission prompts** ("dayloop needs you: permission to run npm install") open the mic too, but only accept yes/no: "yes" presses Enter on the highlighted option, "no" presses Escape, anything else is ignored — free text near a permission dialog is deliberately refused. And idle "waiting for your input" nags are filtered: conch checks whether the session's last reply actually asked you something, and stays quiet when the session is just idle ("I'll ping you when it lands").

## Live status & near-real-time transcription

Run the daemon in a visible terminal and it renders a live status line:

```
◌ idle          — waiting for a session to finish
▶ speaking      — announcement playing (mic closed)
● mic open      — green: armed, waiting for you to start
● recording     — red: capturing, with your words streaming in as you talk:
● recording — dayloop  ▸ okay so let's try the other approach and
… transcribing  — whisper finishing the final pass
```

The daemon also spawns a **warm whisper-server** (model stays loaded), which makes every transcription seconds faster and is what powers the live partials — the growing recording is re-transcribed about once a second while you speak. No server binary? Everything still works via the slower cold path, minus partials. `CONCH_WHISPER_PORT=0` disables the server.

State is also written to `/tmp/conch-state.json` (`{state, label, partial, ts}`) for menu-bar apps or status bars to consume.

## Config

All via environment variables (put them in the hook's env or your shell profile):

| Variable | Default | |
|---|---|---|
| `CONCH_VOICE` | system default | `say` voice — try `Ava (Premium)` |
| `CONCH_SAY_RATE` | `210` | speech rate, words per minute (`0` = say default ~175) |
| `CONCH_SPEAK_SENTENCES` | `2` | how much of the reply to read aloud |
| `CONCH_SPEAK_MAX_CHARS` | `350` | hard cap on spoken length |
| `CONCH_BELL` / `CONCH_SPEAK` | `1` | disable the ding / the voice |
| `CONCH_BELL_SOUND` | Glass.aiff | any afplay-able file |
| `CONCH_LISTEN_WINDOW_SECS` | `30` | how long the mic waits for you to *start* talking |
| `CONCH_MAX_UTTERANCE_SECS` | `120` | cap on a single utterance once you're talking |
| `CONCH_END_SILENCE_SECS` | `2.5` | pause length that ends your utterance |
| `CONCH_CONTINUE_SENTENCES` | `6` | sentences per read-aloud / "continue" chunk |
| `CONCH_GAP_SECS` | `0` (none) | interjection gap between read-aloud chunks |
| `CONCH_BARGE_THRESHOLD_PCT` | `12` | mic level that interrupts reading mid-chunk; `0` = gaps only |
| `CONCH_MIC_CUES` | `1` | tink on mic-open, bottle on silent close |
| `CONCH_AUTO_SUBMIT` | `1` | press Enter after injecting |
| `CONCH_HOLD_SUBMIT` | `1` | hold Enter; pauses segment dictation, "send"/"go" or a long pause submits |
| `CONCH_HOLD_SUBMIT_SECS` | `8` | silence before held dictation auto-submits |
| `CONCH_KEYSTROKE_FALLBACK` | `0` | allow typing into the frontmost window when no tmux pane is found |
| `CONCH_SEASHELL_ROOT` | `~/whisper-cli` | where the whisper.cpp build + models live |
| `CONCH_WHISPER_PORT` | `8642` | warm whisper-server port; `0` = cold cli only |
| `CONCH_AWAY_AFTER_SECS` | `0` (off) | opt-in: silence everything after N seconds of keyboard idle |
| `CONCH_TTS` | `auto` | voices: `auto` (Kokoro server if installed, else say) / `server` / `say` |
| `CONCH_TTS_PORT` | `8880` | warm Kokoro server port; `0` disables |
| `CONCH_TTS_VOICES` | 8-voice ring | comma-separated Kokoro voices; sessions hash onto the ring |
| `CONCH_TTS_SPEED` | `1.35` | speech rate for the Kokoro engine |
| `CONCH_TTS_BATCH_CHARS` | `240` | coalesce later short sentences up to this size; `0` disables (sentence one always stays separate) |

## Roadmap

- **Name-addressing** — "hey dayloop, ..." routes to any session, not just the last announcer
- **Haiku summaries** — pipe replies through `claude -p --model haiku` for a natural spoken one-liner instead of first-two-sentences
- **Always-listening mode** — seashell's concurrent VAD architecture, once extracted from its TUI, replaces the per-window sox capture
- **Pluggable TTS** — local neural voices (Kokoro et al.) behind the `speak` interface
- **Linux** — swap `say`/`afplay` for espeak/paplay, keystroke fallback for xdotool

## Credits

Built on [seashell](https://github.com/stupart/seashell)'s local-first STT engine. MIT.
