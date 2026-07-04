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

Prompts are injected via `tmux send-keys` targeted at the exact pane running that session, so it works even when the pane isn't focused. Not a tmux user? Enable `CONCH_KEYSTROKE_FALLBACK=1` to type into the frontmost window instead (keep the session focused), or run without injection and treat conch as announce-only.

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

## Commands

| Command | What it does |
|---|---|
| `conch install` | Merge hooks into `~/.claude/settings.json` (backs up first) |
| `conch daemon` | Run the voice loop: announce → listen → inject |
| `conch hook` | Hook entrypoint (Claude Code calls this, not you) |
| `conch listen` | Mic check: capture one utterance, print the transcript |
| `conch speak <text>` | TTS check |
| `conch doctor` | Verify external dependencies |

## Config

All via environment variables (put them in the hook's env or your shell profile):

| Variable | Default | |
|---|---|---|
| `CONCH_VOICE` | system default | `say` voice — try `Ava (Premium)` |
| `CONCH_SPEAK_SENTENCES` | `2` | how much of the reply to read aloud |
| `CONCH_SPEAK_MAX_CHARS` | `350` | hard cap on spoken length |
| `CONCH_BELL` / `CONCH_SPEAK` | `1` | disable the ding / the voice |
| `CONCH_BELL_SOUND` | Glass.aiff | any afplay-able file |
| `CONCH_LISTEN_WINDOW_SECS` | `30` | max time the mic stays open |
| `CONCH_END_SILENCE_SECS` | `1.5` | pause length that ends your utterance |
| `CONCH_AUTO_SUBMIT` | `1` | press Enter after injecting |
| `CONCH_KEYSTROKE_FALLBACK` | `0` | allow typing into the frontmost window when no tmux pane is found |
| `CONCH_SEASHELL_ROOT` | `~/whisper-cli` | where the whisper.cpp build + models live |

## Roadmap

- **Name-addressing** — "hey dayloop, ..." routes to any session, not just the last announcer
- **Haiku summaries** — pipe replies through `claude -p --model haiku` for a natural spoken one-liner instead of first-two-sentences
- **Always-listening mode** — seashell's concurrent VAD architecture, once extracted from its TUI, replaces the per-window sox capture
- **Pluggable TTS** — local neural voices (Kokoro et al.) behind the `speak` interface
- **Linux** — swap `say`/`afplay` for espeak/paplay, keystroke fallback for xdotool

## Credits

Built on [seashell](https://github.com/stupart/seashell)'s local-first STT engine. MIT.
