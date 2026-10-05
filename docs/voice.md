# Voice

How conch talks to you, and how what you say gets back to the right session. The settings named here are in
[configuration.md](configuration.md).

## The loop

```
a session finishes a turn
  └─> ding + "acme-web: Done. The Stats tab renders and all 14 tests pass."
        └─> the mic opens, only after conch stops speaking
              └─> you: "great, now do the same for the horizontal layout"
                    └─> your words are typed into that session and sent
```

Each finished turn is announced by the session's name, in that session's own voice, and the whole reply is read
aloud (`read-full`). Then a tink, and the mic opens. Speech-to-text runs on the Mac with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) on Metal; a warm whisper-server keeps the model loaded and
re-transcribes the recording while you talk, so your words appear as you say them.

The loop is turn-based: conch speaks, then listens, never both. The mic can't hear conch's own voice, so there is no
feedback loop and no need for headphones.

With no daemon running, the hooks still ring the bell and speak announcements; there is just no mic.

## Which session hears you

The announcement is the address. What you say next goes to the session that just spoke. If several finish while you
are talking to one, they wait their turn and are read one at a time, oldest first (`handoff-order`).

To talk to another session, start with its name: "hey acme-web, run the tests again". You can also reopen the mic
yourself: the mic button in the app's composer, `conch wake [name]` (bind it to a global hotkey), or the space bar in
the terminal dashboard.

## How your words reach a session

- A session conch started runs in conch's own tmux server, and your words are typed into its pane. So is a session
  running in a tmux pane of your own.
- A session in a macOS Terminal window: conch brings that window forward and types into it (`keystroke-fallback`).
  This needs the Accessibility and Automation permissions.
- A Codex task open in the Codex app gets your words through the app's own connection.
- Anywhere else, your words go to the clipboard instead of being lost, and conch says "just paste".

## Voice commands

While the mic is open, a bare command talks to conch instead of the session:

| You say | What happens |
|---|---|
| "stop", "got it", "enough" *(while it's reading)* | Stops reading and opens the mic for your reply |
| "no response", "no response needed", "cancel", "never mind" | Closes the mic and moves on to the next session |
| "continue", "keep going", "read the rest" | Reads more, then listens again |
| "repeat", "say that again" | Says the last thing again |
| "send", "go ahead" | Sends held dictation now, instead of waiting for `hold-submit-delay` |
| "hey acme-web, …" | Sends the rest to the session named acme-web |
| "conch, did the tests pass?" | With `voice-qa` on, answers from that session's last reply without sending anything |
| anything else | Goes to the session as your prompt |

Commands only match as the whole utterance: "continue working on the login bug" is a prompt. Filler around them is
fine ("Oh, continue."). A soft bottle sound means the mic closed on silence.

## Permission prompts and questions

For a Claude Code session, a permission prompt opens the mic too. conch says which tool and what it wants, read from the
transcript ("acme-web needs permission for Bash: git push origin main"), then presses what you would press: "yes" is
Return on the highlighted option, "no" is Escape, and "no, use main instead" is Escape with the rest typed as your next
prompt. conch won't grant "always" by voice, because what that option grants differs by tool and conch can't say for
sure; it tells you so and asks yes or no once more. The Mac app and the phone show the same prompt with Allow and Deny,
and answer an agent's multiple-choice questions with its picker's own keys.

A Codex approval is announced and shown as needing you, and you answer it in Codex. An answer to a Codex question goes
in as a message.

Idle "waiting for your input" notifications are filtered: conch stays quiet unless the session's last reply actually
asked you something.

## Manual and auto

`conch pause` switches to manual: replies stay visible, announcements and the automatic mic stop, and conch holds the
latest finished turn of each session. `conch resume` returns to auto and reads what it held. The mode can also be set
per session, from the app or with `p` on a parked row in the terminal dashboard.

conch also keeps quiet on its own:

- **You're typing.** If you touched the keyboard or mouse in the last two seconds, a finished turn stays visual and
  the mic stays closed (`typing-grace`).
- **You're away.** After five minutes with no keyboard or mouse it stays quiet, so it never opens a mic on an empty
  room (`away-after`). `conch wake` and the space bar still work.
- **You're in a meeting.** With `meeting-autopause` on, it pauses while another app is using a microphone and goes
  back to how it was afterwards.

## Natural voices

Every session gets its own natural voice: [Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16), running
locally on the Apple GPU. It sets itself up. The first time the daemon starts, it builds conch's own voice environment
in the background (about 1.3 GB, once, into `~/.cache/conch/voice`) and fetches the model (about 360 MB, into the
standard Hugging Face cache), speaking with macOS `say` until it is ready. Settings → Session voices shows where it
stands (*Natural voices: setting up… / ready / off (reason)*), and so does `conch doctor`. `conch voices setup` does
the same build in the foreground and prints its progress. Kokoro needs Apple silicon; an Intel Mac stays on `say`.

The Mac app carries a pinned [uv](https://github.com/astral-sh/uv), which the daemon uses to install its own Python 3.12
and exactly the packages in a hashed lock (`src/voice-requirements.txt`). Nothing touches your system Python or your
own uv tools. Every start checks that environment against the lock and Kokoro's files against their hashes, and
rebuilds or refetches whatever is missing or damaged in the background: offline, it waits for the network; out of disk,
for space. Failures are logged with their reason in `~/.cache/conch/voice/setup.log`, and the app says one line, with
Try again, only if healing really fails.

- **Opt out:** `CONCH_TTS=say`. Nothing is downloaded or built.
- **Use your own Python:** `CONCH_TTS_WORKER_PYTHON=/path/to/python`, used as it is. It needs `mlx-audio`,
  `misaki[en]`, `loguru` and the spaCy English model, on Python 3.10 or newer.

The daemon runs one worker with no network listener: it loads Kokoro once and takes requests over stdin and stdout. If
a request times out or the worker crashes, it is killed and a fresh one started, and speech falls back to `say` in the
meantime. In manual mode the worker is unloaded after a short grace to free its memory, and auto mode warms it again.

Session labels are hashed onto a ring of 8 Kokoro voices, so a session always sounds the same and you can tell them
apart by ear. Audition the ring with `conch voices` (or `v` in the terminal dashboard), pin one with
`conch voice acme-web bm_george`, or change the ring with `CONCH_TTS_VOICES` (any of Kokoro's voices).
