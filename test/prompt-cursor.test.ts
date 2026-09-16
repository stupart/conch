import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedMark,
  promptCursorPublisher,
  publishPromptCursor,
  readPromptCursor,
  recordDatabasePath,
} from "../src/prompt-cursor.ts";
import { RecordStore, type StoredPromptCursor } from "../src/records-store.ts";
import {
  createTranscriptReader,
  setPromptCursorSink,
  transcriptMark,
  type OpenTranscriptFile,
  type PromptCursor,
  type PromptResume,
  type TranscriptSource,
} from "../src/snippet.ts";

const directories: string[] = [];
const stores: RecordStore[] = [];
afterEach(() => {
  setPromptCursorSink(undefined);
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "conch-prompt-cursor-"));
  directories.push(path);
  return path;
}

function open(configDir: string): RecordStore {
  const store = new RecordStore({ configDir });
  stores.push(store);
  return store;
}

const encoder = new TextEncoder();
const prompt = (uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, parentUuid: null, message: { role: "user", content: text } }) + "\n";
const reply = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

/** A transcript with `turns` prompts, padded so a full scan is visibly more work. */
function transcript(turns: number, padding = 2048): string {
  let raw = "";
  for (let turn = 0; turn < turns; turn++) {
    raw += prompt(`u${turn}`, `ask ${turn}`);
    raw += reply(`answer ${turn} ${"x".repeat(padding)}`);
  }
  return raw;
}

function writeTranscript(raw: string): { path: string; configDir: string } {
  const root = directory();
  const path = join(root, "session.jsonl");
  writeFileSync(path, raw);
  return { path, configDir: join(root, "config") };
}

/** Publish through the real sink the daemon installs. */
async function publish(configDir: string, transcriptPath: string): Promise<StoredPromptCursor[]> {
  const store = open(configDir);
  const written: StoredPromptCursor[] = [];
  const publisher = promptCursorPublisher((cursor) => {
    written.push(cursor);
    store.putPromptCursor(cursor);
  });
  setPromptCursorSink(publisher);
  try {
    await transcriptMark(transcriptPath);
  } catch {
    // A count that raises publishes nothing — one of the cases under test.
  } finally {
    setPromptCursorSink(undefined);
  }
  return written;
}

class CountingSource implements TranscriptSource {
  bytesRead = 0;
  firstOffset: number | null = null;
  constructor(private readonly bytes: Uint8Array, private readonly inode = "1") {}
  async open(): Promise<OpenTranscriptFile | null> {
    return {
      version: { size: this.bytes.length, mtimeNs: "1", dev: "1", ino: this.inode },
      read: async (offset: number, length: number) => {
        if (this.firstOffset === null) this.firstOffset = offset;
        this.bytesRead += Math.min(length, Math.max(0, this.bytes.length - offset));
        return this.bytes.subarray(offset, offset + length);
      },
      close: () => {},
    };
  }
}

test("a hook resuming from a committed cursor counts exactly what a full scan counts", async () => {
  const raw = transcript(12);
  const { path, configDir } = writeTranscript(raw);
  const truth = await transcriptMark(path);
  expect(truth).toBe(12);

  const written = await publish(configDir, path);
  expect(written).toHaveLength(1);
  expect(written[0]!.offset).toBe(Buffer.byteLength(raw));
  expect(written[0]!.count).toBe(12);

  const resume = readPromptCursor(path, { configDir });
  expect(resume).toEqual({ from: Buffer.byteLength(raw), count: 12 });

  const seen: (PromptResume | undefined)[] = [];
  const mark = async (_path: string, value?: PromptResume) => {
    seen.push(value);
    return truth;
  };
  expect(await boundedMark({ recordsEnabled: true }, path, { configDir, mark })).toBe(truth);
  expect(seen).toEqual([resume!]);
});

test("records off never consults the store, even when it holds a wrong count", async () => {
  const raw = transcript(9);
  const { path, configDir } = writeTranscript(raw);
  const store = open(configDir);
  const observed = statSync(path, { bigint: true });
  // A cursor whose probes are valid but whose count is nonsense. Only the off
  // switch keeps it out of the answer, so this fails the moment the off path
  // starts reading cursors.
  const publisher = promptCursorPublisher((cursor) => store.putPromptCursor({ ...cursor, count: cursor.count + 50 }));
  setPromptCursorSink(publisher);
  try {
    await transcriptMark(path);
  } finally {
    setPromptCursorSink(undefined);
  }
  expect(store.promptCursor({ device: String(observed.dev), inode: String(observed.ino) })?.count).toBe(59);

  const seen: (PromptResume | undefined)[] = [];
  const mark = async (_path: string, value?: PromptResume) => {
    seen.push(value);
    return value ? value.count : 9;
  };
  expect(await boundedMark({ recordsEnabled: false }, path, { configDir, mark })).toBe(9);
  expect(seen).toEqual([undefined]);
});

test("a resumed count reads only the bytes appended after the cursor", async () => {
  const head = transcript(6);
  const appended = transcript(2);
  const bytes = encoder.encode(head + appended);
  const source = new CountingSource(bytes);
  const reader = createTranscriptReader(source);

  const resumed = await reader.countUserPrompts("session.jsonl", {
    from: Buffer.byteLength(head),
    count: 6,
  });

  expect(resumed).toBe(8);
  expect(source.firstOffset).toBe(Buffer.byteLength(head));
  expect(source.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(appended));
  expect(source.bytesRead).toBeLessThan(bytes.length / 2);

  const cold = new CountingSource(bytes);
  expect(await createTranscriptReader(cold).countUserPrompts("session.jsonl")).toBe(8);
  expect(cold.bytesRead).toBe(bytes.length);
});

