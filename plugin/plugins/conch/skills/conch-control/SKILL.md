---
name: conch-control
description: Control conch — see and steer your other sessions by voice.
---

# conch control

You can see and steer the user's other Claude Code / Codex sessions through conch — a voice loop running on this machine. Those sessions announce their finished turns aloud; you are the one the user talks to *about* them. Use these tools to answer "what's going on?" and to act on it. Prefer showing over telling: pull real state, then do the one thing asked.

## If the conch tools aren't there

The plugin is a thin client — it ships this skill, an MCP declaration, and a
launcher. **It does not install conch itself**, which is a separate Homebrew
package that carries the daemon, the CLI, and the macOS app.

So if you have no `conch_*` tools at all, or they fail with *"could not find the
conch binary"*, conch simply isn't installed on this machine. Don't report that
as a broken plugin, and don't make the user go read a README — say what's
missing in one line and **offer to install it**:

> conch itself isn't installed yet — the plugin is just the remote control. Want
> me to install it? It's `brew install stupart/tap/conch && conch setup`, which
> also sets up the desktop app.

**Ask first and wait for a yes** — this installs software, downloads a speech
model, and wires hooks into their Claude Code config. Never run it unprompted.
On a yes, run the two commands, then tell them to restart Claude Code so the
MCP server loads. If Homebrew is missing, say so and point at
https://brew.sh rather than trying to install Homebrew yourself.

## What you can do
- **See everything** — `conch_sessions` returns every live session: its label, what it's doing (working / waiting / needs-you / has-work-to-review), whether it's paused or muted, and its last spoken line. Lead with this when the user asks what's happening.
- **Bring one forward** — `conch_recite {session}` reads a session's latest reply aloud again; `conch_wake {session}` reopens the mic pointed at it so the user can talk to it. `session` is a label or id — "dayloop", "the one that needs me".
- **Speak** — `conch_speak {text}` says something aloud in conch's voice. Use it to confirm an action or read a short answer, not to narrate.
- **Answer from a transcript** — `conch_transcript_tail {session}` gives you the tail of a session's last reply, so you can answer "did the tests pass?" without switching to it.
- **Surface finished work for the user's sign-off** — Call `review_to_front {summary, session, link?}` when a deliverable is DONE, you have already critiqued it yourself (with design/review agents if you have them), and it's ready for the user's *final approval before it goes live* — a page, a diff, a rendered result, a build they should actually look at. It brings the work to the front of the user's screen and opens `link` (an http(s) URL or an existing, non-executable file path). This is an approval gate, NOT routine "I finished" and NOT every iteration — conch already announces finished turns, so surface sparingly: only what you'd stake your own approval on. `session` is required and must name the WORKER whose deliverable it is; it must not name the caller. A session surfacing its OWN finished turn should end its reply with the `conch:review <summary> | <link>` marker instead (its Stop hook would otherwise overwrite a self-issued tool review).
- **Quiet / hold** — `conch_mode {action}` mutes, unmutes, pauses (holds finished turns to replay on resume), or resumes everything.
- **Rename** — `conch_rename {session, label}` gives a session a name the user actually uses ("call that one 'the api work'").
- **Tune** — `conch_config {key, value}` reads or changes a conch setting live (e.g. `end-silence`, `voice-speed`, `haiku-timeout`). Only touch a setting the user named.

## How to behave
- **Read before you act.** When the ask is vague ("what's the status", "anything need me?"), call `conch_sessions` first and answer from it — don't guess.
- **Do the one thing, then stop.** "Wake dayloop" → `conch_wake`, confirm in one line. Don't chain extra actions the user didn't ask for.
- **Side-effects are the user's.** Muting, pausing, renaming, and settings changes alter their live environment — do exactly what was asked, name what you did, and never pause/mute/reconfigure on your own initiative.
- **A tool failure is honest, not fatal.** If a tool returns an error (conch's daemon may be down or a session may have closed), say so plainly and offer the next step — never invent a result.
- **You are not the worker sessions.** You observe and steer them; you don't do their coding. If the user wants work done, point them at (or wake) the right session.
