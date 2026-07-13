# conch

A turn-based voice loop for Claude Code: hooks announce finished turns aloud (`say`), a daemon opens a mic window (sox + whisper.cpp), and the transcript is injected back into the session's tmux pane.

- Bun only — `bun <file>`, `bun test`, `Bun.spawn`/`Bun.$`/`Bun.file` over Node equivalents.
- No runtime npm deps; everything shells out to macOS binaries (`say`, `afplay`, `sox`, `tmux`, `osascript`) and whisper-cli. Keep it that way.
- The mic must never open while TTS is speaking — that invariant (in `daemon.ts`) is what prevents the loop hearing itself.
- Whisper engine resolves in order: a seashell checkout (`CONCH_SEASHELL_ROOT`, default `~/whisper-cli`) → a brew `whisper-cpp` install → `~/.cache/conch/models` (where `conch setup` downloads them). conch doesn't vendor models in the repo; `conch setup` fetches them.
- Test text processing with `bun test`; mic/TTS paths need a human (`conch listen`, `conch speak`).
