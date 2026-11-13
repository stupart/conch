# Failure tickets

Tyler, 2026-10-28, right after an Allow he tapped silently failed to reach its session: *"there should prob be a loop
where a ticket is opened for any agent fail or something"*. That Allow left one line in `/tmp/conch-daemon.log`
(`error handling inject "…": Error: Account profiles must have separate directories`) and nothing anywhere else.

The loop is **failure → record → ticket → Fix → PR → fixed**, and back to open if it comes again. The code is
`src/failure-tickets.ts` (the desk), `src/failure-signature.ts` (grouping) and the Mac app's Settings › Failures.

## The journey

1. Something lets Tyler down: an Allow that never reached its session, a message on the clipboard, a background
   session that never checked in, a `conch_capture` that failed. conch writes one structured record of it.
2. The daemon's desk reads the record within a few seconds and files it under a ticket: a new one, or the ticket that
   already holds the same failure (count + 1, the session added, the example replaced by this newer one).
3. A new ticket of conch's own puts a small dot on the header's gear and beside Settings › Failures. One that matters
   (a delivery that failed, one seen a third time, one back after its fix) also gets a line in the Mac's window until
   it is seen (see "Showing it"). Opening Failures clears both.
4. Tyler reads the ticket (what failed, how often, in which sessions, the latest example with its evidence) and
   presses **Fix**, or **Ignore**.
5. Fix starts a background Claude session in the conch checkout, on the Default account, through the daemon's own
   session-start path. Its first message is a brief built from the ticket. The ticket shows *Fixing*.
6. The session works in a worktree on `fix/ticket-<n>`, adds a regression test and opens a PR. The desk finds the PR
   by its branch and links it. It never merges.
7. Tyler merges. The desk sees the PR merged and marks the ticket *Fixed*. If the same failure is seen again by a
   daemon started after the merge (that is, after the deploy), the ticket reopens, with its old PR still linked.
   Any PR, from a fix session or not, that says `Fixes ticket #12` in its description does the same for #12.
8. A ticket nothing happens to goes quiet after two weeks with no occurrence, and opens again if it comes back.

## Capture: one path

Every failure record goes through `appendConchError` into `~/.config/conch/errors.jsonl`, as the daemon's, the Mac
app's and the phone's already did. MCP tool calls keep their own log, `mcp-usage.jsonl`, which the MCP server process
writes itself (sessions run the MCP server they started with, so the daemon reads that file rather than asking every
server to change). The desk reads both, from a saved offset, every 5 s; a record written by the daemon pokes it at
once.

What is newly captured, which before reached only the text log, a spoken line, or nothing:

| Where | Operation | Before |
|---|---|---|
| Any queued or immediate daemon event that throws (interrupt, session-start, a turn; an inject files its own throw where it happens since #574, as `permission-answer`, `question-answer` or `inject`): today's Allow | the event's type, `threw: true`, top of the stack | log line only |
| A publication that throws while being filed | `review-filing` | log line only |
| An inject the daemon refuses because its target isn't a live session (the Mac app drops that reply) | `inject` | log line only, nothing on screen |
| A background session conch could not bring back after its tmux server stopped | `session-restore` | log line only |
| The Terminal button, or Open in Codex, failing | `terminal-focus`, `session-open-app` | log line only (the phone reported its own) |
| Interrupting a session conch couldn't reach | `interrupt` | log line and a spoken line |
| Repairing an account's hooks failing (every prompt there then errors) | `hook-repair` | log line only |
| Codex's watch failing (turn ends and approvals stop being seen) | `codex-watch`, at most once an hour per message | log line only |
| A hook that couldn't reach a daemon whose socket is there (crashed, or too busy to accept in 500 ms) | `hook` (source `hook`) | nothing: the hook is a short-lived process with no log |
| The Mac's New session sheet: a session that never checked in | `session-start` (source `mac`) | a notice on the sheet only |
| Every MCP tool call that ended `failed`, `refused` or `input-error` | the tool's name (origin `mcp`) | `mcp-usage.jsonl` only, never a ticket |
| Every `conch agent` command that ended the same way, in a shell or through `conch_run` (2026-11-11) | the tool's name it runs (origin `mcp`; its line says `via: "cli"` or `"run"`) | new |
| A bug filed by hand with `conch bug` (2026-11-11) | its area (origin `bug`) | nowhere: the agent's reply, at best |

Not captured, on purpose:

- **Errors a runtime request answers with** (session start/close/fork, account calls that throw in the daemon). The
  Mac app and the phone already report these themselves; recording them in the daemon too would make two tickets for
  one failure. The CLI prints them where you typed, and an MCP call's failure is in `mcp-usage.jsonl`.
- **Agents' own tool calls** (Bash, Edit, …): they live in each agent's transcript, not in conch.
- **The phone's own uncovered paths** (a control post that fails, a delivery whose outcome is unknown): iOS is out of
  this cut.
- **Deliberate non-deliveries**: a send interrupted by Tyler himself, text staged for an explicit send.
- **Outcomes that are told, and are no failure of conch's** (2026-11-11; a quarter of conch's own tickets were these).
  The record stays in `errors.jsonl` for diagnosis; the desk files no ticket (`notAFailure` in `src/failure-triage.ts`):
  - a send that went in after all: a Return re-sent, a Codex turn started before its prompt was written down, a new
    session Claude Code started from that window (`state.code` `transcript-advanced`, `provider-turn-started`, …);
  - a send conch declined because a dialog or permission prompt was open, where a Return would have answered it
    (`session-awaiting-answer`, `session-awaiting-permission`);
  - a permission or question card answered after its prompt had gone (answered in the terminal, replaced, closed);
  - a close or restart that stopped because Claude Code asked before ending background tasks (Close again stops them).

  An open ticket filed before its kind was passed over goes quiet when the desk starts, saying why (`retiredByRule`).
