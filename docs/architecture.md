# How conch actually works

Written 2026-08-20 because Tyler asked: *"what does our internal system look
like? Is it an events driven architecture? Async? Or RPC and/or REST API? Time
for me to really get into the details so we can get this polished and as a base
to build innovative products on top of."*

Short answer: **all three, at different layers, and that is mostly deliberate**
— but one of them has grown past where it should be.

## The shape

```
   Claude Code / Codex sessions          you
        (someone else's processes)      /  \
              |                        /    \
         hooks + polling          Mac app  iPhone app     terminal TUI
              |                        \    /                  |
              v                         v  v                   |
        ┌─────────────────────────────────────────────────────────┐
        │                      the daemon                          │
        │  serial event queue  →  the voice loop  →  injection     │
        │  published state  →  a file, republished on change       │
        └─────────────────────────────────────────────────────────┘
```

There are four ways in and two ways out, and they answer different questions.

## 1. Events in — a serial queue

`src/daemon.ts` holds one `TurnEvent[]` and one `drain()` that walks it
strictly one at a time (`daemon.ts:1463`, `1850`, `1907`). Everything that
happens to conch becomes a `TurnEvent`: a Claude Code hook firing, a Codex turn
detected by polling, a wake from a button, an inject from a composer.

**Why serial and not concurrent:** the queue exists to protect one invariant —
the microphone must never open while TTS is speaking, or the loop hears itself.
That is stated in `CLAUDE.md` as the thing the daemon is for. Two events
handled concurrently could open a mic mid-sentence, so they are not.

**The cost:** anything slow in `handle()` blocks everything behind it. This has
bitten twice, both recorded: a modal macOS dialog froze AppleScript for 122
seconds with the whole queue stacked behind it, and a wedged `sox` held the
microphone for eight minutes. Both fixes were about bounding the slow thing
(`Promise.race` with a timeout, SIGINT-then-verify-then-SIGKILL), not about
making the queue parallel — because parallel would break the invariant.

Two things deliberately bypass the queue: **inject** and **interrupt**. Typing
at a session must not wait behind a queued announcement, and stopping must not
wait behind anything at all.

## 2. Control in — RPC over a Unix socket

`/tmp/conch.sock`, one JSON object per line, one reply per request. Not REST:
there are no resources or verbs, just `{kind, ...}` messages —
`session-start`, `session-close`, `resumable`, `agent-capabilities`,
`app-error`, `get-config`, plus the `TurnEvent` shapes.

Validated at exactly one boundary (`src/settings.ts`,
`dispatchRuntimeControlMessage` in `daemon.ts`), which is why adding
`agent-capabilities` was a type, a validator branch and a handler rather than a
new endpoint.

The phone reaches the same socket through `phone-bridge.ts`, which forwards
control lines generically with no allowlist. That is why the phone's resume
picker needed no daemon work at all — the capability already existed the moment
the daemon understood the message.

## 3. State out — a file, not a stream

The daemon writes the whole visible world to `/tmp/conch-sessions.json` and the
apps poll it. Republished on change, throttled (`publish-throttle.ts`,
`daemon.ts:2144`).

**Why a file:** it survives a daemon restart, it is trivially inspectable
(`cat` it), the Mac app is a socket CLIENT that cannot be pushed to, and a
snapshot cannot get out of order the way a delta stream can. `DebugSnapshot`
even exploits this — a request file plus a poll, no protocol at all.

**Why not a stream:** it was tried implicitly and cost us. The daemon was
publishing a full frame at up to 10Hz even when nothing changed, and the phone
decodes each frame as a complete state on the main actor — every redundant
frame was a full re-render of a busy screen. The fix was to publish *on change*,
not to switch to deltas.

**The consequence you have felt:** everything is a snapshot, so anything that
must survive between snapshots has to be carried forward explicitly. The
dictation `id`, the sticky artifact, the `transcriptPrefix` — all of them exist
because a naive publisher would drop or re-apply them.

## 4. The two agents, read completely differently

- **Claude Code** pushes: hooks fire `conch hook` as a short-lived process on
  Stop, Notification and UserPromptSubmit. Session liveness comes from
  `~/.claude/sessions/<pid>.json`, which it removes on exit.
- **Codex** is polled: conch reads its SQLite databases read-only and watches
  rollout files, because wiring Codex hooks would mean editing shared config
  that only takes effect on session start — and could never reach a session
  already running.

That asymmetry is the single largest source of complexity in the codebase, and
it is not accidental: it is what lets conch attach to sessions it did not start
without touching them.

## Async, and where it is honest

Bun, single-threaded, `async`/`await` throughout. Everything expensive is a
child process — `sox`, `whisper-cli`, `say`, Kokoro, `osascript`, `tmux` — so
the event loop is rarely the bottleneck. Codex's own audit of the relay
confirmed the loop is not being starved: injection measures 0.7–1.2s and the
30-second heartbeat window was never close.

## What is wrong with it

**`daemon.ts` is 5,615 lines.** That is the real answer to "does it need a
refactor". It holds the queue, the voice loop, the panel model, the socket
server, session lifecycle, the phone bridge wiring, wake resolution and the
control dispatch. Nothing in it is *wrong*, and its comments are unusually
good, but it is the file where every feature lands and where two writers
collide — which happened during the parity pass.

The seams are already visible and would split cleanly:

| would become | what it owns |
|---|---|
| `event-queue.ts` | the queue, drain, enqueue, the serial invariant |
| `voice-loop.ts` | wake → speak → listen → deliver |
| `control-server.ts` | the socket, dispatch, and the one validation boundary |
| `session-registry.ts` | reconciling Claude's registry with Codex's databases |

`daemon.ts` would keep wiring them together. This is worth doing BEFORE the
write pass and the marketplace, because both add control messages and both will
otherwise land in the same 5,615-line file.

**Second: two ways to run the daemon.** `conch install` puts it in launchd
inside tmux; the Mac app hosts its own. Two owners is what made "adopted" a
permanent state, and it is the root of three separate bugs already recorded.

## What this means for building on top

The reason this architecture is a decent base: **a new capability is usually a
reader plus a control message plus a view.** That is exactly how the resume
picker and the capability inspector were built, and in both cases the phone got
the feature without any daemon work because the bridge forwards generically.

The marketplace, model switching and the write pass all fit that shape. What
they do NOT fit is the current size of `daemon.ts`.
