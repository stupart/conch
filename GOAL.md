# How I work on conch

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

Repeat 1–5 until the observation is clean. Then stop.

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
