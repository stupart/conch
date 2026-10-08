# Configuration

conch's settings are changed with the CLI or in the Mac app's Settings, never by editing a shell profile:

```bash
conch settings                 # every setting, its effective value, and where that value came from
conch get end-silence
conch set end-silence 2.75
conch unset end-silence        # back to the default
```

Values are saved in `~/.config/conch/settings.json`. `set` says whether the value applied live, is masked by an
environment variable, waits for the next hook, or was saved for the next daemon start. `get` and `settings` ask the
running daemon and fall back to reading the file when it is down.

Every setting also has an environment variable, which wins over the saved value. A daemon started by the Mac app does
not read your shell profile, so prefer `conch set`.

## Settings

The defaults below are read from `src/settings.ts`; `conch settings` prints the same list for your install.

**Listening**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `end-silence` | `CONCH_END_SILENCE_SECS` | `3.5` | Seconds of silence that end what you are saying |
| `listen-window` | `CONCH_LISTEN_WINDOW_SECS` | `30` | Seconds the mic waits for you to start talking |
| `hold-submit-delay` | `CONCH_HOLD_SUBMIT_SECS` | `8` | Silence before held dictation is sent |
| `mic-gain` | `CONCH_MIC_GAIN_DB` | `0` | Software gain on conch's capture, -20 to 30 dB, without changing the macOS input volume |
| `barge-threshold` | `CONCH_BARGE_THRESHOLD_PCT` | `0` | Mic level that interrupts reading; `0` turns barge-in off |
| `whisper-idle-unload` | `CONCH_WHISPER_IDLE_UNLOAD_MINS` | `20` | Minutes without a transcription before the warm whisper-server (about 628 MB) is unloaded; it reloads when a mic is about to open. `0` keeps it loaded |

**Speaking**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `speak` | `CONCH_SPEAK` | `true` | Read replies aloud. `false` and conch never speaks, on the Mac or the phone; everything still shows as text. In the apps: Settings › Read replies aloud |
| `bell` | `CONCH_BELL` | `true` | The chime (Glass) before an announcement, a review or a permission question. It plays even with `speak` off |
| `mic-cues` | `CONCH_MIC_CUES` | `true` | Tink when the mic opens, Bottle when it closes without sending, Pop when your words are sent |
| `read-full` | `CONCH_READ_FULL` | `true` | Read the whole final reply aloud; `false` reads only the announcement |
| `announce-sentences` | `CONCH_SPEAK_SENTENCES` | `2` | Sentences in a turn's announcement |
| `announce-max-chars` | `CONCH_SPEAK_MAX_CHARS` | `350` | Character cap on an announcement |
| `voice-speed` | `CONCH_TTS_SPEED` | `1.35` | Natural voice speed |
| `say-rate` | `CONCH_SAY_RATE` | `210` | macOS `say` words per minute; `0` uses the system rate |
| `announce-summary` | `CONCH_ANNOUNCE_SUMMARY` | `false` | Summarize long replies in one spoken sentence, using your `claude` CLI (Haiku) |
| `voice-qa` | `CONCH_VOICE_QA` | `false` | Answer "conch, …" questions from the session's last reply without sending them, using your `claude` CLI |
| `haiku-timeout` | `CONCH_HAIKU_TIMEOUT_SECS` | `10` | How long those two may take before conch falls back |

**When conch stays quiet**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `typing-grace` | `CONCH_TYPING_GRACE_SECS` | `2` | If you touched the keyboard or mouse this recently, a finished turn stays visual and the mic stays closed; `0` turns it off |
| `away-after` | `CONCH_AWAY_AFTER_SECS` | `300` | After this many seconds away from the Mac, stay quiet; `conch wake` and the space bar still work. `0` never |
| `meeting-autopause` | `CONCH_MEETING_AUTOPAUSE` | `false` | Pause while another app is using a microphone |
| `working-mic` | `CONCH_WORKING_MIC` | `false` | Announce and open the mic even while a session's background work is still running |
| `interrupt-on-manual-reply` | `CONCH_INTERRUPT_ON_MANUAL_REPLY` | `true` | Stop reading or listening when you reply to that session by typing |
| `handoff-order` | `CONCH_HANDOFF_ORDER` | `oldest` | Which queued session is read next: `oldest`, `newest` or `urgency` |

