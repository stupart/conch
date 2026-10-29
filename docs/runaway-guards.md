# Runaway guards

Tyler, 2026-10-28: *"do we have protections in place to stop the daemon from going out of control and infinite looping
making processes until my computer is bricked if an error is going off over and over or something?"*

## The answer, as things stood before this change

Mostly, but not all the way. No path started processes without limit: every worker restart already came in a small,
spaced-out burst, and every restart killed the old process first. So the number of processes never ran away. Some
loops had no end, though: a failure that kept repeating was retried at a steady rate for as long as the daemon lived.
The worst were the speech engine and the voice worker. A whisper-server that loaded, answered and then died was
restarted every few seconds, forever, loading a large model each time. In a sandbox, it was started 17 times in 2 minutes, about
12,000 a day. Nothing told Tyler. Nothing counted the processes conch had running at once. One error said over and over
could also push the hours before it out of the log. The Mac app already stopped restarting a daemon that kept exiting,
but it forgave one that ran for two minutes between crashes, forever.

## The mechanism

One small file, `src/runaway.ts`, used everywhere:

- **`Breaker`**: allows at most `limit` events in `windowMs`. The next one is refused for a cool-down, which grows each
  time it trips in a row and is forgiven after `calmMs` without a trip. Callers ask `allows()` before the work and call
  `record()` after it. A worker restart uses `RESTART_POLICY`: 5 in 10 min, then cool-downs of 5 min, 15 min, then
  hourly. The supervisor's own periodic retry waits out the cool-down instead of firing every 30 s.