- **Refusals the daemon tells on the row and doesn't file**: a model change refused because the session was busy,
  waiting on its user, or had unsent words in its prompt (`declined`). A model the session's picker doesn't list is
  still filed: conch offered it. The Terminal button's refusal is filed once for each session and reason.
- **Voice, TTS, mic and relay noise** (disconnects, engine warm-ups): none of it is an agent letting Tyler down.
- A hook that finds **no socket** (conch is off): that is a choice, not a failure.

## Tickets and signatures

A ticket groups records with the same **signature**: `origin · operation · message`, where

- **origin** is where it came from: `daemon`, `mac`, `ios`, `hook`, `mcp`, or `bug`;
- **operation** is the record's operation, for MCP the tool's name plus its outcome (`conch_capture failed`), and for a
  bug its area (`capture`, or `conch` when it names none);
- **message** is the record's message, normalized: URLs → `<url>`; absolute and `~` paths → `<path>`; UUIDs and hex
  ids → `<id>`; anything in quotes (session labels, page text) → `"…"`; file names → `<file>`; numbers → `<n>`;
  whitespace collapsed; then only its **first sentence**, at most 160 characters. The rest of a message is usually
  what conch saw (a page's headings, the recovered draft), which is evidence, not identity.

So `Couldn't find v0.4.0.md` and `Couldn't find clip.mp4` are one ticket; `message landed on clipboard
(system-dialog-blocking)` and `(front-window-changed)` are two, because the reason in brackets is a different cause.
For the same reason a send's generic `Could not deliver the prompt.` is filed with its receipt code in it,
`Could not deliver the prompt (clipboard-unpreservable).`: five causes had shared that one ticket.

## Triage

Tyler, 2026-11-11, of the 47 tickets open and none being fixed: *"what are we doing that the issues pile up? … do u see
the issues in the settings of the app?"* 25 of them were agents calling one of conch's tools wrong, listed with the 22
that were conch's own, under the same Fix and the same dot.

Each ticket has a **blame** (`src/failure-triage.ts`), worked out from its identity whenever the store is read, so a
rule changed there re-sorts the tickets already filed:

- **agent**: an MCP call conch answered correctly. Every `input-error` and `refused`, and a `failed` one whose words
  say the agent's target wasn't there (nothing matched, a stale ref, not a field), it was over a limit the tool states
  (the tab limit), the page or quote it named wasn't as it said, or the Mac app the tool needs was closed.
- **conch**: everything else: every record from the daemon, the apps and the hook, and an MCP call that failed any
  other way (a daemon that didn't answer, a target conch found and couldn't scroll to).

Agents' calls are the tools' to fix (their descriptions, the agent CLI), not Tyler's: they are listed after conch's
own, **grouped by tool**, never light the gear or the banner, are left out of the open count, and never start an
auto-fix. `conch failures` prints them the same way, and `--json` carries `blame` for each ticket.

A ticket keeps: its number (`#12`, for saying aloud) and a stable id (hash of the signature), status, first and last
seen, count, the 20 most recent affected sessions (id and label), **one example** (the newest occurrence: its time,
raw message, session, and its `state` evidence, bounded), whether it is unseen, and its fix (who started it, when,
the background session, the branch, the PR and its state).

**Status** is `open`, `fixing`, `fixed` or `ignored`. An open ticket can also be **quiet** (`staleAt`): no occurrence
for two weeks (`STALE_AFTER_MS`). A quiet ticket is out of the counts, the banner and auto-fix's queue, and folded in
Settings; its next occurrence opens it again, unseen, saying how long it was quiet. Quiet is a mark on an open ticket,
not a fifth status, so an older Mac app still reads the list.

| | a new occurrence | Fix | Ignore | the PR merges | the PR closes unmerged / the fix session ends with no PR |
|---|---|---|---|---|---|
| open | count + 1 | → fixing | → ignored | | |
| fixing | count + 1 | | → ignored | → fixed | → open, unseen |
| open (quiet) | → open, unseen, no longer quiet | → fixing | → ignored | | |
| fixed | → **open, unseen**, if seen by a daemon started after the fix merged; otherwise count + 1 | | | | |
| ignored | count + 1, stays quiet | → fixing | | | |

Tyler can also **Reopen** (ignored or fixing → open) and **Mark fixed** (no PR needed).

**The store** is `~/.config/conch/failure-tickets.json`, mode 0600, written whole through a temporary file and a
rename. On its first run the desk reads back 14 days of records, so the list starts with what is happening now, not
September.

## Bugs filed by hand

Tyler, 2026-11-11: *"Also tool for them to submit bugs if possible."* What conch records is what conch saw; an agent
sees more (a pill that never lit, a tab that opened under the wrong session, an answer that contradicts the page).
`conch bug "<title>" --happened "<what you saw>" --expected "<what should have>" [--area <word>] [--evidence <path or
line>]...` files it (`src/bug-report.ts`), from an agent's shell (`conch agent bug`, or the `conch_run` tool) or
Tyler's terminal.

- The CLI sends `bug-report` to the daemon, which writes the record through `appendConchError` (source `bug`: the
  title is its message, the area its operation, what happened, what was expected and the evidence its `state`) and
  polls the desk at once. So it is one record path like every other, and the answer gives the ticket's number:
  `opened` (a new ticket), `counted` (the same bug from another session, count + 1), `reopened` (a fixed one, back).
- Its session is the one conch verifies from the shell's process tree (`conch agent whoami`); a report from a shell
  conch can't tie to a session (Tyler's terminal) is filed under none, and says so.
