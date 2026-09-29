# Messages to Codex app tasks

A Codex task can have an app-server writer and no terminal. `pid = 0` and
`noTerminal` still describe that correctly. `messageRoute: "codex-app"` is a
separate capability: the Mac and iOS composers permit messages while terminal
focus, close, Stop, and terminal-only question/permission controls stay disabled.

Conch discovers the private, current-user-owned `<CODEX_HOME>/ipc/ipc.sock`
endpoint only for live app-server rows. It registers as `clientType: "conch"`,
asks `thread-owner-discovery` for the exact native task ID on the local host, and
addresses only that owner. No second app-server is launched, no writer lock is
acquired, no account or model is changed, and no app-tools MCP identity is used.
The Codex app itself forwards the request to the process owning the task.

The adapter first requests `thread-follower-steer-turn` (version 1). A running
turn accepts the new message as steering input. Only the explicit rejection
`Cannot steer conversation <id> because its active turn already ended` permits
`thread-follower-start-turn` (version 2), with `inheritThreadSettings: true`.
Delivery requires the provider's nonempty turn ID in the owner's reply. Socket
writes, empty replies, and optimistic UI state do not count as delivery.

An unavailable app, unopened task, protocol mismatch, or uncertain submission
returns the user's words to the existing draft channel. An uncertain send is
recorded as unknown and never retried automatically or redirected to keys/the
clipboard. With auto-submit disabled, the draft remains in Conch without an API
submission. Terminal picker answers and permission approvals require the owning
app; this transport handles plain messages only.

## Compatibility

This is a small original implementation of the installed desktop app's versioned
local follower protocol, observed on 2026-09-29. It is not a documented public
OpenAI API. The privileged app-tools pipe is a different endpoint and is not
used. Unsupported versions fail without a fallback send. No application bundle
code is copied or shipped in Conch.

The public [Codex app-server API](https://learn.chatgpt.com/docs/app-server)
supports messages on an app-server you connect to, but starting another server
does not attach it to the desktop app's existing writer. Standalone shared
app-server daemons without a desktop owner, closed tasks, other providers'
headless processes, and remote/cloud task discovery are not implemented here.
A task hosted by the app can receive messages through its existing app owner;
this change does not migrate conversations or create cloud jobs.

## Validation

- Live delivery to task `01a0ebc6-303d-7762-9df7-7406a1e1272b` returned the active
  turn ID and appeared as user input in that same task.
- Socket fixtures cover fragmented frames, active steering, inactive-to-start,
  timeouts, missing acknowledgements, incompatible versions, cancellation,
  ownership/mode checks, and symlink rejection.
- Voice-loop tests cover account-scoped native identity, acknowledged receipts,
  uncertainty, no terminal/clipboard fallback, and auto-submit off.
- Mac and iOS decode the additive capability; older daemon rows retain their
  previous disabled behavior.
