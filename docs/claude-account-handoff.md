# Continue a local Claude Code conversation with another account

Connect the destination through **Settings → Providers → Claude Code → Add account** and finish the official browser sign-in. In **New session → Resume**, select the source conversation, choose the destination email in **Continue with**, and press **Continue with account**. Stop or pause the original session before continuing: the two processes share the working folder. Conch does not close the old terminal or submit a prompt automatically.

Conch uses the official CLI with the destination's isolated account environment:

```sh
claude --resume /absolute/path/to/snapshot.jsonl --fork-session --session-id <new-uuid>
```

The original conversation and credentials are untouched. The CLI creates a new conversation under the destination profile. Conch installs its normal hooks and usage integration for that profile, opens Terminal, and waits for the new conversation's exact ID to check in. Folder trust and any remaining login prompts still belong to Claude Code. Terminal-opened is not proof that a model request succeeded.

This is a local Mac handoff, with both account profiles registered on that Mac. It does not migrate claude.ai chats, cloud workspaces, remote machines, running processes, or account-specific plugins, MCP settings, memory, and credentials. Existing project files are used in place. Interrupted tool calls remain subject to Claude Code's resume behavior; inspect their effects before retrying work. A long history can consume substantial destination-account usage when it is processed again.

## Evidence and limits

- Anthropic documents [resuming an absolute transcript path](https://code.claude.com/docs/en/sessions) and [`--fork-session`](https://code.claude.com/docs/en/cli-reference). Its session documentation explains what resume does and does not restore.
- On February 18, 2026, Anthropic's Thariq [stated](https://x.com/trq212/status/2024230184287949207): “it's not against terms of service to have multiple MAX accounts”. He distinguished prohibited uses such as reselling tokens. The original text was verified through X's public syndication endpoint, not just a secondhand report.
- We found no official prohibition specifically targeting local conversation migration. That employee statement is not a guarantee against enforcement or an explicit policy for automatic subscription rotation. The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) remain applicable.
- Anthropic also offers [usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) to continue on the existing account after included limits. Conch does not enable spending, buy subscriptions, or rotate accounts automatically.

The initial implementation requires Claude Code 2.1.280 or later, the first version verified here. An isolated test with the installed CLI and a local mock API confirmed that the old history reaches the next request, the new UUID is written under the destination profile, and the source transcript is unchanged. This verifies native CLI behavior without consuming subscription usage. A real cross-subscription response, including provider-side acceptance of any opaque historical blocks, requires a signed-in destination and an actual user request; it has not been claimed as tested.

## Records and recovery

Each explicit handoff saves an owner-only transcript snapshot and `manifest.json` under `<conch-config>/handoffs/<new-uuid>/`. The manifest records source and destination profile/native IDs, the device ID, source transcript SHA-256 and byte count, working folder, available Git root/commit/branch/dirty status, and whether preparation or Terminal launch completed. It contains no credential files or environment-variable dump. Transcript snapshots are sensitive conversation data and are retained until removed by the owner.

When Records is enabled, append-only `handoff` receipts also link the source and destination in `records/history.sqlite`. These survive derived-history reindexing. With Records off, the manifest still preserves provenance; enabling Records later does not backfill these receipts. Conch does not silently turn on history indexing.

The existing database contains normalized visible conversation content and tool activity. It is not a complete native transcript or a restorable machine image. Handoff therefore preserves the original native bytes for the CLI and uses the database for provenance. No native JSONL entries are rewritten. Missing/ambiguous histories, incomplete records, changed working folders, unsupported CLI versions, and unsigned-in destinations fail before a terminal is opened. Snapshots are limited to 128 MB.
