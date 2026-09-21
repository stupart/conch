---
name: conch-control
description: Publish a meaningful result for the user to inspect with review_to_front, and see or steer their other Claude Code and Codex sessions when asked. Use when you have a result worth inspecting, or when asked what the other sessions are doing.
---

# conch control

conch is a voice loop running on this machine. The user is running several
Claude Code and Codex sessions at once and is **not at the desk** — they are
listening on a phone, or glancing at a Mac app. conch exists so they can act on
your work without coming back to the keyboard. When a judgement call below is
ambiguous, that is the thing to optimise for.

**You are in one of two roles, and you can be in both in one session.**

- **You are a worker.** You are one of the sessions conch is watching. When
  you have a meaningful result or something the user should inspect, publish it
  with `review_to_front` — see *Publishing results* below.
- **You are also the fleet's control panel**, when asked. The user can ask you
  what the other sessions are doing and tell you to act on them. Then: pull real
  state first, do the one thing asked, and stop.

## Publishing results

conch connects this session to the user’s Mac workspace, floating overlay, and iPhone.

When you have a meaningful result or something the user should inspect, call `review_to_front` with a short summary and the best artifact link. For a written explanation, request a conversation scene (`scene: {v: 1, target: {kind: "conversation"}}`) and keep the complete explanation in your normal reply.

Publishing makes the result available. The user chooses when to open it. Do not open applications, rearrange windows, or start the microphone as a publication side effect. Publish again when the result materially changes, not after every edit.

Omit `session` when publishing. Never attribute work to another session or invent surface references.

If your work is in a folder other than the one this session started in, say so once with `conch_working_folders`; conch’s file tree and sidebar follow it.

For user-requested session, audio, or settings control, load the `conch-control` skill, inspect current IDs with `conch_sessions`, and perform the requested action. Respect manual mode and report refusals.