- **`RunawayGuards`** (one per daemon, `runawayGuards`): hands out named breakers. It logs each trip **once**, in plain
  words, and publishes the trips in force as `PublishedState.guards`. The Mac app shows the newest trip as one line
  above the work, with OK (`RunawayGuardNoticeLine` in `Notices.swift`, words in ConchDesign's `RunawayGuards.swift`):
  *"conch stopped restarting the speech engine (whisper-server): it failed 5 times in 10 min. It tries again at
  7:45 PM."*
- **`installChildCeiling`**: wraps `Bun.spawn` in the daemon, so every spawn site is covered at once, including ones
  added later. Past 64 live children a spawn throws, as it already does for a missing binary, and the app is told which
  programs are piling up. A steady daemon has 3 long-lived children and at most 5 at once (measured below). Only the
  daemon installs the ceiling. `spawnSync` is not counted: it blocks the only thread that could start another child.
- **`LogDamper`**: lines with the same shape (numbers, ids and quoted names stripped) are written 10 times a minute.
  The rest are counted and summed up in one line when the minute is over. `logAbove` (the daemon log) goes through it.
- **`appendCapped`**: append to a diagnostic file that rolls over to one `.1`, so it never grows past two files.

`scripts/runaway-e2e.ts` proves both ends in a sandboxed daemon (temp HOME, config, socket and TMUX_TMPDIR; no
session started, no tmux server touched):

- **whisper**: a whisper-server that answers and dies 2 s later. It is started once and restarted 5 times, the trip is
  logged once and published, and it is not started again.
- **ceiling**: a daemon with a ceiling of 0. Every spawn is refused, and the daemon stays up and keeps answering its
  socket.

## Measured on 2026-10-28 (read-only)

- **Processes.**
  - The daemon (`bun ~/conch/src/cli.ts daemon`) had 3 long-lived children: claude-swap `auto`, whisper-server, and the
    Kokoro worker (plus its multiprocessing tracker). At most 5 at once over 20 s of sampling.
  - The app had the daemon and nothing else.
  - conch's tmux server (`-L conch`) held 14 agent sessions, each with its own `conch mcp` server (14) and Atlas node
    server.
  - Leaked by other agents' test runs, not the daemon: about 13 short-lived `tmux -L cx-e2e-*` / `conch-test-*` /
    `e2e-skills-*` / `cxmock` servers, 5 orphaned `conch-ft-*/bin/claude --version` shells, and about 230 `/tmp/conch-*`
    leftovers.
- **Repeating errors.**
  - None anywhere near a storm.
  - `errors.jsonl`: 435 rows since 9 September (1.9 MB). 272 of them are the same `Codex row has no pid`, at most 4 in
    one minute.
  - `/tmp/conch-daemon.log`: 780 lines in 2.3 days (67 KB). The most repeated are phone-relay disconnects and
    reconnects (93 + 81 + 81 + 55), at most 4 in one minute.
- **Files.**

  | File | Size | Limit |
  |---|---|---|
  | daemon log | 67 KB | 4 MB, plus one `.1` |
  | `errors.jsonl` | 1.9 MB | 8 MB, plus one `.1` |
  | `mcp-usage.jsonl` | 59 KB | 8 MB, plus one `.1` |
  | `handoffs/` | 746 MB | none (see below) |
  | `records/history.sqlite` | 11.1 GB | none (see below) |

### The records database (11 GB)

`~/.config/conch/records/history.sqlite` is conch's own history index (`docs/records-foundation.md`). Every line of
every Claude Code and Codex transcript conch has seen is copied in, normalized: items, tool calls with their arguments
and results, sources and receipts. That gives paged history and search that survive Claude Code deleting its own
transcripts after 30 days. Today it holds 1.24 M items and 371 k tool calls from 3,671 transcript files:

| Transcripts | Files | Size |
|---|---|---|
| still on disk | 1,614 | 14.7 GB |
| deleted since ("missing") | 2,060 | 19.0 GB |

By size: items 3.5 GB, tool calls 2.0 GB, item sources 1.2 GB, the rest indexes.

So **yes, its size is expected**: it is about a third of everything conch has indexed. But it is **not bounded**. It
grows with real use, not with errors: about 11 MB in 5 minutes of an active afternoon, 30 to 150 MB of text on a busy
day. Nothing deletes or vacuums it. `docs/records-foundation.md` lists retention as later work. It is not a runaway
risk, so this change leaves it. Deciding how much history to keep is a product decision; options are below.

## The audit

Every place the daemon, the app, the hooks and the MCP servers start a process, restart something, retry, reconnect, or
answer an error with more work. References are to this branch.

### Already bounded

| What | Where | Bound |
|---|---|---|
| The app restarting a daemon that exited | `DaemonHost.handleExit`, `DaemonHealth.CrashBudget` (DaemonHealth.swift:185) | Waits 2, 4, 8, 16, then 30 s; gives up after 5 in a row and says so in the window |
| The app replacing a frozen daemon | `recoverFrozenDaemon`, `restartPlan` (DaemonHealth.swift:227) | 3 in 10 min, then gives up and says so |
| Background sessions whose tmux server died | background-recovery.ts:60 | 3 a day per conversation; one pass at a time |
| Sessions after a Mac restart | restart-recovery.ts:64 | 3 a day per conversation; only across a reboot |
| Failure-ticket "Fix" sessions (in flight, `.worktrees/failure-tickets`) | failure-tickets.ts:138 | Off by default; 3 a day; one at a time; never for its own failures |
| Rebuilding the natural voices | voice-heal.ts:14 | 3 quick tries, then cool-downs of 1, 2, 4 h |
| Whisper model download | speech-engine.ts | 0, 60 s, 5 min per run, plus a per-day count |
| claude-swap's `auto` | claude-rotation.ts:305 | 10 s doubling to 5 min (never reset; one process) |
| Records worker | records-runtime.ts:275 | 3 replacements per daemon run |
| Phone relay | phone-relay.ts:1174 | 0.5 s doubling to 30 s with jitter. Unlimited tries, but each is one cheap WebSocket dial |
| Hooks (one process per Claude Code event) | install.ts:734 | Claude Code kills one after 15 s. Socket send gives up after 500 ms. `CONCH_INTERNAL` keeps conch's own `claude -p` (model.ts:33) out of the hooks (hook.ts:325) |
| UI automation (osascript, tmux, pbcopy) | pasteboard.ts `runUICommand` | 4 s, then SIGKILL; one stuck child seals the lane |
| Logs and journals | status.ts:1890, app-errors.ts:7, hook.ts:301, telemetry.ts:18, mcp-usage.ts:59 | Each rolls over to one `.1`: 4, 8, 1, 8 and 8 MB |
| Screen journal, deliverables, captures, uploads, conversation images | screen-context.ts, deliverable-store.ts, page-capture.ts, phone-uploads.ts, conversation.ts | 30 days / 50 MB; 64 MB per unit; 7 days / 200; 1 day; 400 files |

### Was unbounded, now bounded

| What | Where | Before | Now |
|---|---|---|---|
| whisper-server (and `mlx_audio.server`) restarts | server-supervisor.ts:454, daemon.ts:4125, 4063 | A server that answered and then died reset the burst on every start: restarted every few seconds, forever. One that never started got a burst of 3 at every 30 s canary: 8,641 spawns a day where probes answer at once (the unit test), about 1,400 where each waits out its 60 s readiness probe. | `RESTART_POLICY` breaker: 134 spawns a day in the unit test's model. In the sandbox, 6 starts in 2 min instead of 17 (below). Then it stays on the cold CLI, and the app is told. |
| Kokoro worker restarts | tts-worker.ts:632, daemon.ts:1221 | A worker that loaded and died, failed its health check, or hit the 30 s periodic retry (a burst of 4) was restarted forever. voice-heal only parks a worker that never starts. | The same breaker, at 12 in 10 min, so voice-heal's quick repairs never wait out a cool-down. Loading a new interpreter is not counted at all. |
| Children of the daemon at once | daemon.ts:880 | Not counted anywhere | Ceiling of 64; the app is told which programs |
| `ps` behind "tools out of date" | daemon.ts:2301, mcp-servers.ts:145 | Every 60 s with no timeout and no busy check: a hung `ps` added one a minute | One look at a time; killed after 10 s |
| Codex turn watch | daemon.ts:4262 | Every 5 s, overlapping when a look took longer: piled-up probes, and possibly a turn announced twice | One look at a time |
| Setup's login-shell and `--version` probes | doctor-checks.ts:600 | No timeout behind a 15 s cache: a hung shell profile added a shell every ~23 s while Setup was open | Killed after 15 s |
| Status-line usage check | claude-account-usage.ts:86, 120; claude-accounts.ts:180 | A failed `claude auth status` cleared the cache, so every status-line refresh, in every account, started another `claude`. On timeout it sent SIGTERM and waited forever. | A failure rests a minute; SIGKILL on timeout |
| MCP hand-off to a newer server | mcp-handoff.ts:218 | A fresh server that took over and died was started again every minute, in every session | Not tried again for that toolset; the next deploy tries again |
| Sessions conch brings back on its own | daemon.ts:966 | Capped only per conversation id: a relaunch whose id came back different was never capped | Also 40 in 10 min across both guards, then 1 h, 4 h, 24 h |
| The app forgiving a daemon that ran for 2 minutes between crashes | DaemonHealth.swift:182 | Restarted forever, 2 s after each crash, reloading every model each time | More than 12 exits in an hour gives up and says so |
| Why the daemon stopped | DaemonHost.swift:406 | Only in an unread 40-line buffer, so "Check the log" found nothing | The exit status and its last lines go to the daemon log |
| launchd's KeepAlive (`conch service`) | install.ts:576 | `<true/>` restarted a daemon that exited 0 on purpose (another daemon owns the socket) every 10 s | Restarts only after a crash, at most every 30 s |
| One error logged over and over | status.ts:1909 | Written in full each time, rolling the hours before it out of the log | 10 lines a minute per shape, then counted |
| `conch-inject-debug.log` (and the queue trace) | inject.ts:357 | Always on, no limit until a reboot cleared `/tmp` | 4 MB, plus one `.1` |

Measured in the sandbox with a whisper-server that answers its canary and dies 2 s later. Both runs used the same
script and differ only in the checkout the daemon runs from:

| | 30 s | 60 s | 90 s | 120 s |
|---|---|---|---|---|
| `origin/main` | 5 | 9 | 13 | 17 starts, and still going |
| this branch | 5 | 6 | 6 | 6 starts, tripped, published |

### Left as it is

- **The records database** (11 GB, above). If it needs a cap, the options are:
  1. Drop the rows of `missing` sources older than N days, then `VACUUM` (or turn on `auto_vacuum`).
  2. A size budget that drops the oldest sessions first.
  3. Stop copying `tool_calls.result_json` beyond a few KB.

  A floor on free disk space, below which the indexer pauses, would be the cheap guard either way.
- **`~/.config/conch/handoffs/`** (746 MB): a full copy of each transcript resumed on another account, never removed
  (claude-account-handoff.ts). It grows only on a deliberate account switch.
- **`/tmp/conch-supervisor.log`**: launchd's stdout for the legacy `conch service` daemon, with no limit. Tyler runs the
  app-hosted daemon, so this file doesn't exist here.
- **Sessions are not children of the daemon.** A session belongs to Terminal or to conch's tmux server, so the ceiling
  doesn't count it. Sessions conch starts on its own are covered: the relaunch breaker for the two guards, and the
  failure-ticket caps for Fix. The rest are started by a person.
- **The phone relay** never stops redialling (at most every 30 s), and up to three triggers redial after each wake
  (`wakeWatch`, the app's `system-woke`, the relay's own sleep check). This is cheap but noisy in the log, which the
  log damper now caps.
- **Unbounded `ps`/`ioreg` calls on the render path** (window-key.ts:81, sessions.ts:213, session-lifecycle.ts
  394/666/676, voice-loop.ts:363). They are awaited, behind one-at-a-time renders, so a hang stalls the panel rather
  than piling up processes.
- **The cold whisper path and speech**: a timed-out child gets SIGKILL and `unref`, and nothing waits for its exit. The
  ceiling counts it until it does exit.
- **The control socket** has no limit on connections, and a handler keeps working after its client gives up.
- **The records indexer** rereads every transcript every 30 s (records-indexer.ts:168). That is steady CPU and disk
  use, not a loop.
- **`errors.jsonl`**: each row carries a ~4 KB digest of the daemon's state, and a repeating report is deduplicated
  only within one daemon run. It can't grow past 16 MB.
- **Tests and other agents' e2e runs** leave tmux servers, `claude --version` shells and `/tmp/conch-*` folders behind
  while they run (see Measured).
