# Local record store foundation

This describes the shipped PR 5 foundation; see [incremental ingestion](records-ingestion.md)
for PR 6 wiring and limits. In PR 5, nothing called the store from the daemon,
watched transcripts, or changed the existing conversation renderer. `records` / `CONCH_RECORDS_ENABLED`
defaults to false. `openRecordsIfEnabled(config)` is the construction gate; enabling
it does not start ingestion. An explicit `configDir` overrides `CONCH_CONFIG_DIR`.

## Storage and API

The database is `<configDir>/records/history.sqlite`, with SQLite WAL, FULL
synchronous commits, a 0700 directory and 0600 database/WAL/SHM files. Schema
migrations and `PRAGMA user_version` commit together. Newer schemas are refused.
The complete version-1 DDL is in `src/records-schema.ts`.

`RecordsClient.open({configDir})` owns a worker. Normalization, SQLite writes,
checkpoint reads and receipt reads all run there. Callers send typed operations,
never SQL. Await each ingestion batch before scheduling another; PR 6 owns file
I/O, bounded batch sizes and backpressure. `close()` drains earlier operations.

- `source(id)` returns the current source cursor and bounded parser bookkeeping.
- `ingest({session, source})` normalizes supplied bytes and commits the derived
  records, provenance and cursor atomically. It never opens a transcript.
- `reindex(sessionId)` clears derived records and resets all that session's source
  cursors. It leaves the receipt journal intact.
- `appendReceipt(receipt)` inserts an immutable observation. An identical ID and
  payload is an idempotent retry; a conflicting payload fails.
- `receipts(actionId)` returns that action's observations in time order.
- `counts()` is a small diagnostic, not the future paging API.

Receipts use caller-supplied stable IDs plus action/attempt IDs. Delivery,
review publication/opening and speech are distinct kinds with explicit states;
failure and unknown delivery are retained. Their references have no foreign keys
into the rebuildable index. SQL triggers reject journal updates and deletes.
An observation should be appended at the time the action occurs; re-parsing
transcripts must never manufacture delivery confirmations.

## Source contract

Each read includes file path, device/inode, observed size/mtime, bytes starting at
`from`, the first up-to-256 bytes, and up-to-256 bytes immediately before the last
committed offset. `expected: {generation, offset}` identifies the cursor the reader
observed (`null` for a new source). Stale changed snapshots are rejected so an old
retry cannot masquerade as truncation. Repeating the same snapshot is safe.

Only complete newline-terminated UTF-8 lines advance the cursor. Partial lines
remain unread, including partial multibyte characters. Malformed complete lines
advance coverage and increment `malformedLines`; their contents are not retained.

Device/inode replacement starts a new generation and retains earlier segments.
Each item source keeps the original path, device/inode, generation, byte offset,
byte length and selector even after rotation. Paths are hints; the future reader
must revalidate file identity before using an old pointer.

Truncation, changed probes, same-size modification and parser version changes
invalidate the session's derived projection. Turns and tool calls can span files,
so PR 6 must replay **all** reset sources for that session, including any retained
rotated files. Rebuilding cannot recover source files that have been deleted.
The short probes cannot detect every interior rewrite combined with an append;
PR 6 needs a reconciliation policy if supporting arbitrary in-place edits.

## Fidelity and exclusions

Sessions retain provider/native identity and owner-device scope. Turns distinguish
native boundaries from inferred boundaries. Items preserve full visible bodies,
tool arguments/results and compaction markers. Native IDs take precedence over
physical source identities. Provenance and item revisions survive mirrored events;
repeated identical messages with distinct native IDs remain distinct.

Claude uses UUID/parent links, tool-use IDs and request/message IDs for usage.
Codex keeps native turns, calls, fork metadata and bounded mirror bookkeeping.
Orphan results remain addressable and can later acquire a call. File operations
derived from arguments are labelled **attempted**, not verified edits.

`responses` separates per-response usage, cumulative observations and context
measurements. Upserts replace known values instead of adding them. Only sum
`measurement='response'` for response totals; never add cumulative/context rows to
that sum. Missing usage stays null. Provider records without a stable response ID
use physical identity, so copies across different files cannot always be deduped.

Neither raw envelopes, privileged instructions, hidden/encrypted reasoning nor
binary attachments are stored. Known structured credential fields are removed;
visible prose and opaque tool-output strings are **not** a general secret scanner.
The database contains sensitive conversation text and is not encrypted by this
module. No cookies, browser profiles, audio recordings or key material are imported.
Attachment placeholders retain presence without embedding the binary data.

Provider formats vary. Event-only Codex tool summaries without raw call/result
records are not yet reconstructed. Claude hidden-only UUIDs retain metadata-only
ancestry anchors. Unknown/forward parent links remain unresolved until their source
is available, rather than borrowing another branch's turn.
These limits need representative PR 6 fixtures; they must not be presented as
complete coverage of every historical harness version.

## Deferred

PR 6 adds discovery, incremental file reads, scheduling, reconciliation and live
receipt producers. PR 7 adds full paged history. Existing snapshot caps, daemon
behavior, Mac/iPhone UIs and `src/conversation.ts` are unchanged. Search, Atlas,
cross-harness forks, retention/purge policy and attachment transport are later work.

## Verification (2026-09-15)

- Full `bun test`, after mutation restoration: 1,893 passed, zero failed,
  9,804 assertions across 180 files; exit 0.
- The four records fixture files: 62 passed, 269 assertions; exit 0.
- `bunx tsc --noEmit`: exit 0.
- `python3 scripts/check-records-mutations.py`: exit 0. Each of idempotent replay,
  checkpoint atomicity, partial lines, receipt survival and reasoning exclusion
  failed its targeted test with exit 1 when sabotaged. Each restored test exited 0.
  The script restores with Python string replacement and verifies exact equality.
- One bounded smoke parse matched two Codex rollouts: 2,097,152 bytes, 136 complete
  lines, zero malformed lines, 38 items, 16 tool calls and 43 response/context
  observations. No Claude files matched the bounded Conch-directory selection;
  Claude validation used fixtures. Zero parse errors; temporary database deleted.

The suite's config/provider/socket defaults now point at temporary paths. Labels
and voices also respect `CONCH_CONFIG_DIR`; otherwise existing tests could read
the live config despite the override. Live-log assertions now check the redirected
fixture destination without reading running-daemon files. The final full-suite
run explicitly redirected all config, log, state, receipt and IPC paths.
