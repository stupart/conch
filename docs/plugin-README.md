# Conch MCP plugin

Conch exposes eight safe MCP tools over stdio for inspecting sessions, sending
voice-loop events, renaming sessions, changing configuration, and reading recent
assistant transcript text. Actions that send events require the conch daemon;
session reads can fall back to the local registry when it is unavailable.

`conch_config` changes the running daemon through its control socket. Use the
regular `conch set` or `conch unset` commands when a change must persist across
daemon restarts.

## Install

`conch install-plugin` is the supported installation path:

```bash
conch install-plugin
```

It registers the Conch MCP server for the current user in both Claude Code and
Codex. If either CLI is not installed, Conch skips that tool and continues with
the other one.

Under the hood, Conch resolves the absolute paths to the Bun executable and its
installed `src/cli.ts`, then runs:

```text
claude mcp add -s user conch -- <absolute-bun-path> run <absolute-cli.ts-path> mcp
codex mcp add conch -- <absolute-bun-path> run <absolute-cli.ts-path> mcp
```

The absolute paths are intentional: MCP commands are executed directly without
shell expansion, and GUI-launched clients might not inherit the shell `PATH`.
The installer prints the exact resolved command for each client.

Verify the connection with `claude mcp get conch`, `claude mcp list`, or
`codex mcp list`. Inside Claude Code, run `/mcp` to inspect the connection and
available tools.

Remove both registrations with:

```bash
conch uninstall-plugin
```

This runs `claude mcp remove conch` and `codex mcp remove conch`, skipping any
client whose CLI is not installed.

## Future plugin packaging

A full Claude Code or Codex plugin remains a future option. It becomes useful
once Conch ships plugin-specific features such as slash commands or hooks; the
bare MCP registration above is the installation path today.
