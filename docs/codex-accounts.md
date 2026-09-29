# OpenAI / Codex accounts

Settings → Providers shows OpenAI · Codex and Anthropic · Claude Code together. Each account keeps its provider logo, label, email, reported plan, and usage visible; paths and maintenance actions are behind Details. OpenAI reports ChatGPT plan names (for example, Pro), not Claude’s Max plan name. API-key billing is identified separately from subscription usage.

## Connect and use an account

1. Under OpenAI · Codex, choose **Connect account**, give it a name, and choose **Continue to Codex sign-in**.
2. Conch registers a separate `CODEX_HOME`, installs its lifecycle hooks there, and opens official `codex login` in Terminal. Complete the browser sign-in with the intended email. You still perform the provider’s authentication yourself.
3. Conch checks the connection automatically. **Details → Check connection** checks again. It reads public account identity and usage from a short-lived Codex app-server connection, without reading `auth.json` or the Keychain itself.
4. In **New session**, choose Codex and the account. Conch supplies the account folder and launches Terminal. Approve Codex’s hook trust review if prompted on first use. Resume and restart use the same account folder and history automatically.

The account folders also isolate Codex settings, MCP configuration, and skills. Conch does not copy configuration or credentials from the default account into a new account. The existing default account retains its CLI environment; additional accounts clear inherited OpenAI API/access-token overrides before invoking Codex. Project and managed settings still apply. The account store contains only registration IDs, display names, and paths. Removing an account unregisters it without deleting history, revoking credentials, or cancelling a subscription. Login changes and removal are blocked while the account has live sessions, or liveness cannot be verified.

## Environments

- **This Mac:** new local sessions use the account selected at launch.
- **Other Macs:** pair an existing Conch installation to view and send typed input to its sessions. Each device owns its accounts and local terminal routes. Pairing does not transfer credentials or start remote sessions.
- **Codex cloud:** choose a connected ChatGPT account and open **Codex cloud in Terminal**. Conch runs the official `codex cloud` browser using that account’s home. Browse the provider’s real environments and tasks there. Environment creation and cloud task management remain in Codex; this is not a native cloud inventory or automatic scheduler.

## Limits and routing

Account choice is manual. Conch does not hop subscriptions, change a running session’s credentials, redeem reset credits, or switch to paid API billing when limits are reached. To use another account, start a new session and select it. Ordinary resume remains in the original profile; cross-account history migration is not implemented.

Usage reads report the provider’s percentage consumed and reset time for each available window. Missing readings remain unavailable; expired windows wait for fresh data. While Providers is open, it refreshes on a one-minute cadence. No session or task is started to fetch usage.

## Sources and verification

- [Official authentication and CODEX_HOME storage](https://learn.chatgpt.com/docs/auth)
- [Official app-server account and rate-limit methods](https://learn.chatgpt.com/docs/app-server)
- [Official cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment)
- [OpenAI source: Keychain storage is scoped by the canonical Codex home](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)

The local integration was checked against `codex-cli 0.157.1`. Tests exercise account metadata, launch/resume/restart, login and cloud terminal commands, a fake app-server exchange and timeout, unknown usage, liveness isolation, history, records roots, and protocol validation. A new account’s real OAuth flow still requires its owner to finish sign-in.
