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
3. A new ticket puts a small dot on the header's gear and beside Settings › Failures. Nothing speaks, rings, or pops
   up. Opening Failures clears the dot.
4. Tyler reads the ticket (what failed, how often, in which sessions, the latest example with its evidence) and
   presses **Fix**, or **Ignore**.
5. Fix starts a background Claude session in the conch checkout, on the Default account, through the daemon's own
   session-start path. Its first message is a brief built from the ticket. The ticket shows *Fixing*.
6. The session works in a worktree on `fix/ticket-<n>`, adds a regression test and opens a PR. The desk finds the PR
   by its branch and links it. It never merges.
7. Tyler merges. The desk sees the PR merged and marks the ticket *Fixed*. If the same failure is seen again by a
   daemon started after the merge (that is, after the deploy), the ticket reopens, with its old PR still linked.

## Capture: one path

Every failure record goes through `appendConchError` into `~/.config/conch/errors.jsonl`, as the daemon's, the Mac
app's and the phone's already did. MCP tool calls keep their own log, `mcp-usage.jsonl`, which the MCP server process
writes itself (sessions run the MCP server they started with, so the daemon reads that file rather than asking every
server to change). The desk reads both, from a saved offset, every 5 s; a record written by the daemon pokes it at
once.

What is newly captured, which before reached only the text log, a spoken line, or nothing:

| Where | Operation | Before |
|---|---|---|
| Any queued or immediate daemon event that throws (interrupt, session-start, a turn, and an inject until #574 files its own throw where it happens, as `permission-answer`, `question-answer` or `inject`): today's Allow | the event's type, `threw: true`, top of the stack | log line only |
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

Not captured, on purpose:

- **Errors a runtime request answers with** (session start/close/fork, account calls that throw in the daemon). The
  Mac app and the phone already report these themselves; recording them in the daemon too would make two tickets for
  one failure. The CLI prints them where you typed, and an MCP call's failure is in `mcp-usage.jsonl`.
- **Agents' own tool calls** (Bash, Edit, …): they live in each agent's transcript, not in conch.
- **The phone's own uncovered paths** (a control post that fails, a delivery whose outcome is unknown): iOS is out of
  this cut.
- **Deliberate non-deliveries**: a send interrupted by Tyler himself, text staged for an explicit send.
- **Voice, TTS, mic and relay noise** (disconnects, engine warm-ups): none of it is an agent letting Tyler down.
- A hook that finds **no socket** (conch is off): that is a choice, not a failure.

## Tickets and signatures

A ticket groups records with the same **signature**: `origin · operation · message`, where

- **origin** is where it came from: `daemon`, `mac`, `ios`, `hook`, or `mcp`;
- **operation** is the record's operation, or for MCP the tool's name plus its outcome (`conch_capture failed`);
- **message** is the record's message, normalized: URLs → `<url>`; absolute and `~` paths → `<path>`; UUIDs and hex
  ids → `<id>`; anything in quotes (session labels, page text) → `"…"`; file names → `<file>`; numbers → `<n>`;
  whitespace collapsed; then only its **first sentence**, at most 160 characters. The rest of a message is usually
  what conch saw (a page's headings, the recovered draft), which is evidence, not identity.

So `Couldn't find v0.4.0.md` and `Couldn't find clip.mp4` are one ticket; `message landed on clipboard
(system-dialog-blocking)` and `(front-window-changed)` are two, because the reason in brackets is a different cause.

A ticket keeps: its number (`#12`, for saying aloud) and a stable id (hash of the signature), status, first and last
seen, count, the 20 most recent affected sessions (id and label), **one example** (the newest occurrence: its time,
raw message, session, and its `state` evidence, bounded), whether it is unseen, and its fix (who started it, when,
the background session, the branch, the PR and its state).

**Status** is `open`, `fixing`, `fixed` or `ignored`:

| | a new occurrence | Fix | Ignore | the PR merges | the PR closes unmerged / the fix session ends with no PR |
|---|---|---|---|---|---|
| open | count + 1 | → fixing | → ignored | | |
| fixing | count + 1 | | → ignored | → fixed | → open, unseen |
| fixed | → **open, unseen**, if seen by a daemon started after the fix merged; otherwise count + 1 | | | | |
| ignored | count + 1, stays quiet | → fixing | | | |

Tyler can also **Reopen** (ignored or fixing → open) and **Mark fixed** (no PR needed).

**The store** is `~/.config/conch/failure-tickets.json`, mode 0600, written whole through a temporary file and a
rename. On its first run the desk reads back 14 days of records, so the list starts with what is happening now, not
September.

## Showing it

**Settings › Failures** (mark: a ladybug), after Setup. Open tickets first (new ones marked with a dot), then Fixing,
then Fixed in the last 14 days; Ignored folded under a count. A row is the ticket's normalized message, and under it
`origin · operation · 32 times in 14 sessions · last 2h ago`; Fix on the right. Clicking a row opens it in place: the
example's time, message, session and evidence, the PR, and Ignore / Mark fixed / Reopen.

**Unseen** is a 6 pt dot: on the header's gear while any open ticket is unseen, and beside Failures in the section
list with the open count. No sound, no notification, no badge on the Dock. Showing Failures marks every ticket seen.

The daemon publishes only `failures: {open, unseen}` in its state; the list itself is a socket request
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

**Auto-fix** is the setting `failure-autofix`, **off by default**. When on, a ticket that opens (new, or reopened)
while it is on gets a fix session without Tyler pressing Fix, but only:

- one at a time: none while any ticket is fixing without a PR yet;
- at most **3 a day** (local day);
- never for the loop's own failures (`failure-fix`), and never for a ticket an auto-fix already "fixed" that came back:
  that one waits for Tyler.

The backlog that was open before auto-fix was turned on is left for Tyler.

A Fix that can't start (no checkout, Claude not installed, tmux missing) is itself recorded as `failure-fix`, and the
ticket stays open.

## Privacy

The conch repo on GitHub is **public**, and records carry session names, folder paths, client names and prompt text.

- Tickets live only in `~/.config/conch/` (0600). Nothing in the loop files anything to GitHub or any other service.
  The only thing that leaves the Mac is the PR the fix session opens, under rule 5 above.
- `gh` is used only to read PR state for branches the loop named.
- **Mirror seam**: `FAILURE_MIRRORS` in `src/failure-tickets.ts` is an empty list with the interface a private mirror
  (Linear, say) would implement, and the rules it must follow. It is off and unimplemented; nothing calls out.
- `conch failures` prints the tickets in a terminal from the same store.
