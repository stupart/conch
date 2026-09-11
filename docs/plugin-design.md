# Conch Plugin (Intelligence Layer) — Design

Recon of `main`, plus branches `feat/state-and-health` (G2) and `feat/review-to-front` (G5).

## Architecture: in-repo MCP server, thin over the existing socket

An MCP server bundled in the conch repo (`src/mcp.ts`, run with `bun`), exposing conch's
existing command surface as tools a Claude Code session can call to BECOME conch.

- **Only MCP gives Claude callable tools mid-turn.** Slash-commands are user-invoked; hooks are
  event-driven. The `conch:review` text marker (G5) stays as the zero-tool fallback.
- **In-repo, not a sidecar shelling `conch <cmd>`.** The CLI prints human prose; parsing it is worse
  than importing. `src/mcp.ts` imports `sessions.ts`, `hook.ts:sendToDaemon`,
  `settings.ts:sendControlMessage`, and reads the two `/tmp` state files.
- **Zero new runtime deps** (per CLAUDE.md): MCP over stdio is newline-framed JSON-RPC, hand-rolled
  in plain Bun. (Open Q1: allow `@modelcontextprotocol/sdk` instead? Default = hand-roll.)
- **Daemon down ≠ plugin dead:** reads fall back to `registrySnapshot`.

## Shared data model (plugin ⇄ future mobile websocket)

G2's `PublishedState` IS the shared model — the plugin's `conch_sessions` output, the `/tmp` file,
and the future websocket "state" frame are the same object. Additions: G5's `review` field folded
into the row, plus `cwd` (mobile + spawn need it). Types: see design recon (SessionStatus,
ReviewRequest, SessionRow, PublishedState, ConchFrame envelope).

## Tool set

SAFE tools (this scaffold — map to EXISTING socket sends / imports, no protocol change, non-destructive):
- `conch_sessions` — read `/tmp/conch-sessions.json`; fallback `registrySnapshot`
- `conch_wake { session? }` — TurnEvent `wake`
- `conch_recite { session? }` — TurnEvent `recite` + transcriptPath/mark
- `conch_speak { text, voice? }` — TurnEvent `speak`
- `conch_mode { action: pause|resume }` — bare TurnEvent; old aliases normalize at the compatibility boundary
- `conch_rename { session, label }` — `renameSessionLabel` import
- `conch_config { key?, value?, unset? }` — `sendControlMessage`
- `conch_transcript_tail { session, sentences? }` — `lastAssistantText`

DEFERRED tools (need a socket-protocol extension AND answers to open questions — NOT in this scaffold):
- `conch_prioritize`, `conch_dismiss` — need new `session-command` control message (prioritize/dismiss
  exist only as dashboard actions today).
- `review_to_front` — needs new `review-to-front` control message (reuses G5's latch).
- `conch_spawn`, `conch_close` — no primitive exists; genuinely open (Q3/Q4), destructive.

## Open questions (for Tyler)

1. MCP framing: hand-roll stdio JSON-RPC (zero-dep, default) vs allow the official SDK as first runtime dep?
2. Packaging: conch repo ships `.claude-plugin/` itself vs a separate plugin repo?
3. `conch_spawn` semantics: which tmux session/window? who picks cwd?
4. `conch_close` destructiveness: inject `/exit` vs `kill <pid>`? spoken confirm?
5. Review lifecycle: what clears a `review` latch — any prompt to that session, explicit dismiss, or both?
6. `get-state` socket reply vs reading `/tmp/conch-sessions.json` (default: file-read first).
7. Dismiss/restore uses dedicated visibility state and preserves the latest turn for replay.

## MCP launch: one declaration per harness

The marketplace serves `plugin/plugins/conch` from git, so the declaration has to start the server
with no absolute path, and the two harnesses expand different things. Claude Code 2.1.266 reads
`.claude-plugin/plugin.json`, then `.mcp.json`, and replaces only `${CLAUDE_PLUGIN_ROOT}`,
`${CLAUDE_PROJECT_DIR}` and `${CLAUDE_PLUGIN_DATA}`. It has no `${PLUGIN_ROOT}`. Codex (rust-v0.153.4) reads
`.codex-plugin/plugin.json`. That manifest has no Agent Plugins `$schema`, so Codex treats it as the
legacy format and passes `command` and `args` through unexpanded. It clears the environment and joins a relative
`cwd` onto the plugin root (`codex-rs/codex-mcp/src/plugin_config.rs`). `${PLUGIN_ROOT}` is expanded
only for Agent Plugins files, which also refuse absolute commands. So no single variable works for
both. Claude keeps `.mcp.json` (`sh ${CLAUDE_PLUGIN_ROOT}/bin/conch-mcp`). The Codex manifest names
`./.codex-mcp.json` (`sh ./bin/conch-mcp`, `"cwd": "."`). `conch install-plugin` writes the same
absolute invocation into both files, so an installed copy reads exactly as before.
`test/install-plugin.test.ts` follows each harness's rules on the checked-in files.
