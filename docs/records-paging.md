# Recorded history API (PR 7a)

History reads use the records worker and SQLite index. They never open transcript
files, require a live session row, or fall back to the snapshot's truncated history.
The `records` setting remains off by default; an off runtime returns
`{"kind":"history-off","error":"history is off"}` without starting a worker or
creating a directory. PR 7b supplies the Mac and iPhone readers.

## Requests and responses

The TypeScript contracts and validation live in `src/history.ts`. On the control
socket, `history.page` and `history.item` use these messages:

```ts
{ kind: "history-page", session: string, branch?: string, before?: string, limit?: number }
{ kind: "history-item", session: string, item: string, bodyCursor?: string }
```

`limit` defaults to 50 and accepts integers from 1 through 100. A page may contain
fewer items to fit the byte budget. Omit optional cursors instead of sending null.

```ts
{
  kind: "history-page", session: string,
  items: Array<{
    id: string, kind: string, revision: number, orderKey: string,
    preview: string, bodyBytes: number,
    turnId?: string, nativeId?: string, parentId?: string,
    role?: string, at?: number, toolName?: string
  }>,
  previousCursor: string | null, changeCursor: string, epoch: string,
  coverage: {
    sources: number, statuses: Record<string, number>, replayRequired: boolean,
    malformedLines: number, indexedBytes: number, observedBytes: number,
    branch: "all" | "ancestry", order: "timestamp-source"
  }
}
{
  kind: "history-item", item: string, content: string,
  nextBodyCursor: string | null, revision: number, encoding: "text" | "json"
}
```

Previews contain at most 240 characters. `content` is a UTF-8-safe fragment;
concatenate all chunks before parsing JSON when `encoding` is `json`. A record
with both visible text and structured fields encodes `{text, content}`. Ordinary
bodies are sliced in SQLite; mixed bodies require SQLite to assemble their JSON
before slicing. Only bounded slices cross into JavaScript.

Service responses are at most 28 KiB of serialized JSON. This reserves room for
MCP's extra JSON quoting and envelopes. Socket, phone and complete MCP frames also
enforce the 64 KiB UTF-8 wire ceiling, including the socket newline. Oversized
metadata is refused explicitly rather than silently omitting an item.

Failures use `{kind: "history-error", code, error, epoch?, revision?}`. Codes are
`invalid-request`, `unauthorized`, `session-not-found`, `ambiguous-session`,
`item-not-found`, `invalid-cursor`, `stale-cursor`, `stale-item`,
`branch-unavailable`, `frame-too-large`, `response-too-large`, `unavailable` and
`busy`. A stale page/body generation includes the current `epoch`; a changed body
includes its current `revision`. Restart the respective read without its cursor.

## Ordering and cursors

The first page contains the latest items in ascending display order. `before`
takes only `previousCursor` and returns the next older slice, also ascending.
Ordering is `(timestamp, physical source order, item ID)`; missing timestamps sort
before dated items. Keep the returned order; `orderKey` is an opaque identity for
that tuple, not a string to sort lexicographically.

Page cursors are authenticated, encrypted keysets containing the owner, canonical
session, branch, index epoch, ancestry fingerprint, insertion fence and last
ordering tuple. The durable key survives worker restarts. The insertion fence
excludes items first indexed after the traversal began, including older backfill,
so appends cannot shift or duplicate the older pages. Existing item revisions may
still change. Start a fresh traversal to include newly indexed items.

Replay and explicit source rotation advance the session epoch. Item body cursors
also bind the item, revision and byte offset. A cursor from another session,
branch, item or API is refused. Cursor formats are private to the daemon.

`changeCursor` is a stable comparison watermark over session changes and coverage.
Compare it with a fresh page to detect changes; it is not a delta cursor and cannot
be passed as `before`. Delta/watch reads are deferred.

Optional `branch` is an indexed Claude item ID at the desired ancestry tip. It
includes all content blocks for ancestor message UUIDs and excludes siblings.
Missing, cyclic or more than 2,048 ancestors, and providers without indexed item
ancestry, return `branch-unavailable`. Omitting it returns all indexed items.

## Authorization and adapters

The daemon supplies its owner identity; request bodies cannot override it. Reads
authorize against indexed sessions, including inactive ones. A canonical record
ID is preferred; a native provider ID works when unique for the local owner.
Known live window aliases can be translated to a record ID without reading files.
Foreign canonical IDs and foreign control-envelope owners are refused. No remote
device ID can be used to locate a local transcript or choose a filesystem path.
Control-envelope refusals retain the existing `routing-error` response shape.

- Control socket: messages above, optionally in the existing owner envelope.
- Phone LAN: authenticated `POST /history/page` and `POST /history/item`, with
  the corresponding request fields. These routes require the existing bearer
  authorization header, not a query-string token.
- Phone relay: the same routes inside the authenticated encrypted relay. Valid
  history reads bypass the send retry/dedup cache and mutation serialization,
  including history messages sent through `/control`.
- MCP: `conch_history` and `conch_item` use the same fields without `kind` and
  return JSON in a text result. `session: "self"` requires verified MCP caller
  binding. Explicit indexed IDs work without the live session registry.

Runtime reads are limited to eight in flight. A starting, stopped or unavailable
worker returns a bounded status/error; reads never start one themselves.

## PR 7b handoff

Keep the existing snapshot preview caps. Build full history as a separate reader:

- Retain stable item IDs and server order. Before prepending, capture the first
  visible item ID and its pixel offset, then restore that anchor after layout.
- Merge refreshed items by ID/revision. Cancel or discard responses for a former
  session, branch or reader generation. Do not mix pages from different epochs.
- On stale cursors, refresh and restore the anchor if it still exists. Restart a
  stale body read and discard its old chunks; do not concatenate revisions.
- Show off, incomplete/replaying coverage and recoverable errors distinctly from
  an empty conversation. Offer retry for `busy`/`unavailable`.
- Fetch bodies on demand and virtualize long histories. Decode structured bodies
  after the final chunk. A `null` continuation marks the end of that read.
- Wire workspace selection notification for ingestion priority separately; the
  daemon's existing selected/live priority is unchanged here.

This PR does not add search, a session catalogue, turn/usage or receipt paging,
attachment downloads, a change stream, or any app changes. The API supplies stable
anchors; pixel-level scroll preservation remains a PR 7b UI test.

## Verified results (2026-09-16)

- Full `bun test`: 2,152 passed, zero failed; 19,889 assertions across 202 files;
  exit 0. `DEVELOPER_DIR=/Library/Developer/CommandLineTools` was set for the test
  process, with config, provider, log, state and IPC overrides in temporary paths.
- `bunx tsc --noEmit`: exit 0.
- Five mutation checks each had baseline exit 0, mutant exit 1 and restored exit 0:
  removing the cursor epoch comparison, raising the payload ceiling to 128 KiB,
  bypassing indexed owner checks, replacing the off response with unavailable,
  and treating relay history POSTs as cached mutations. Restoration used Python
  string replacement and verified exact equality with the original file.
- Tests cover a real fixture-backed worker → control socket → phone route, inactive
  indexed sessions, ownership refusals, stable paging anchors, source replay and
  rotation, revision changes, numeric content-block order, Unicode/escaped body
  chunking, relay retries, MCP binding and repository instruction generation.
- No real transcript smoke run or app build was performed. The running daemon,
  live sessions and real records directory were not used.