- **Limits**, kept by who filed it, as `conch_notify`'s are: the same bug again within the hour is answered
  `duplicate` with its ticket, and more than 5 in an hour is refused.
- The daemon down: the CLI writes the record itself, as a hook does, and the desk files it at its next start; the
  answer says there is no number yet. A daemon from before `conch bug` (it answers the request as a malformed turn):
  nothing is written, since its desk would drop a record of an origin it doesn't know, and the answer says to file it
  again once conch is updated.
- A bug ticket's Fix brief says it is a report, not a record: reproduce it first.
- The phone bridge refuses `bug-report` (`MAC_APP_ONLY_DECODERS`): tickets are the Mac's.

## Showing it

**Settings › Failures** (mark: a ladybug), after Setup. conch's open tickets first (new ones marked with a dot), then
Fixing, then Fixed in the last 14 days, then agents' calls, a block for each tool (the tool called wrong most often
first); Gone quiet and Ignored folded under their counts. A row is the ticket's normalized message, and under it
`origin · operation · 32 times in 14 sessions · last 2h ago`; Fix on the right. Clicking a row opens it in place: the
example's time, message, session and evidence, the PR, and Ignore / Mark fixed / Reopen.

**Unseen** is a 6 pt dot: on the header's gear while any of conch's open tickets is unseen, and beside Failures in the
section list with the open count. Showing Failures marks every ticket seen.

**The banner** (2026-11-11). A dot on a gear was all a failure ever made, and 47 piled up behind it. A conch ticket
that matters (`alertWorthy`: a failure to deliver what Tyler said or tapped, one seen a third time, or one back after
its fix) is alerted once each time it opens: a line in the Mac's window, *conch bug #12: …*, with Show (Settings ›
Failures) and Later (seen). The desk also calls the daemon's `alert`, at most three a day, which writes the daemon's
log and sends *conch bug #12* with the ticket's title through `notifier` (notify-user.ts): a Mac notification, and a
push to the phone once a push key is set up. No sound.

