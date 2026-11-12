# claude-swap dashboard adaptation

Source: https://github.com/realiti4/claude-swap
Revision: `3a4e5c14873eb5b32f182d55c68da98ac8c0db45` (`0.27.0b1`)
Copyright (c) 2026 Onur Cetinkol. MIT licence: [LICENSE](LICENSE).

Conch's `mac-app/conch-mac/ClaudeAccountsView.swift` adapts the thin usage bars,
70%/90% severity colours, capped bar fill, measurement freshness and
reset-countdown presentation from `src/claude_swap/tui/{widgets,theme,data}.py`.
The SwiftUI implementation uses Conch’s dark colour/typography tokens, compact
rows, on-demand account details and native controls with accessible text. It is a port of those presentation patterns, not an
embedded Python/Textual dashboard. The licence is also bundled in the Mac app
as `ClaudeSwapLicense.txt` and available under Providers → How accounts and usage work.

`src/claude-swap.ts` is Conch's schema-v1 adapter for the documented
`cswap list --json` command (`src/claude_swap/json_output.py`). The optional
claude-swap installation owns authentication, cache/backoff and API requests.
Conch does not vendor its credential, switching, autoswitch or OAuth modules.
Since account rotation shipped (2026-10-09, #537) the daemon invokes it: the
Claude section of Providers asks for `rotation-status` when it opens, and every
rotation reply carries `readSwapDashboard()`, which is the list of accounts that
screen shows. A launch profile's own usage still comes from Claude Code’s official
status-line output via `src/claude-account-usage.ts`. Refresh is explicit; the
command can refresh credentials/cache as part of its normal collection.
`src/claude-rotation.ts` runs claude-swap’s own commands (`add`, `switch`,
`remove`, and `auto --json` while `claude-rotation` is on), and claude-swap swaps
the Default profile’s login; Conch never reads or imports a credential itself.

Usage accounts and Conch launch profiles are deliberately not joined by email
or slot number. Slots can be reused and the same email can belong to different
organizations. Linking these needs an explicit verified account/connection
binding; an external collector's default login is not a running session's account.
