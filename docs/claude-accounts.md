# Claude accounts in Conch

The Mac app can keep several Claude sign-ins available and choose one when starting a session. Each additional account uses its own `CLAUDE_CONFIG_DIR`. Claude owns the login, Keychain entry, and subscription; Conch stores only an ID, display name, and configuration directory.

## Use it

1. Open **Settings → Providers → Connect account**, or **New session → Account → Manage**.
2. Name it (for example, Work) and choose **Continue to Claude sign-in**. Conch creates a separate folder and opens the official subscription login in Terminal. An existing configuration folder can be chosen under the disclosure.
3. Finish the browser/Terminal login. Conch checks the new connection automatically for up to two minutes; **Details → Check connection** can check it again. Logos, account names, emails, and plan names stay visible.
4. Choose the account in **New session**. Resume, restart, and attach retain the original account. The header names it; the resume picker searches all registered profiles.
5. After a Claude response, return to **Providers** and refresh to see the latest measured five-hour and weekly usage. This requires Claude 2.1.251 or later. No separate collector is required.

The default profile preserves the existing CLI environment. In particular, an unset `CLAUDE_CONFIG_DIR` stays unset at launch, preserving the default Keychain lookup. Additional profiles clear inherited Anthropic API/token/provider-selection variables before launch. Project and managed Claude settings still apply; use Claude's `/status` to verify the effective credential where those configure other providers.

## Lifecycle

New, resume, restart, background attach, and background stop carry the selected profile. The daemon discovers and watches all registered Claude roots and passes them to the transcript indexer. The existing Terminal tab and PID routing continues to handle typing, focus, and clean shutdown.

Sign-in and removal require a fresh, complete registry read with no live sessions for that account. Removal restores the previous status line and unregisters the profile: it does not delete conversations, revoke credentials, cancel a subscription, or log out. A removed profile ID fails explicitly instead of falling back to another account.

Conch adds its lifecycle hooks to the selected configuration at login/launch using the existing idempotent installer. Existing settings are preserved and backed up if changed. A managed status-line wrapper records official public rate-limit fields and forwards the original status-line input/output. Its private sidecar preserves the original command; the measurement cache contains only identity, usage, and time. Claude owns the credentials.

## Storage and protocol

- Metadata: `$CONCH_CONFIG_DIR/claude-accounts.json`, defaulting to `~/.config/conch/claude-accounts.json`.
- New profile folders: `<Conch config directory>/claude/<generated UUID>`.
- Maximum: 16 additional profiles plus Default.
- No credentials are copied into the metadata or socket reply.

```json
{"kind":"claude-accounts","action":"add","label":"Work"}
```

Other actions are `list`, `refresh`, `login`, `remove`, and `usage`; `refresh`, `login`, and `remove` take the returned account `id`. `add` returns `createdAccountId` so the app can continue directly to `login`. Replies include public CLI status and cached native usage. `usage` reads the latest local usage measurements; it does not make a billing API request. A `session-start` request may include `claudeAccountId`. Omitting it preserves existing callers' behavior. The CLI also accepts `conch start claude --account <profile-id>`.

## Scope

This version manages account choice and reports authentication status. Its main view adapts claude-swap's usage bars and reads Claude Code's supported status-line output. It does not purchase subscriptions, pool allowances, rotate on rate limits, or move a conversation between account roots. Keep histories where Claude created them; copying the same conversation UUID between profile folders is not a migration workflow. Separate profile directories do not isolate keyless Claude Console/Anthropic profile authentication, which Claude stores outside those directories.

See [accounts and runtimes](accounts-and-runtimes.md) for the independent identity/location model, measurement freshness, and open-source attribution.

The native account UI and picker are Mac features. Other clients that omit an account continue to use their existing default behavior.

## References

- [Claude's official multi-account authentication guidance](https://code.claude.com/docs/en/authentication)
- [T3 Code's Claude provider guide, v0.0.42](https://github.com/pingdotgg/t3code/blob/v0.0.42/docs/user/providers-claude.md)
- [T3 Code's environment construction](https://github.com/pingdotgg/t3code/blob/v0.0.42/apps/server/src/provider/Drivers/ClaudeHome.ts)

T3 Code informed the separate-directory approach and visible account identity. The native usage dashboard adapts claude-swap's MIT-licensed presentation; its notice is included in the source and app.

## Resume with another account

Conch keeps ordinary resume within the original account directory, matching T3 Code’s isolation model. Anthropic documents that separate directories have separate histories; its documentation does not guarantee moving a local transcript to a different account. This is a Conch boundary, not a claim that Anthropic categorically forbids all cross-account local resumes. Start a fresh session under the other account for now. Remote/cloud sessions also have provider-owned access rules.

- [Official session management](https://code.claude.com/docs/en/sessions)
- [Official status-line rate limits](https://code.claude.com/docs/en/statusline#rate-limit-usage)