test("an unusable cursor is ignored rather than trusted", async () => {
  const bytes = encoder.encode(transcript(5));
  const beyondEof = new CountingSource(bytes);
  expect(await createTranscriptReader(beyondEof).countUserPrompts("s.jsonl", { from: bytes.length + 1, count: 99 }))
    .toBe(5);
  const negative = new CountingSource(bytes);
  expect(await createTranscriptReader(negative).countUserPrompts("s.jsonl", { from: -10, count: 99 })).toBe(5);
});

test("a rewritten file fails its probes and falls back to a full scan", async () => {
  const { path, configDir } = writeTranscript(transcript(7));
  await publish(configDir, path);
  expect(readPromptCursor(path, { configDir })).not.toBeNull();

  // Same length class, different content: the prefix probe no longer matches.
  writeFileSync(path, transcript(7).replace(/ask/g, "ASK"));
  expect(readPromptCursor(path, { configDir })).toBeNull();

  const truncated = transcript(3);
  writeFileSync(path, truncated);
  expect(readPromptCursor(path, { configDir })).toBeNull();
});

test("a missing, unreadable or slow database falls back instead of waiting", async () => {
  const { path, configDir } = writeTranscript(transcript(4));
  expect(readPromptCursor(path, { configDir })).toBeNull();

  await publish(configDir, path);
  expect(readPromptCursor(path, { configDir })).not.toBeNull();

  expect(readPromptCursor(path, {
    configDir,
    openDatabase: () => { throw new Error("database is locked"); },
  })).toBeNull();

  let clock = 0;
  expect(readPromptCursor(path, { configDir, budgetMs: 5, now: () => (clock += 10) })).toBeNull();

  const marks: (PromptResume | undefined)[] = [];
  const mark = async (_path: string, resume?: PromptResume) => {
    marks.push(resume);
    return 4;
  };
  expect(await boundedMark({ recordsEnabled: true }, path, {
    configDir,
    mark,
    readCursor: () => { throw new Error("unavailable"); },
  })).toBe(4);
  expect(marks).toEqual([undefined]);
});

test("a count that raised before the cursor is never published", async () => {
  const raw = `${prompt("u0", "one")}null\n${prompt("u1", "two")}`;
  const { path, configDir } = writeTranscript(raw);
  await expect(transcriptMark(path)).rejects.toThrow();
  const written = await publish(configDir, path);
  expect(written).toEqual([]);
  expect(readPromptCursor(path, { configDir })).toBeNull();
});

test("the publisher skips an unchanged file and a file that changed under the count", async () => {
  const raw = transcript(3);
  const { path } = writeTranscript(raw);
  const observed = statSync(path, { bigint: true });
  const version = {
    size: Buffer.byteLength(raw), mtimeNs: String(observed.mtimeNs),
    dev: String(observed.dev), ino: String(observed.ino),
  };
  const cursor: PromptCursor = { from: Buffer.byteLength(raw), count: 3, version };

  const written: StoredPromptCursor[] = [];
  const publisher = promptCursorPublisher((stored) => written.push(stored));
  publisher(path, cursor);
  publisher(path, cursor);
  expect(written).toHaveLength(1);

  const stale: StoredPromptCursor[] = [];
  publishPromptCursor(path, { ...cursor, version: { ...version, size: version.size + 10 } }, (stored) => stale.push(stored));
  publishPromptCursor(path, { ...cursor, version: { ...version, ino: "999999" } }, (stored) => stale.push(stored));
  publishPromptCursor(path, { ...cursor, from: 0 }, (stored) => stale.push(stored));
  expect(stale).toEqual([]);
});

test("the store rejects a malformed cursor", () => {
  const store = open(directory());
  const valid: StoredPromptCursor = {
    device: "1", inode: "2", offset: 10, count: 1,
    prefixHash: "a".repeat(64), checkpointHash: "b".repeat(64), updatedAt: 1,
  };
  store.putPromptCursor(valid);
  expect(store.promptCursor({ device: "1", inode: "2" })).toEqual(valid);
  store.putPromptCursor({ ...valid, offset: 20, count: 2 });
  expect(store.promptCursor({ device: "1", inode: "2" })?.offset).toBe(20);
  expect(() => store.putPromptCursor({ ...valid, device: "" })).toThrow("invalid prompt cursor");
  expect(() => store.putPromptCursor({ ...valid, offset: -1 })).toThrow("invalid prompt cursor");
  expect(() => store.putPromptCursor({ ...valid, prefixHash: "nope" })).toThrow("invalid prompt cursor");
});

test("a cold process resumes from the cursor and agrees with a cold full scan", async () => {
  const raw = transcript(20);
  const { path, configDir } = writeTranscript(raw);
  await publish(configDir, path);

  const script = join(directory(), "cold-mark.ts");
  writeFileSync(script, `
import { boundedMark, readPromptCursor } from ${JSON.stringify(join(import.meta.dir, "../src/prompt-cursor.ts"))};
const [path, configDir] = process.argv.slice(2);
const resume = readPromptCursor(path, { configDir });
const on = await boundedMark({ recordsEnabled: true }, path, { configDir });
const off = await boundedMark({ recordsEnabled: false }, path, { configDir });
console.log(JSON.stringify({ resume, on, off }));
`);
  const run = Bun.spawnSync(["bun", "run", script, path, configDir], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  const result = JSON.parse(run.stdout.toString().trim());
  expect(result.on).toBe(20);
  expect(result.off).toBe(20);
  expect(result.resume).toEqual({ from: Buffer.byteLength(raw), count: 20 });
});