The daemon publishes only `failures: {open, unseen, fixing, agents, alert?}` in its state; the list itself is a socket request
(`failure-tickets`), the Mac app's alone (the phone bridge refuses it, like the logins inventory).

## Fix, and its guardrails

**Fix** starts `claude` as a **background** session (`launchSession`, the path the New session sheet uses) in the
checkout the daemon runs from (`~/Projects/Conch` here), on the **Default** account, with conch's own
`bypass-permissions` setting, and the brief as its first message (a daemon-owned `initialPrompt`; never accepted from a
client). Fix is refused, saying why, when the daemon isn't running from a git checkout (a Homebrew install).

The brief carries the ticket's evidence and these rules:

1. Work in a worktree: `git worktree add .worktrees/ticket-<n> -b fix/ticket-<n> origin/main`. Never on main.
2. Read CLAUDE.md. If it isn't a conch bug (an expected refusal, the Mac's environment), say so and stop, no PR.
3. Add a regression test that fails before the fix; run `scripts/ci-local.sh`, reading its exit code.
4. Commit, push and open a PR on `fix/ticket-<n>`. **Don't merge. Don't deploy**: no build-app.sh, no restarting
   the daemon or the app.
5. **The repo is public.** Nothing from the evidence goes into a commit, the PR, a test fixture or a comment: no
   session names, folder paths, client or project names, or the user's words. Describe the bug in general terms and
   make fixtures up.
6. Never bare `tmux`, never `tmux kill-server`: the session runs in conch's own tmux.
7. File nothing anywhere else: no GitHub issues, no other service.

**Linking the PR**: while a ticket is fixing, every 5 minutes the desk asks `gh pr list --head fix/ticket-<n>` in the
checkout (reading only). Found: linked. Merged: fixed. Closed unmerged: back to open. If the fix session's tmux session
is gone and no PR came, the ticket goes back to open, unseen, saying so.

**A PR that says so** (2026-11-11): until then only a fix session's own branch was looked for, so a ticket fixed by
any other PR stayed open for ever. Every 30 minutes the desk reads the checkout's recent PRs whose description
mentions a ticket (`gh pr list --search "ticket in:body"`, reading only) and takes `Fixes ticket #12`,
`Fixes tickets #1, #4 and #36` or `Fixes ticket <12-hex id>` from them (`ticketRefs`). An open PR makes an open
ticket fixing; a merged one makes it fixed from its merge, so it reopens only for a failure seen by code from after it.
A PR links a ticket once (one that came back after a PR merged isn't fixed by it again), never one a fix session is
at work on, and a number only from a PR opened after the ticket was first seen (a store started over numbers from 1
again). A bare `#12` is a GitHub link and names no ticket. The fix brief asks for the line.

**Auto-fix** is the setting `failure-autofix`, **off by default**. When on, a ticket that opens (new, or reopened)
while it is on gets a fix session without Tyler pressing Fix, but only:

- conch's own tickets only (`blame` conch), never one gone quiet;
- one at a time: none while any ticket is fixing without a PR yet;
- at most **3 a day** (local day);
- never for the loop's own failures (`failure-fix`), and never for a ticket an auto-fix already "fixed" that came back:
  that one waits for Tyler.

The backlog that was open before auto-fix was turned on is left for Tyler.

A Fix that can't start (no checkout, Claude not installed, tmux missing) is itself recorded as `failure-fix`, and the
ticket stays open.

## Privacy

The conch repo on GitHub is **public**, and records carry session names, folder paths, client names and prompt text.

- Tickets live only in `~/.config/conch/` (0600). Nothing in the loop files anything to GitHub or any other service,
  and `conch bug` is no exception: an agent asked to report a conch bug files it here, never as an issue.
  The only thing that leaves the Mac is the PR the fix session opens, under rule 5 above.
- `gh` is used only to read: the PR on a branch the loop named, and the checkout's PRs that say which tickets they fix.
- **Mirror seam**: `FAILURE_MIRRORS` in `src/failure-tickets.ts` is an empty list with the interface a private mirror
  (Linear, say) would implement, and the rules it must follow. It is off and unimplemented; nothing calls out.
- `conch failures` prints the tickets in a terminal from the same store.
