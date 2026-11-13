# Messages to Codex app tasks

A shared Codex app-server can host terminal and desktop sessions simultaneously.
Its writer-lock PID identifies the server, not the user's window. Discovery first
looks for a foreground Codex TUI explicitly running `resume <thread UUID>`
(including `codex yolo resume`). The TUI must belong to the current user and have
the matching account's log database open, or be connected over a unix socket to
the app-server holding that thread's lock (a TUI attached to the shared daemon
can sit idle with no log database open). That terminal gets the PID and the
normal terminal delivery/focus controls, even if a desktop copy also exists.
Picker/`--last` launches and ambiguous command lines are not guessed from cwd.

A plain `codex` (no `-c`, `--profile` or `--no-daemon`) attaches to the shared
daemon and starts one when none runs (codex-cli 0.167.2,
`codex-rs/tui/src/daemon_startup.rs`). Such a window names no thread on its
command line, its log rows carry no thread ID, and the daemon's logs name a
connection number rather than a process, so nothing ties it to its thread. That
is why conch opens every Terminal Codex session with `--no-daemon` (the adapter's
`terminalFlags`), as it already did in the background: the window holds its own
thread's lock and is credited by it, whatever the daemon does. The one exception
is a resume of a thread an app-server already holds, where a private server
could not take the lock: that window joins the server with `codex resume <id>`
(`sharedServer`) and is credited by the proof above. A background resume of one
is refused with a message instead, since nobody would see the error in its pane.
The daemon and `conch start` in a shell both decide this with `placeHeldResume`.

Remaining app-server threads are checked with read-only `thread-owner-discovery`
on the desktop follower socket. Only acknowledged owners receive `codex-app`.
The existence of the socket alone is insufficient. Probes are coalesced and cached
for five seconds; sending still rechecks the owner. Missing owners and discovery
failures never trigger a new conversation or a second writer.

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

- Live delivery to task `5e5e5e21-0021-7000-8000-000000000021` returned the active
  turn ID and appeared as user input in that same task.
- Socket fixtures cover fragmented frames, active steering, inactive-to-start,
  timeouts, missing acknowledgements, incompatible versions, cancellation,
  ownership/mode checks, and symlink rejection.
- Voice-loop tests cover account-scoped native identity, acknowledged receipts,
  uncertainty, no terminal/clipboard fallback, and auto-submit off.
- Mac and iOS decode the additive capability; older daemon rows retain their
  previous disabled behavior.

## Open the host app

The session header uses a window icon for a known Codex desktop chat and keeps
the terminal icon for terminal sessions. Clicking the title takes the same
route. `session-open-app` carries only a Conch session ID; the daemon resolves
its native UUID and asks macOS to open `codex://threads/<UUID>`. This exact-chat
link was verified against the installed app's URL handler on 2026-09-30.
The response confirms Launch Services accepted the link, not that the window
was observed in front. Failed launches are displayed in the Mac row or phone
alert. The phone requests this on its paired Mac, not on the phone itself.

Subagents and unknown/headless hosts have no app shortcut. This command neither
creates a conversation nor sends a message. Terminal sessions continue through
`terminal-focus`; passive reveals and the debug terminal mirror are unchanged.
