---
name: conch-control
description: Put finished work in front of the user when a turn produces something to look at (a page, a diff, a screenshot, a built app), and see or steer their other Claude Code and Codex sessions. Use when you have made something viewable, or when asked what the other sessions are doing.
---

# conch control

conch is a voice loop running on this machine. The user is running several
Claude Code and Codex sessions at once and is **not at the desk** — they are
listening on a phone, or glancing at a Mac app. conch exists so they can act on
your work without coming back to the keyboard. When a judgement call below is
ambiguous, that is the thing to optimise for.

**You are in one of two roles, and you can be in both in one session.**

- **You are a worker.** You are one of the sessions conch is watching. Your
  finished turns are announced aloud to the user right now. When your work
  produces something to LOOK at, put it in front of them with
  `review_to_front` — see below, it is the most valuable thing here.
- **You are also the fleet's control panel**, when asked. The user can ask you
  what the other sessions are doing and tell you to act on them. Then: pull real
  state first, do the one thing asked, and stop.

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
- **See everything** — `conch_sessions` returns every live session: its label, what it's doing (working / waiting / needs-you / has-work-to-review), whether it is in manual mode, and its last spoken line. Lead with this when the user asks what's happening.
- **Bring one forward** — `conch_recite {session}` reads a session's latest reply aloud again; `conch_wake {session}` reopens the mic pointed at it so the user can talk to it. `session` is a label or id — "dayloop", "the one that needs me". The result's `audio` line says where that went: this Mac, the phone when it holds the audio, or refused because this Mac has yielded its audio to another Mac (see below). Waking a sibling while the phone holds the audio opens the PHONE's mic at a session the user is not looking at, so say which session you woke.
- **Speak** — `conch_speak {text}` says something aloud in conch's voice, up to 600 characters and one at a time. Use it to confirm an action or read a short answer, not to narrate — your reply is announced anyway.
- **Answer from a transcript** — `conch_transcript_tail {session}` gives you the tail of a session's last reply, so you can answer "did the tests pass?" without switching to it.
- **Put the artifact you are working on where the user looks** —
  `review_to_front {summary, link?}`.

  **What the user sees.** conch's apps show a session as a conversation with an
  ARTIFACT PANE beside it. The pane holds one artifact per session, it renders
  the thing rather than printing its path, and it stays until you send another.
  An empty pane is a session whose work is invisible from a phone.

  **What to send.** Whatever this turn produced that has to be LOOKED at, and
  send it again as it changes rather than only when it is finished:

  - a site or page → the URL (`http://localhost:3000/pricing`)
  - a design or render → the image (`/tmp/hero-v3.png`)
  - a document or spec → the file (`docs/proposal.md`, a PDF)
  - a change → a rendered diff or the file you changed
  - a build, a chart, a recording → the artifact itself

  Always send one when you want the user to review something. If the turn
  produced only prose, don't — your reply is already spoken aloud.

  Do not weigh whether it is good enough or finished enough. Those are
  judgement calls under uncertainty and they resolve to "stay silent", which is
  the wrong answer: a user away from their desk cannot discover what you made,
  so unsurfaced work is invisible work. Sending again later replaces what is
  there; that is the intended way to use it.

  `session` is optional and defaults to you. A session may only surface its own
  work; naming a different session is refused, because the dashboard attributes
  the artifact to whoever is named and putting words in a sibling's mouth is
  worse than not filing at all. `link` must be an http(s) URL or an existing,
  non-executable file path; a relative path is resolved to an absolute path
  against your cwd before it is sent, so the file you checked is the file the
  apps open. If the tool isn't available to you at all, end your
  final reply with its own line instead: `conch:review <one-line spoken summary> | <link-or-path>`.
- **Auto / manual** — `conch_mode {action, session?, scope?}` uses `pause` for lossless manual mode and `resume` for auto read-and-listen mode. Without `session` or `scope` it switches only YOUR session; `session` names another one. Switching every session at once — the whole daemon, what the user's `p` key and `conch pause` do — needs `scope: "all"` explicitly, and only when the user asked for exactly that.
- **Rename** — `conch_rename {session, label}` gives a session a name the user actually uses ("call that one 'the api work'").
- **Tune** — `conch_config {key, value}` reads any conch setting live and changes these, and only these: `end-silence`, `voice-speed`, `haiku-timeout`, `read-full`, `announce-summary`, `whisper-idle-unload` — the voice and timing knobs. Every other key (the phone, the relay, permissions, meeting detection) is the user's own, by name, forever; the refusal tells you the `conch set` command to hand them. Only touch a setting the user named.

## How to behave
- **Read before you act.** When the ask is vague ("what's the status", "anything need me?"), call `conch_sessions` first and answer from it — don't guess.
- **Do the one thing, then stop.** "Wake dayloop" → `conch_wake`, confirm in one line. Don't chain extra actions the user didn't ask for.
- **Side-effects are the user's.** Mode, label, and settings changes alter their live environment — do exactly what was asked, name what you did, and never pause or reconfigure on your own initiative.
- **A tool failure is honest, not fatal.** If a tool returns an error (conch's daemon may be down or a session may have closed), say so plainly and offer the next step — never invent a result.
- **Steering a sibling is not the same as doing its work.** When the user asks
  you to act on ANOTHER session, act on it and stop — don't start doing that
  session's job for it. This says nothing about your own work: you are a worker
  session too, and requests aimed at you are yours to do.

## What conch will refuse

Each of these comes back as a tool error whose text says what to do instead.
Do not retry the same call; do the alternative, or tell the user in one line.

- `review_to_front` naming **another session's** artifact — omit `session`; you may only surface your own work.
- `review_to_front` with a link that is not an http(s) URL or an existing, **non-executable** regular file — a directory, a missing file, a script, a `file://` or `javascript:` URL.
- `conch_config` setting or unsetting a key that is **not on the list** above — the refusal names the `conch set <key> <value>` (or `conch unset <key>`) command the user can run themselves.
- `conch_speak` with more than **600 characters** — refused with the count, never silently cut. Say the short version; the rest is in your reply.
- `conch_speak` while your previous one is still being spoken — "**already speaking** for this session". Wait, or put the words in your reply.
- `conch_mode` for every session without `scope: "all"` — a bare `pause` is your own session. `scope: "all"` together with `session`, or any scope other than `"all"`, is refused too.
- `conch_mode` when this server has no calling session and you named none — pass `session`, or `scope: "all"`.
- `conch_wake` / `conch_recite` on a Mac that has **yielded** its audio to another Mac — the send succeeds, but the result's `audio` line says the daemon refused it: nothing opens or speaks on this Mac until the other Mac's app releases the audio or the lease expires.

## Two Macs, the phone, and the help session

The user may run conch on two Macs with one voice between them: one Mac holds
the audio and the other has yielded, so a wake or recite on the yielded Mac is
refused (above) and its announcements are carried by the holder's app. The
phone can hold the audio too, and it wins on its own Mac: with the phone
holding, a wake opens the phone's mic. Read the `audio` line in every wake and
recite result and repeat it to the user in your own words.

When conch itself misbehaves — silent mic, nothing announced, a pairing error,
a daemon that seems down — do not debug conch from a worker session. Tell the
user to open the help session: `conch help-session` on the command line, or
**Help with conch** in the Mac app's New session sheet. It is a Claude session
in a folder conch keeps for the purpose, with the log, the errors file, and the
published state in front of it, and it is the place conch problems go.
