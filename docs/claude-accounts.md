# Claude accounts in Conch

The Mac app can keep several Claude sign-ins available and choose one when starting a session. Each additional account uses its own `CLAUDE_CONFIG_DIR`. Claude owns the login, Keychain entry, and subscription; Conch stores only an ID, display name, and configuration directory.

## Use it

1. Open **Settings → Accounts → Launch profiles**, or **New session → Account → Manage**.
2. Add a name such as Work. Conch assigns a separate folder, or you can select an existing Claude configuration folder.
3. Choose **Sign in** and finish Claude's official login in Terminal and your browser. Choose a Claude subscription account for Max or Pro.
4. Return to Conch and choose **Check status**. The CLI supplies the sign-in state, email, and subscription type when available.
5. Choose the account in **New session**. The session header names it. The resume picker reads registered profiles and uses each conversation's original account.

The default profile preserves the existing CLI environment. In particular, an unset `CLAUDE_CONFIG_DIR` stays unset at launch, preserving the default Keychain lookup. Additional profiles clear inherited Anthropic API/token/provider-selection variables before launch. Project and managed Claude settings still apply; use Claude's `/status` to verify the effective credential where those configure other providers.

## Lifecycle

New, resume, restart, background attach, and background stop carry the selected profile. The daemon discovers and watches all registered Claude roots and passes them to the transcript indexer. The existing Terminal tab and PID routing continues to handle typing, focus, and clean shutdown.

Sign-in and removal require a fresh, complete registry read with no live sessions for that account. Removal only unregisters the profile: it does not delete conversations, revoke credentials, cancel a subscription, or log out. A removed profile ID fails explicitly instead of falling back to another account.

Conch adds its lifecycle hooks to the selected configuration at login/launch using the existing idempotent installer. Existing settings are preserved and backed up if changed.

## Storage and protocol

- Metadata: `$CONCH_CONFIG_DIR/claude-accounts.json`, defaulting to `~/.config/conch/claude-accounts.json`.
- New profile folders: `<Conch config directory>/claude/<generated UUID>`.
- Maximum: 16 additional profiles plus Default.
- No credentials are copied into the metadata or socket reply.

```json
{"kind":"claude-accounts","action":"add","label":"Work"}
```

Other actions are `list`, `refresh`, `login`, `remove`, and `usage`; `refresh`, `login`, and `remove` take the returned account `id`. `usage` reads the optional claude-swap collector. A `session-start` request may include `claudeAccountId`. Omitting it preserves existing callers' behavior. The CLI also accepts `conch start claude --account <profile-id>`.

## Scope

This version manages account choice and reports authentication status. Its Usage tab adapts claude-swap's dashboard and reads quota/reset information when that optional collector is installed and configured. It does not purchase subscriptions, pool allowances, rotate on rate limits, or move a conversation between account roots. Keep histories where Claude created them; copying the same conversation UUID between profile folders is not a migration workflow. Separate profile directories do not isolate keyless Claude Console/Anthropic profile authentication, which Claude stores outside those directories.

See [accounts and runtimes](accounts-and-runtimes.md) for the independent identity/location model, collector setup boundary, and open-source attribution.

The native account UI and picker are Mac features. Other clients that omit an account continue to use their existing default behavior.

## References

- [Claude's official multi-account authentication guidance](https://code.claude.com/docs/en/authentication)
- [T3 Code's Claude provider guide, v0.0.42](https://github.com/pingdotgg/t3code/blob/v0.0.42/docs/user/providers-claude.md)
- [T3 Code's environment construction](https://github.com/pingdotgg/t3code/blob/v0.0.42/apps/server/src/provider/Drivers/ClaudeHome.ts)

T3 Code informed the separate-directory approach and visible account identity. The native usage dashboard adapts claude-swap's MIT-licensed presentation; its notice is included in the source and app.
