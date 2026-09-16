# Incremental record ingestion

PR 6 builds on the [record foundation](records-foundation.md). `records` remains
off by default. No application, paging, legacy conversation-reader or hook-counter
behavior changes.

## Lifetime and bounds

`RecordsRuntime` is passive until enabled after the daemon owns its control socket.
It passes only routing metadata and receipts to `RecordsClient`; transcript reads,
normalization and SQLite work run in `records-worker.ts`. Disabling or shutting down
drains accepted receipt writes and closes the worker. A two-second shutdown deadline
terminates an unresponsive worker and reports unknown pending outcomes.

Discovery uses the existing provider adapters and configured Claude `projects/`
and Codex `sessions/` / `archived_sessions/` roots. It rejects symlinks and validates
stored recovery paths again before reading. No general disk search or transcript
write occurs. A physical source is identified by session, device and inode; renames
retain its cursor and replacements get separate source records.

Each worker tick visits at most 32 directory entries, pages at most 32 stored source
descriptors, and reads one file batch: at most 256 KiB including identity probes and
256 complete lines. Timers yield between ticks. At most 256 jobs and 256 live hints
are retained. File changes and repeated hints coalesce by source identity. Selected
sources precede live sources, then backfill; background work gets a turn after eight
foreground batches. Finishing a buffered large record can delay that aging step.

One incomplete record may accumulate across ticks, up to 8 MiB. Parsing that single
record happens in the worker. Larger records pause that source with `oversized`
coverage and leave its cursor unchanged. Live sources poll every second; historical
sources and discovery reconcile every 30 seconds. These are bounded work budgets,
not guarantees about disk latency.

The selected hint is the daemon's existing terminal/voice selection. Mac-only
selection has no daemon notification today; adding one belongs with the history
client work. The session inventory is independent of the eight-row preview cap.

## Recovery

Migration 2 adds per-source coverage status, a safe error code, update time and a
durable replay-required flag. Existing records and immutable receipts are retained.
Items and their byte checkpoint still commit in one SQLite transaction.

Startup pages all known sources. Truncation, changed probes, same-size modification
or parser-version invalidation clears the session's derived projection, resets all
its source cursors, and schedules all retained sources for replay. A crash before
checkpoint commit rolls back the batch; restart resumes from the committed cursor.
Missing files stay recorded as missing. A deleted source cannot be reconstructed.
Complete malformed lines advance coverage with a count, never their raw contents.

Reconciliation checks metadata and short prefix/checkpoint probes. It does not
detect every arbitrary interior rewrite followed by an append. Numeric rotation
suffixes are recognized; unknown historical naming layouts need additional fixtures.

## Observed receipts

Voice-loop delivery emits admission and one terminal outcome: submitted, staged,
failed or unknown. Codes distinguish transcript confirmation, transport submission
and provider queueing. Submission is not proof that the agent consumed the prompt.
Review publications emit only at acceptance, not when restoring saved reviews.
Alternative prompts, composer slash commands, the model picker and daemon rename
synchronization also record their transport outcomes. Unsupported provider commands
are failures, not evidence that the provider changed its state.

Speech emits queued, backend-invoked started, and an observed terminal outcome.
The existing audio backend returns no trustworthy playback-completed signal, so its
normal return is `unknown` / `backend-returned`. Cancellation and timeout are
interrupted and failed. Phone/remote playback without session/playback identity is
not attributed by guessing from a label.

Operation IDs and settlement guards prevent duplicate local outcomes. Session
ownership is captured at admission; a later window reuse cannot retarget a receipt.
Review IDs hash the publication identity; receipt metadata contains no summary,
link, prompt, tool arguments or audio. Journal triggers still forbid mutation or
deletion during replay.

The daemon has at most one receipt RPC in flight and 256 pending receipts. Overflow
or worker failure reports that a receipt was not stored; it does not block delivery.
This is exactly-once recording of an observed local operation, not exactly-once
execution of independently retried external requests. A hard daemon kill before a
queued receipt commits can lose that observation.

Permission-navigation and interrupt keys are control actions, not message deliveries,
and have no receipt vocabulary in this PR. Rename commands sent directly by the CLI
or MCP process also remain outside the daemon-owned journal.

## Prompt cursors for hooks

Claude Code and Codex run a hook on every turn, and each hook is a fresh process
with an empty cache. A prompt count is the one transcript read that must see the
whole file, so every turn paid a byte-zero scan of a transcript that can be
hundreds of megabytes — while the daemon that had already counted it could not
help, because it is a different process.

The daemon now commits what it counted. `prompt_cursors` holds one row per
transcript file, keyed by device and inode: the byte offset of a line boundary a
count reached, the count at that offset, and the record store's own two 256-byte
probes (the first bytes of the file, and the bytes immediately before the
offset). `src/prompt-cursor.ts` publishes a row after each count the daemon
performs, and reads one back in a hook.

A hook opens the database read-only in its own process, with `busy_timeout = 0`
and a 50 ms budget, because a hook that waits on the daemon delays the user's
next turn. It stats the transcript, re-reads the two probes, and resumes the
existing reducer at the cursor, so only the bytes appended since are parsed.
Records off, no database, no row, a lock, a failed probe or an offset past EOF
all fall back to the original scan.

A cursor changes how many bytes are read, never the number returned. It is
derived state: dropping every row costs full scans and nothing else. A count
that raised on a malformed entry before the cursor is never published, so a
resumed count cannot return a number where a full scan raises. An interior
rewrite that preserves both probe windows is undetected — the same ceiling
[the source contract](records-foundation.md) already documents for ingestion.

## Verification

Fixtures cover priority, byte/line budgets, coalescing, partial UTF-8, rotation,
session-wide replay, path validation, receipt ownership and settlement, disabled
startup, worker lifecycle and an actual worker exit before checkpoint commit.
Performance assertions count work per tick and in-flight RPCs, not elapsed time.
The full test suite and TypeScript check run with temporary config, log and IPC
paths. Mutation checks sabotage priority, batch bounds, replay, the off gate and
receipt settlement, then restore the exact source using Python string replacement.

The [PR 7a API](records-paging.md) supplies paged history; PR 7b adds its app clients.
Atlas, arbitrary-edit hashing, retention
policy, attachment transport and new audio completion acknowledgements remain later
work. The real record store is neither enabled nor used during validation.

### Verified results (2026-09-16)

- Full `bun test`: 2,110 passed, zero failed; 19,182 assertions across 197 files;
  exit 0. Config, provider, log, state and IPC overrides pointed to temporary paths.
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools` selected the installed tools
  for this process; the selected Xcode installation otherwise returned license
  error 69. No license or system developer-directory setting was changed.
- `bunx tsc --noEmit`: exit 0.
- Each mutation's baseline and restored test exited 0. Each sabotaged test exited 1:
  selected source priority lowered, line cap removed, invalidation cursor resets
  suppressed, off setting forced on, and operation settlement guard removed.
  Restoration used Python string replacement and verified exact source equality.
- The single smoke run copied at most 1 MiB from each of two Claude and two Codex
  transcripts into private temporary fixtures: 3,483,926 bytes total. Ingestion
  produced four sessions/sources, 15 turns, 356 items, 357 source references,
  55 tool calls and 74 response/context rows from 605 complete lines. Zero malformed
  lines, source-read errors or discovery errors. Three bounded prefixes ended
  mid-record (`partial`); one was complete. Exit 0. Copies and database were deleted.