**Sessions**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `bypass-permissions` | `CONCH_BYPASS_PERMISSIONS` | `false` | Start sessions with every permission prompt skipped (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`) |
| `keystroke-fallback` | `CONCH_KEYSTROKE_FALLBACK` | `true` | For a session outside tmux, bring its Terminal window forward and type your words there; `false` puts them on the clipboard instead |
| `reveal-on-turn` | `CONCH_REVEAL_ON_TURN` | `false` | Raise a session's Terminal window on every finished turn |
| `reveal-typing-grace` | `CONCH_REVEAL_TYPING_GRACE_SECS` | `2` | Don't raise a window if you touched the keyboard or mouse this recently |

**iPhone**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `phone` | `CONCH_PHONE` | `false` | Let the iPhone app connect at all; `conch pair` turns it on, `conch set phone false` turns every phone transport off |
| `phone-relay-url` | `CONCH_PHONE_RELAY_URL` | empty | Your deployed relay Worker ([relay/](../relay/README.md)); empty means no internet relay |
| `phone-lan` | `CONCH_PHONE_LAN` | `auto` | The plaintext Wi-Fi bridge: `auto` listens only while no relay is set, `on` always, `off` never. Pairing over Wi-Fi needs it listening |
| `phone-port` | `CONCH_PHONE_PORT` | `8674` | Port the Wi-Fi bridge listens on |

**Local records**

| Setting | Variable | Default | What it does |
|---|---|---|---|
| `screen-log` | `CONCH_SCREEN_LOG` | `true` | Keep a local log of which session's work was on screen, and for how long, in `~/.config/conch/screen`. Never sent anywhere ([screen-context.md](screen-context.md)) |
| `records` | `CONCH_RECORDS_ENABLED` | `false` | Index local agent history and record observed outcomes |

## Environment-only variables

These have no `conch set` key. They are read by the process that starts with them, so they suit a daemon you run
yourself (`conch daemon`) or the launchd service.

| Variable | Default | What it does |
|---|---|---|
| `CONCH_TTS` | `worker` | `worker`: conch's own natural-voice worker. `say`: macOS `say` only, nothing downloaded or built. `server`: the legacy HTTP backend (your own `mlx_audio.server`) |
| `CONCH_TTS_VOICES` | 8-voice ring | Comma-separated Kokoro voices that sessions are hashed onto |
| `CONCH_TTS_WORKER_PYTHON` | unset | Your own Python for the voice worker, used as it is; conch builds nothing |
| `CONCH_TTS_BATCH_CHARS` | `240` | Join later short sentences up to this size before speaking; `0` turns it off |
| `CONCH_TTS_PORT` / `CONCH_TTS_SERVER` | `8880` / `mlx_audio.server` | The legacy `server` backend only |
| `CONCH_UV` | the app's | The uv conch builds its voice environment with; the Mac app sets it to its own copy |
| `CONCH_VOICE` | system voice | The `say` voice, for example `Ava (Premium)` |
| `CONCH_SAY_VOLUME` | `0.4` | `say` loudness, matched to the natural voices |
| `CONCH_BELL_SOUND` | Glass.aiff | The chime's sound file (turn the chime itself on or off with the `bell` setting) |
| `CONCH_MAX_UTTERANCE_SECS` | `120` | Cap on one utterance |
| `CONCH_CONTINUE_SENTENCES` | `6` | Sentences per read-aloud chunk |
| `CONCH_GAP_SECS` | `0` | Extra pause between read-aloud chunks |
| `CONCH_AUTO_SUBMIT` | `1` | Press Return after typing your words into a session |
| `CONCH_HOLD_SUBMIT` | `1` | Hold Return during dictation until you say "send" or pause for `hold-submit-delay` |
| `CONCH_WHISPER_PORT` | `8642` | Port of the warm whisper-server; `0` uses the slower one-shot `whisper-cli` only |
| `CONCH_NO_MOUSE` | unset | `1` keeps the terminal dashboard from capturing the mouse |
| `CONCH_TMUX` | the app's | The tmux conch hosts sessions in |

**Speech engine paths.** conch.app carries whisper.cpp (`whisper-cli`, `whisper-server`), sox and the silero VAD model;
the whisper model is downloaded on first run into `~/.cache/conch/models`. An existing [seashell](https://github.com/stupart/seashell)
install (its checkout at `~/whisper-cli`, or its Homebrew formula) is found and its model reused. To point at something
else, set `CONCH_WHISPER_CLI`, `CONCH_WHISPER_SERVER`, `CONCH_WHISPER_MODEL`, `CONCH_VAD_MODEL`, `CONCH_SOX` or
`CONCH_SEASHELL_ROOT`; they win over the app's own copies (`src/speech-engine.ts`).
