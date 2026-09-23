import { createHash } from "node:crypto";
import type { RecordObject, RecordProvider } from "./records-types.ts";

// 2: one provider message is one item (its blocks are no longer separate rows), items
// carry the provider's parent id, and tool identity is explicit. Existing stores replay
// into that shape on their next read rather than showing two normalizers' output at once.
// Per provider, so a fix to one re-reads only its transcripts (1.75 GB each, 2026-09-23).
// codex 3: Codex's injected context is no longer stored as Tyler's words.
export const RECORD_PARSER_VERSION = { claude: 2, codex: 3 } as const satisfies Record<RecordProvider, number>;
export const SOURCE_PROBE_BYTES = 256;

export interface StoredRecordSource {
  id: string;
  sessionId: string;
  path: string;
  device: string;
  inode: string;
  size: number;
  modifiedMs: number;
  generation: number;
  offset: number;
  prefixHash: string;
  prefixLength: number;
  checkpointHash: string;
  checkpointLength: number;
  parserVersion: number;
  state: RecordObject;
  malformedLines: number;
}

/** PR 6 will read these bounded ranges from disk. This layer never opens a transcript. */
export interface RecordSourceRead {
  id: string;
  /** Cursor observed before reading; null means the source was not indexed yet. */
  expected: { generation: number; offset: number } | null;
  path: string;
  device: string;
  inode: string;
  size: number;
  modifiedMs: number;
  prefix: Uint8Array;
  /** Up to 256 bytes immediately before the previous committed offset. */
  checkpoint: Uint8Array;
  from: number;
  bytes: Uint8Array;
}

export function recordFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function inspectRecordSource(previous: StoredRecordSource | undefined, read: RecordSourceRead, parserVersion: number): {
  change: "new" | "append" | "rewrite" | "rotation";
  generation: number;
  from: number;
} {
  if (!previous) return { change: "new", generation: 1, from: 0 };
  // Parser state and projections must be rebuilt even if the file rotated at the same time.
  if (previous.parserVersion !== parserVersion) {
    return { change: "rewrite", generation: previous.generation + 1, from: 0 };
  }
  const rotated = previous.device !== read.device || previous.inode !== read.inode;
  const rewritten = read.size < previous.offset
    || read.size < previous.size
    || recordFingerprint(read.prefix.subarray(0, previous.prefixLength)) !== previous.prefixHash
    || recordFingerprint(read.checkpoint) !== previous.checkpointHash
    || (previous.offset > 0 && read.size === previous.size
      && read.modifiedMs !== previous.modifiedMs);
  if (rotated || rewritten) return { change: rotated ? "rotation" : "rewrite", generation: previous.generation + 1, from: 0 };
  return { change: "append", generation: previous.generation, from: previous.offset };
}

/** Offsets count bytes, not characters. An incomplete line, including split UTF-8, stays unread. */
export function completeRecordLines(bytes: Uint8Array, from: number): {
  lines: { offset: number; length: number; bytes: Uint8Array }[];
  consumed: number;
} {
  const lines: { offset: number; length: number; bytes: Uint8Array }[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 10) continue;
    lines.push({ offset: from + start, length: index - start + 1, bytes: bytes.subarray(start, index) });
    start = index + 1;
  }
  return { lines, consumed: start };
}