If publication is unavailable, leave the result in your reply. Where supported, use one final `conch:review <summary> | <link>` line; do not retry under another session’s identity.

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
- **See everything** — `conch_sessions` returns every live session: its id, label, what it's doing (working / waiting / needs-you / has-work-to-review), whether it is in manual mode, and its last spoken line. Its `caller` says whether conch verified which session YOU are (`verified`, with your id), or `unverified` with the reason. Lead with this when the user asks what's happening.
- **Hear or answer one, at the user's request** — `conch_recite {session}` reads a session's latest reply aloud again; `conch_wake {session}` reopens the mic pointed at it so the user can talk to it. Both are audio: neither opens its workspace or stages a scene. `session` is an id or a label — prefer the id from `conch_sessions`. A name that fits more than one session is refused with the candidates; a partial name that fits one resolves, and the result names the session it reached. Omit `session` for your own session, which works only when your `caller` is verified. The result's `audio` line says where that went: this Mac, the phone when it holds the audio, or refused because this Mac has yielded its audio to another Mac (see below). Waking a sibling while the phone holds the audio opens the PHONE's mic at a session the user is not looking at, so say which session you woke.
- **Speak** — `conch_speak {text}` says something aloud in conch's voice, up to 600 characters and one at a time. Use it to confirm an action or read a short answer the user asked for; do not repeat your reply or narrate progress.
- **Answer from a transcript** — `conch_transcript_tail {session}` gives you the tail of a session's last reply, with the id and label of the session it read, so you can answer "did the tests pass?" without switching to it.
- **Publish a result for the user to inspect** —
  `review_to_front {summary, link?, scene?}`. *Publishing results* above says
  when; this is how.

  **What the user sees.** conch files the result on your session in the Mac app
  and on the iPhone, and the Mac's Ready pill lights. Nothing opens until the
  user clicks the pill, which brings the scene forward. A newer publication from
  your session sits beside the older ones as another tab; one with the same link
  becomes a newer version of that artifact instead — the user sees the newest,
  with the earlier versions listed under it by summary and time.

  **What to link.** The best single artifact for the result:

  - a site or page → the URL (`http://localhost:3000/pricing`)
  - a design or render → the image (`/tmp/hero-v3.png`)
  - a document or spec → the file (`docs/proposal.md`, a PDF)
  - a change → a rendered diff or the file you changed
  - a build, a chart, a recording → the artifact itself

  **The scene.** Optional: `scene: {v: 1, target: {kind}, inspect?}`.

  - `kind: "auto"`, the same as no scene: the link, else conch's window on your
    session if it is open, else your terminal, else conch's window.
  - `kind: "link"`: the link, falling through only if it fails to open. It
    needs a `link`.
  - `kind: "conversation"`: conch's window on your session, even when there is
    a link. Use it for a written explanation, and keep the complete explanation
    in your reply.
  - `kind: "terminal"`: your terminal, else conch's window.
  - `inspect`: one short line, at most 200 characters, naming what to check
    ("Check that Save stays reachable at phone width"). The pill's tooltip and
    the iPhone show it.
  - `target.ref` is reserved for surface references conch will issue later and
    is not accepted yet.

  `session` is optional and defaults to you. A session may only surface its own
  work; naming a different session is refused, because the dashboard attributes
  the artifact to whoever is named and putting words in a sibling's mouth is
  worse than not filing at all. Publishing needs a verified `caller`: when conch
  cannot tell which session you are, it is refused whatever `session` says. A
  Codex thread is verified by the thread id Codex sends with each call; an
  older Codex that sends none, from an app-server hosting many threads under
  one process, is not. `link` must be an
  http(s) URL or an existing, non-executable file path; a relative path is
  resolved to an absolute path against your cwd before it is sent, so the file
  you checked is the file the apps open. A file is sent to the phone, so it must
  sit under your cwd or a temp folder (`/tmp`), and not be hidden, in a hidden
  folder (`~/.ssh`, `~/.config`, `.env`; a repo's `.worktrees` is fine), or a
  key or certificate. If the tool isn't available to you or refuses you as
  unverified, end your final reply with its own line instead: `conch:review <one-line spoken summary> | <link-or-path>`.
- **Auto / manual** — `conch_mode {action, session?, scope?}` uses `pause` for lossless manual mode and `resume` for auto read-and-listen mode. Without `session` or `scope` it switches only YOUR session; `session` names another one. Switching every session at once — the whole daemon, what the user's `p` key and `conch pause` do — needs `scope: "all"` explicitly, and only when the user asked for exactly that. A `resume` from an agent is refused while the user put conch in manual themselves (the `p` key, the Mac's toggle, `conch pause`) — only a person undoes a person's pause, and a `conch_speak` is held then too: not spoken and not queued, and its result carries `held` saying so.
- **Rename** — `conch_rename {session, label}` gives a session a name the user actually uses ("call that one 'the api work'").
- **Say where you work** — `conch_working_folders {folders}` names the folder(s) you are actually working in when they differ from where the session started; conch's file tree, file viewer and sidebar grouping follow them. Once is enough; say it again only if you move.
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
- `review_to_front` from a caller conch **cannot verify** — leave the result in your reply, or use the `conch:review` line.
- `review_to_front` with a link that is not an http(s) URL or an existing, **non-executable** regular file — a directory, a missing file, a script, a `file://` or `javascript:` URL — or a file **outside your cwd and the temp folder**, hidden, or a key or certificate.
- `review_to_front` with a **scene** that is not `v: 1`, has an unknown kind or field, asks for `kind: "link"` with no link, has an `inspect` that is empty or over 200 characters, or carries `target.ref` — the refusal says which; fix the scene or omit it.
- A `session` name that **matches several sessions** — the refusal lists them by id and label; pass the id.
- `conch_wake` / `conch_recite` **without `session`** when your caller is unverified — pass the session's id.
- `conch_config` setting or unsetting a key that is **not on the list** above — the refusal names the `conch set <key> <value>` (or `conch unset <key>`) command the user can run themselves.
- `conch_speak` with more than **600 characters** — refused with the count, never silently cut. Say the short version; the rest is in your reply.
- `conch_speak` while your previous one is still being spoken — "**already speaking** for this session". Wait, or put the words in your reply.
- `conch_mode` for every session without `scope: "all"` — a bare `pause` is your own session. `scope: "all"` together with `session`, or any scope other than `"all"`, is refused too.
- `conch_mode` when this server has no calling session it can verify and you named none — pass `session`, or `scope: "all"`.
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
