# How I work on conch

## What this is

conch is a voice loop for Claude Code. Sessions announce themselves aloud when
they finish a turn, the mic opens, and what you say goes back into that
session. Three surfaces share one daemon:

- **the daemon** (Bun/TypeScript) — hooks, speech, the mic, session state
- **the Mac app** (SwiftUI) — the ledger and the reply pane, its main UI
- **the iPhone app** (SwiftUI) — the same ledger anywhere, over an end-to-end
  encrypted Cloudflare relay, transcribing on the phone

The point is working away from the desk. That makes the phone the demanding
surface and the reason most bugs matter.

**Where it stands:** the loop works, the relay works over cellular, and the
current push is quality — the reply pane should become a live conversation
with artifacts rendered inline, not one string that gets replaced.

## The rule

**Don't stop at the first plausible cause. Stop when the thing works, observed.**

## The loop

1. **Reproduce** — get the failure to happen, or find it in a log. No repro, no fix.
2. **Measure** — print the actual value at the actual boundary. Not the code path I
   believe runs; the number that comes out.
3. **Fix the root**, not the symptom. If two things disagree, ask which is right
   before changing either.
4. **Verify by the same measurement** that showed the failure. A passing test
   suite is not verification unless the test would have failed before.
5. **If it isn't observed working, say so.** "Should work" is not done.

Repeat 1–5 until the observation is clean. Then take the next item.

## The queue

Work the top item until it is observed working, then take the next. One at a
time — the failures below all came from moving on while something was still
"probably fine". Full backlog in ROADMAP.md (local, ~48 items); this is the
order.

1. **Phone won't pair from the Mac QR.** Blocks the phone entirely. Known: QR
   content correct, Worker healthy, room accepts a phone, daemon socket real.
   Unknown: why the handshake never completes. Needs iOS-side logging.
2. **TestFlight.** The build on the phone is a devicectl development install
   and EXPIRES on its own — this one has a deadline nothing else has.
3. **Review rows never appear.** `conch:review` parses, but no row. Pause is
   NOT the cause. Next step is logging what the Stop hook actually parses.
4. **The conversation surface.** Reply pane becomes a live conversation, with
   `conch:/path` and `conch:link.com` markers rendering artifacts inline. The
   viewers already exist. Biggest quality win; fixes three complaints at once.
5. **Reply collapses to its first paragraph** when a new turn starts.
6. **"Delivered" is a lie** when the Mac fell back to the clipboard — the
   draft clears and the words are only on the clipboard.
7. **Resume one session out of a global pause.** Needs an exemption checked
   ahead of the global gate.
8. **Auto-open the session that is speaking.**
9. **Pluggable voice engines** — local default, plus OpenAI / xAI / ElevenLabs
   for both transcription and speech. The system voice is the loudest quality
   problem left.
10. **Ship it** — Homebrew release past v0.2.1, images from the phone, an
    icon, a landing page.

## Rules earned the hard way

- **A green suite proves nothing about a bug it never covered.** Mutate the fix;
  if no test fails, the test is decoration.
- **Verify the change reached the thing being tested.** Wrong build on the phone,
  stale daemon, a `perl` edit that silently didn't apply, a mutation that never
  landed — each cost a false "fixed".
- **One fix, one caller, is half a fix.** `lastAssistantText` was fixed for the
  phone and left broken for reviews. Grep every caller.
- **Fixing a label without its action makes a confusing control a lying one.**
- **Duplicate sources of truth are the bug.** Two frames sizing one window, two
  daemons on one socket, two build paths making apps, a label and an action
  reading different state.
- **Don't trust a container to describe its contents.** `has-session` isn't
  liveness; an open socket isn't a live peer; a `.app` on disk isn't the running
  process.
- **When the user reports it four times, my model is wrong** — not their
  description. Re-read their exact words; they said "deleted the entire thing",
  not "lost some".
- **Say what I did NOT verify.** Every unverified claim I've made has come back.

## For UI

Show it before committing to a direction. Two attempts at the settings column
happened because I reasoned about alignment instead of looking at it.

## Codex

Its tests encode its design, not our decisions. Read the diff myself, check it
against what we chose on purpose, and verify the base it forked from.
