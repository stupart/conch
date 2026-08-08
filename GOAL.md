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
time — every failure in the rules below came from moving on while something
was still "probably fine". Fuller notes in ROADMAP.md (local, ~48 items).

**1. The phone pairing is unreliable.** *(hardening + logging + UX done;
awaiting one real background→foreground observation)*
It has worked — a dictated message went from the phone over cellular, through
the relay, into a live session. But it does not work *consistently*: it
disconnects on its own, sometimes will not reconnect, and a fresh pair from
the Mac's QR left the phone stuck on "Looking for your Mac". Two causes are
known and fixed (the Mac's relay socket dying silently when the laptop slept;
the daemon running stale code), which means the remaining failures have a
different cause that has not been found. Three things were needed, and all three are in:
- **Hardening** — the phone's 10s heartbeat is a Task that iOS suspends on
  background, so the Mac's 30s liveness window always expired about half a
  minute after backgrounding. Dropping is correct (audio hands back); not
  re-dialling on return was the bug. `.active` now reconnects BEFORE claiming
  audio, since a claim over a dead socket does nothing.
- **Logging** — the Mac now says "phone paired — session established" and
  reports a REJECTED hello. Before, a failed pairing and a phone that never
  dialled were indistinguishable: relay connected, then silence.
- **UX** — "Looking for your Mac…" now only appears before a pairing has ever
  worked; after that a drop reads "Reconnecting…", with advice that matches
  which of the three situations it is.

Verified: two "phone paired" lines at 13:40 after the fix, and on 2026-08-07
Tyler held an entire working conversation from the phone — many turns, over
minutes, no drop. That is the strongest evidence yet, though still not a
deliberate background→foreground cycle watched end to end.

**2. Ship the iPhone app through TestFlight.**
The build on the phone was installed over USB as a development build. Those
expire — a week on a free account, a year on a paid one — and then simply stop
launching, whether or not anything new is shipped. TestFlight replaces that
with real installs that auto-update and last 90 days. This is the only item
with a deadline that arrives on its own.

**3. `conch:review` never produces a review row.** *(FIXED and observed
2026-08-07 — two separate causes, one found only after the first "fix")*
An agent can end a reply with `conch:review <summary> | <link>` to flag work
for a human look. The marker parses correctly, and the row is meant to show a
gold star with that summary. No row ever appears. Two candidate causes were
investigated and ruled out — pause is not responsible (reviews latch before
the pause gate), and the text source was fixed to read the whole turn. The cause, found only after the hook was made to write down what it saw:
**Stop fires before Claude Code flushes the final assistant message**, so the
marker — written on the last line of the last message — was never in the file
at parse time. Three earlier attempts each fixed something real (pause was
blamed and innocent; the parser was correct; the text source was changed) and
none could have worked. The hook now waits for the turn to land, bounded to
about a second.

That was real but not sufficient — Tyler still saw no row, on either app, and
reasonably suspected the switch from the marker to the `review_to_front` tool.
The tool was innocent: both paths produce the same latched review, and it was
being filed correctly every time. Two more things were destroying it after the
fact, both of the same shape — an unrelated later event outliving the review:
- **Its own Stop hook.** A review-less `turn-end` REPLACED the whole latched
  record a second after filing. Since the tool only permits surfacing your OWN
  work, this made it unusable for its only legal use, and the plugin documented
  the marker as the workaround for a tool that could not keep its own result.
- **The registry catching up.** The row only rendered a review while status was
  exactly `waiting`, but the registry outvotes the latch when newer — and a
  session that just filed a review is sitting waiting for the user, which
  Claude Code registers as blocked, i.e. `needs`. The star showed only until
  the next registry refresh.

Measured live, before: latched 19:27:36 visible, gone 19:29:26 on the flip to
`needs`, review still untouched in the latch. After: latched 20:23:16, still
present at 20:24:29 through that same flip, cleared only at 20:25:28 when a new
turn began. A review now survives until its session goes back to work — one
rule, applied in both places.

**4. Rebuild the reply pane as the whole conversation.**
Today each app shows ONE reply, replaced wholesale every turn — which is why
answers appear as random fragments, why the beginning of long replies goes
missing, and why the previous reply vanishes when a new turn starts. It should
be the actual conversation stack, the way the terminal shows it: every message
in order, tool calls included, scrollable, live as it is written.

**5. Render the end product inline, not a path to it.** *(deliverable
ROUTING fixed on both apps; the inline surface is still to build)*
Both routers now agree — video plays, a local page renders as a page, and an
unpreviewable file says so instead of printing bytes. What remains is the
inline part: today an artifact opens in a sheet, not in the conversation.
When an agent produces something — a web page, an image, a PDF, a document —
writing `conch:` before the path or URL should make the app RENDER it inside
the conversation, expanding when clicked. Anything not marked stays plain
text. Today a link is printed as a dead string even though both apps already
contain working viewers for web, image, PDF, markdown and text. The first
thing this should be used for is conch's own documents: `conch:GOAL.md` and
`conch:ROADMAP.md` opening in the Mac app and on the phone, so the plan can be
read from either surface — which also makes the feature dogfood itself.

**6. A new turn hides the previous reply.**
When a session starts working, everything except the first paragraph of the
last reply disappears. The pane falls back to the short spoken announcement
instead of keeping the full text it already had.

**7. "Delivered" is reported when the words went to the clipboard.**
If the Mac cannot confirm it typed a dictated message into the session, it
falls back to putting the text on the clipboard — and still tells the phone
"delivered", so the phone clears the draft. The message is then only on the
clipboard, and the person who dictated it believes it was sent. This cost a
real message. Needs a true acknowledgement plus retry.

**8. One session cannot be resumed while the rest stay paused.** *(FIXED,
tested, not yet used in anger)*
An exemption set is checked ahead of the global gate: resuming a session by
name while conch is paused lets it speak while everything else stays held.
Pausing that session revokes it; any global edge clears the set.

**9. Open the session that is speaking.**
When a reply is read aloud, the app should move to that conversation, instead
of leaving you to work out which of several sessions is talking.

**10. Let people choose the voice and the transcriber.**
The default macOS voice is poor and is the loudest remaining quality problem.
Both speech and transcription should be pluggable: a free local default, a
choice of local models on the Mac, and optional API backends (OpenAI, xAI,
ElevenLabs) for anyone who wants better.

**11. Make it installable and presentable.**
A Homebrew release past v0.2.1 so `brew upgrade conch` updates the app;
sending images from the phone; an icon; a landing page.

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

Codex does the backend-heavy work well and cheaply, but it has NONE of the
context above — it did not hear the complaint, see the screenshot, or make the
decision. Whatever I know that shaped the task has to be written into the
prompt; it cannot be assumed and cannot be inferred from the code.

So: state the symptom in the reporter's own words, the evidence already
gathered, what was ruled out and how, the decisions that are NOT open for
redesign, and what "done" is measured by. Then check the diff myself against
those decisions.

Its tests encode its design, not our decisions — a green suite from Codex
proves it did what it set out to do, not what we asked for. It has already
shipped a branch that passed its own tests while missing two fixes, because it
forked from a stale base. Verify the base, read the diff, run the checks
myself.
