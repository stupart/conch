# Install journeys

Tyler's ask, verbatim: "i just want users to be able to install like one
thing and it just works … mapping out install paths and making the ux super
smooth via customer journey mapping and reducing it all to like minimum
amount of steps max simplicity, great communication."

This is that map. One row per step a person actually takes, what they see,
and where it goes quiet. Every "goes quiet" below was hit for real, most of
them on the new laptop on 2026-09-10; the ones already fixed say so.

## The three paths

| | who | steps today | target |
|---|---|---|---|
| **Brew** | anyone on macOS | 2 commands + 3 prompts | 1 command + 2 prompts |
| **From source** | people hacking on conch | 5 commands + Xcode + a Developer ID cert | unchanged; it is a developer path |
| **Phone** | after either of the above | open a tab, scan | open a tab, scan |

## Path 1 — Brew

| step | what they type or see | goes quiet when | state |
|---|---|---|---|
| 1 | `brew install stupart/tap/conch` | the tap was pinned to a months-old version with nothing saying so | **fixed**: `release.yml` bumps the tap on every tag; `release-gap` CI job fails when main is ahead of the last release |
| 2 | `conch setup` — downloads ~574 MB of models, wires hooks, installs the plugin, starts the service (or leaves it to the app) | a slow connection made this look hung; the model size was in the README, not on screen | **fixed** (#139): setup prints the size and destination before the download and a progress line during it |
| 3 | macOS asks for microphone access | the prompt is attributed to whatever spawned sox; without the app it is attributed to nothing and the recorder records silence | **fixed**: the app owns the daemon and carries the entitlement; `conch doctor` says so |
| 4 | an already-open Claude Code session needs `/hooks` once | nobody told them; the session just stayed silent | **fixed** in the CLI (#139): setup prints the line whenever it actually wired hooks. Open: the app's first-run screen |
| 5 | first finished turn: conch speaks, tinks, opens the mic | Manual mode was persisted from a previous install and nothing spoke | **fixed** (#139): setup ends by saying which mode the daemon starts in and the one key or command to change it |

## Path 2 — From source

| step | what they type or see | goes quiet when | state |
|---|---|---|---|
| 1 | `git clone && bun install && bun link` | a brew `conch` is also on PATH; app and daemon end up on different versions | **fixed**: `conch doctor` warns when more than one `conch` is on PATH, names each path, and says to keep one |
| 2 | `scripts/build-app.sh` | no Xcode, or no Developer ID cert for the team; the script refuses with a clear line | **fixed**: the script names the identity it needs and the README says to create a new cert on a second machine, never export the key |
| 3 | `conch setup` | forgetting `--no-service` installed a launchd daemon next to the app's; two daemons fight over the socket and the mic | **fixed**: `conch setup` sees `/Applications/conch.app`, leaves the daemon to it, and prints why; `--service` forces the launchd service |
| 4 | the app adopts a daemon started from a terminal, and that daemon dies | the window kept saying "Running — started outside this app" over a dead socket | **fixed** (A2): the app polls an adopted daemon and starts its own within 3 s |

## Path 3 — Phone

| step | what they type or see | goes quiet when | state |
|---|---|---|---|
| 1 | Settings → Phone app | `phone` defaults off, so the first thing a new machine shows is an error — and until today the tab reported it as "Could not read the daemon's pairing reply" | **fixed** in part (A15): the tab shows the daemon's own words and the exact `conch set phone true`. **Open, Tyler's call**: default `phone` on, or turn it on when the tab is opened |
| 2 | scan the QR | the QR only exists with a relay, and `phone-relay-url` is empty on a fresh machine; the Worker URL lived only in the old Mac's settings | **fixed** in part: the tab names the setting and the command. **Open, Tyler's call**: ship the deployed relay URL as the default so a fresh install gets a QR with no setup |
| 3 | the phone connects | the pairing is one-per-phone; pairing a new Mac silently un-pairs the old | **fixed**: before saving a different Mac the phone asks "Replace <current host or relay endpoint>?" with Replace / Keep current; the same Mac with a fresh code needs no prompt. Still one pairing per phone — holding two Macs is the two-Mac work (roadmap C9), not this |

## Two Macs: how to try it

Both Macs run the conch app (it hosts the daemon) with `phone` on, on the same
LAN. Call them A (the one you are sitting at) and B.

1. **Pair.** On B: Settings → Phone app; note the host and the six-digit code.
   On A: Settings → Phone app → Other Macs → "Add another Mac…", enter B's
   host, port (8674) and the code. B's sessions appear under B's host in A's
   ledger; typed sends already work from here.
2. **Take it.** Each Mac starts local: both speak and listen for their own
   sessions, exactly as before. Once B is online in A's ledger, A's window
   shows "<B host> speaks for itself — Take it". Press **Take it** on the Mac
   in front of you. From then on B's window shows "Controlled by <A host> —
   Take it", and pressing that moves the voice back the other way.
3. **What you should hear where.** After A takes it: B stops mid-word if it
   was reading, B's mic closes, and B's window dims its composer mic and the
   Auto/Manual control. A's window shows "You hold audio · <B host> is
   silent". When a session on B finishes a turn, A rings no bell for it but
   speaks the announcement, labelled "<B host> · <session>", in that
   session's voice. A recite on B is spoken on A; a wake on B is refused in
   B's log. B's own sessions still show every state change in B's window,
   and typing into them on either Mac works as before.
4. **Giving it back.** Press Take it on B (or "Give it back" on A). If A's
   app quits or loses the LAN, B speaks again by itself within 90 seconds.
   A phone paired to B still wins on B: while the phone holds B's audio, B's
   announcements go to the phone, not to A.

## The minimum, if the two open decisions go the simple way

Brew path: `brew install stupart/tap/conch`, allow the microphone, scan the
QR. Three things a person does; everything else is conch's job. That needs
`phone` on by default and a default relay URL — both are one-line changes
waiting on Tyler, because the relay is his Cloudflare account and the LAN
port is a choice about what listens on a laptop.

## What this map is not

It is not a promise of an installer or a DMG. The brew formula ships the app
inside the tarball already; the journey problem was never packaging, it was
the five places where nothing said what to do next. Fix those in place.
