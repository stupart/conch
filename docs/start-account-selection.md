# Accounts in the start sheet

Mac and iOS use the same account card and availability policy for Claude and
Codex. The card shows the email, profile name, provider mark, usage bars and
reset times. Expand the card to compare accounts before choosing one. The Mac
offers Manage; iOS uses accounts connected on its paired Mac, where the session
will run.

An account with a confirmed exhausted included-plan window is disabled, as is
Start when that account is already selected. The reading must be successful,
at most five minutes old, identity-matched by the daemon, and have a future
reset time. The clock re-evaluates the choice while the sheet stays open.
Model-specific Codex buckets do not establish that the whole account is empty.

Unknown, stale, incomplete and expired readings remain selectable and are
labelled accordingly. Missing usage is never displayed as 0%. Refresh reads the
provider's available usage data: Claude's most recent status-line report, or
Codex's official account rate-limit response. It cannot manufacture a fresh
Claude report when Claude has not supplied one.

Advanced contains launch options and an explicit “Allow accounts at their
included limit” override for an account with extra usage or credits already
enabled. Conch does not enable billing or promise that extra capacity exists.
The override cannot select a removed account or one known to need sign-in.
Permission prompts' bypass setting remains visible even with Advanced closed.

Resume retains the original account by default. Claude may explicitly continue
with another signed-in account using the existing transcript-fork handoff. The
original conversation remains available on the old account; later messages in
the fork are not merged back. Codex resumes remain pinned to their original
account. iOS sends both source and destination identities for a Claude handoff,
and scopes resume-list identities by provider, account and native session ID.

Accounts never rotate automatically. An unavailable account stays selected with
a reason until the person changes it; no silent fallback can launch under the
wrong subscription.

Validation lives in `StartAccountsTests.swift` (availability and reply decoding)
and `test/start-accounts-ui.test.ts` (both native clients and their wire routing).
The design gallery's `start-account` fixtures cover reported usage, an exhausted
plan and unknown usage in light/dark at Mac and phone widths.
