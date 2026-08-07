# conch

A turn-based voice loop for Claude Code: hooks announce finished turns aloud (`say`), a daemon opens a mic window (sox + whisper.cpp), and the transcript is injected back into the session's tmux pane.

- Bun only — `bun <file>`, `bun test`, `Bun.spawn`/`Bun.$`/`Bun.file` over Node equivalents.
- No runtime npm deps; everything shells out to macOS binaries (`say`, `afplay`, `sox`, `tmux`, `osascript`) and whisper-cli. Keep it that way.
- The mic must never open while TTS is speaking — that invariant (in `daemon.ts`) is what prevents the loop hearing itself.
- Whisper engine resolves in order: a seashell checkout (`CONCH_SEASHELL_ROOT`, default `~/whisper-cli`) → a brew `whisper-cpp` install → `~/.cache/conch/models` (where `conch setup` downloads them). conch doesn't vendor models in the repo; `conch setup` fetches them.
- Test text processing with `bun test`; mic/TTS paths need a human (`conch listen`, `conch speak`).
- The agent-facing contract (incl. how to ask for review) lives ONLY in `docs/conch-control-skill.md` and ships in the plugin — don't restate it here or in any user's CLAUDE.md. `plugin/plugins/conch/{AGENTS.md,skills/conch-control/SKILL.md}` are generated from that doc and checked in, since the marketplace serves that dir straight from git while Homebrew regenerates it; edit the doc, regenerate both (a test enforces it).
