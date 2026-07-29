/** Turn a markdown reply into something worth hearing. */

import { open as openFile, type FileHandle } from "node:fs/promises";

export function stripMarkdown(md: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images -> their text
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

/**
 * First N sentences, kept WHOLE under the char cap — a mid-sentence chop
 * here silently swallowed words between announcement and read-aloud
 * (observed live). Only a single over-cap monster sentence still gets cut.
 */
export function firstSentences(text: string, count: number, maxChars: number): string {
  const parts = splitSentences(text).slice(0, count);
  const out: string[] = [];
  let len = 0;
  for (const s of parts) {
    if (out.length && len + s.length + 1 > maxChars) break;
    out.push(s);
    len += s.length + 1;
  }
  let joined = out.join(" ");
  if (joined.length > maxChars) joined = joined.slice(0, maxChars);
  return joined.trim();
}

/**
 * How many leading sentences are fully contained in the announcement?
 * The reader resumes AFTER what was actually spoken — never assume.
 */
export function countCoveredSentences(announce: string, sentences: string[]): number {
  let covered = 0;
  let offset = 0;
  for (const s of sentences) {
    const sentence = s.trim();
    const at = announce.indexOf(sentence, offset);
    if (at === -1) break;
    covered++;
    offset = at + sentence.length;
  }
  return covered;
}

export const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TRANSCRIPT_CACHE_CAP = 64;
const utf8 = new TextDecoder();

export interface TranscriptVersion {
  size: number;
  mtimeNs: string;
  /** File identity catches an atomic replacement even if size/mtime collide. */
  dev?: string;
  ino?: string;
}

export interface OpenTranscriptFile {
  version: TranscriptVersion;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): void | Promise<void>;
}

export interface TranscriptSource {
  open(transcriptPath: string): Promise<OpenTranscriptFile | null>;
}

export interface TranscriptReader {
  lastAssistantText(transcriptPath: string): Promise<string>;
  countUserPrompts(transcriptPath: string): Promise<number>;
}

interface AssistantAccumulator {
  texts: string[];
  error: unknown | null;
}

interface TranscriptAccumulator {
  assistant: AssistantAccumulator;
  /** Undefined until this path has received its one required full count scan. */
  userPrompts: number | undefined;
  /** Prompt counting rejects on a parseable-but-invalid schema, as before. */
  userPromptError: unknown | null;
}

interface TranscriptParseState {
  /** Reducer state after every newline-terminated line. */
  stable: TranscriptAccumulator;
  /** Raw unterminated final line, provisionally parsed for the public result. */
  trailing: Uint8Array;
}

interface TranscriptCacheEntry extends TranscriptParseState {
  version: TranscriptVersion;
}

type TranscriptRequirement = "assistant" | "prompts";

class TranscriptReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptReadError";
  }
}

function sameFileIdentity(a: TranscriptVersion, b: TranscriptVersion): boolean {
  return (a.dev === undefined || b.dev === undefined || a.dev === b.dev)
    && (a.ino === undefined || b.ino === undefined || a.ino === b.ino);
}

function sameVersion(a: TranscriptVersion, b: TranscriptVersion): boolean {
  return a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && sameFileIdentity(a, b);
}

function canAppend(previous: TranscriptVersion, next: TranscriptVersion): boolean {
  return next.size > previous.size && sameFileIdentity(previous, next);
}

function cloneAccumulator(accumulator: TranscriptAccumulator): TranscriptAccumulator {
  return {
    assistant: {
      texts: [...accumulator.assistant.texts],
      error: accumulator.assistant.error,
    },
    userPrompts: accumulator.userPrompts,
    userPromptError: accumulator.userPromptError,
  };
}

function cloneParseState(state: TranscriptParseState): TranscriptParseState {
  return {
    stable: cloneAccumulator(state.stable),
    trailing: state.trailing.slice(),
  };
}

function emptyParseState(countPrompts: boolean): TranscriptParseState {
  return {
    stable: {
      assistant: { texts: [], error: null },
      userPrompts: countPrompts ? 0 : undefined,
      userPromptError: null,
    },
    trailing: new Uint8Array(0),
  };
}

function parsedEntry(lineBytes: Uint8Array): { parsed: boolean; entry?: any } {
  const line = utf8.decode(lineBytes).trim();
  if (!line) return { parsed: false };
  try {
    return { parsed: true, entry: JSON.parse(line) };
  } catch {
    return { parsed: false }; // tolerate malformed and partial lines mid-write
  }
}

function isRealUserPrompt(entry: any): boolean {
  if (entry.origin?.kind === "task-notification" || entry.promptSource === "system") return false;
  const content = entry.message?.content;
  if (typeof content === "string" && content.startsWith("<task-notification>")) return false;
  return typeof content === "string"
    ? content.trim().length > 0
    : Array.isArray(content)
      && content.some((block: any) => block?.type === "text" && block.text?.trim());
}

function reduceAssistant(assistant: AssistantAccumulator, entry: any): void {
  try {
    if (entry.type === "user") {
      assistant.texts = [];
      assistant.error = null;
      return;
    }
    if (entry.type !== "assistant") return;

    const content: Array<{ type: string; text?: string }> = entry.message?.content ?? [];
    // A tool call is the stable boundary before the final response. It also
    // supersedes a malformed older assistant entry that the reverse parser
    // would never reach.
    if (content.some((part) => part.type === "tool_use")) {
      assistant.texts = [];
      assistant.error = null;
      return;
    }
    const texts = content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "");
    if (texts.length && assistant.error === null) assistant.texts.push(texts.join("\n"));
  } catch (error) {
    // Preserve the old reverse parser's rejection for a malformed assistant
    // schema, while still allowing a later user/tool boundary to supersede it.
    assistant.error = error;
  }
}

function reduceLine(accumulator: TranscriptAccumulator, lineBytes: Uint8Array): void {
  const parsed = parsedEntry(lineBytes);
  if (!parsed.parsed) return;
  const entry = parsed.entry;
  reduceAssistant(accumulator.assistant, entry);
  if (accumulator.userPrompts !== undefined && accumulator.userPromptError === null) {
    try {
      if (entry.type === "user" && isRealUserPrompt(entry)) accumulator.userPrompts++;
    } catch (error) {
      accumulator.userPromptError = error;
    }
  }
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (!first.length) return second;
  if (!second.length) return first;
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  return combined;
}

function concatByteParts(parts: Uint8Array[], length: number): Uint8Array {
  if (!length) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!.slice();
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

/** Commit complete lines and retain the final fragment for append reconstruction. */
function appendBytes(state: TranscriptParseState, bytes: Uint8Array): void {
  const combined = concatBytes(state.trailing, bytes);
  let lineStart = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== 0x0a) continue;
    reduceLine(state.stable, combined.subarray(lineStart, i));
    lineStart = i + 1;
  }
  state.trailing = combined.slice(lineStart);
}

function materializedAccumulator(state: TranscriptParseState): TranscriptAccumulator {
  const accumulator = cloneAccumulator(state.stable);
  if (state.trailing.length) reduceLine(accumulator, state.trailing);
  return accumulator;
}

function materializeAssistant(state: TranscriptParseState): string {
  const assistant = materializedAccumulator(state).assistant;
  if (assistant.error !== null) throw assistant.error;
  // Newline joins keep an entry-boundary code fence line-anchored.
  return assistant.texts.join("\n");
}

function materializePromptCount(state: TranscriptParseState): number {
  const accumulator = materializedAccumulator(state);
  if (accumulator.userPromptError !== null) throw accumulator.userPromptError;
  return accumulator.userPrompts ?? 0;
}

async function readExact(
  file: OpenTranscriptFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await file.read(offset, length);
  } catch (error) {
    throw new TranscriptReadError(error instanceof Error ? error.message : String(error));
  }
  if (bytes.length !== length) {
    throw new TranscriptReadError(
      `short transcript read: expected ${length} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

async function scanForward(
  file: OpenTranscriptFile,
  start: number,
  end: number,
  state: TranscriptParseState,
): Promise<void> {
  let lineParts = state.trailing.length ? [state.trailing] : [];
  let linePartsLength = state.trailing.length;
  state.trailing = new Uint8Array(0);

  for (let offset = start; offset < end;) {
    const length = Math.min(TRANSCRIPT_READ_CHUNK_BYTES, end - offset);
    const chunk = await readExact(file, offset, length);
    let lineStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const lineEnd = chunk.subarray(lineStart, i);
      if (lineParts.length) {
        lineParts.push(lineEnd);
        linePartsLength += lineEnd.length;
        reduceLine(state.stable, concatByteParts(lineParts, linePartsLength));
        lineParts = [];
        linePartsLength = 0;
      } else {
        reduceLine(state.stable, lineEnd);
      }
      lineStart = i + 1;
    }
    if (lineStart < chunk.length) {
      const rest = chunk.subarray(lineStart);
      lineParts.push(rest);
      linePartsLength += rest.length;
    }
    offset += length;
  }
  state.trailing = concatByteParts(lineParts, linePartsLength);
}

type TailAnchor =
  | { start: number; error: unknown | null }
  | null;

/**
 * Find the newest newline-terminated user/tool boundary in a byte window.
 * The final unterminated line is deliberately never an anchor: future bytes
 * may complete or mutate it, so it must stay in `trailing`.
 */
function findTailAnchor(bytes: Uint8Array, atStartOfFile: boolean): TailAnchor {
  let lineEnd = bytes.length;
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] !== 0x0a) continue;
    const lineStart = i + 1;
    const terminated = lineEnd < bytes.length && bytes[lineEnd] === 0x0a;
    if (terminated) {
      const parsed = parsedEntry(bytes.subarray(lineStart, lineEnd));
      if (parsed.parsed) {
        const entry = parsed.entry;
        try {
          if (entry.type === "user") return { start: lineEnd + 1, error: null };
          if (entry.type === "assistant") {
            const content: Array<{ type: string }> = entry.message?.content ?? [];
            if (content.some((part) => part.type === "tool_use")) {
              return { start: lineEnd + 1, error: null };
            }
          }
        } catch (error) {
          return { start: lineEnd + 1, error };
        }
      }
    }
    lineEnd = i;
  }

  if (!atStartOfFile) return null;
  return { start: 0, error: null };
}

/** Read backward only as far as the boundary that begins the final reply. */
async function scanAssistantTail(file: OpenTranscriptFile): Promise<TranscriptParseState> {
  let position = file.version.size;
  let nextLength = TRANSCRIPT_READ_CHUNK_BYTES;
  let window: Uint8Array = new Uint8Array(0);

  while (position > 0) {
    const length = Math.min(nextLength, position);
    position -= length;
    window = concatBytes(await readExact(file, position, length), window);
    const anchor = findTailAnchor(window, position === 0);
    if (anchor) {
      const state = emptyParseState(false);
      state.stable.assistant.error = anchor.error;
      appendBytes(state, window.subarray(anchor.start));
      return state;
    }
    nextLength = Math.min(nextLength * 2, Number.MAX_SAFE_INTEGER);
  }

  return emptyParseState(false);
}

function hasRequirement(entry: TranscriptCacheEntry, requirement: TranscriptRequirement): boolean {
  return requirement === "assistant" || entry.stable.userPrompts !== undefined;
}

async function closeQuietly(file: OpenTranscriptFile): Promise<void> {
  try {
    await file.close();
  } catch {}
}

/**
 * A path/size/mtime cache shared by reply-tail reads and prompt counts.
 *
 * - Initial assistant reads walk backward from EOF to the nearest boundary.
 * - The first exact prompt count streams the file once in bounded chunks.
 * - Append-only growth consumes exactly the newly appended byte range.
 * - The raw final fragment stays provisional so a partial JSON line can become
 *   valid after a later append without rereading any old bytes.
 */
export function createTranscriptReader(
  source: TranscriptSource,
  cacheCap = DEFAULT_TRANSCRIPT_CACHE_CAP,
): TranscriptReader {
  if (!Number.isSafeInteger(cacheCap) || cacheCap < 1) {
    throw new Error("cacheCap must be a positive safe integer");
  }
  const cache = new Map<string, TranscriptCacheEntry>();
  const pending = new Map<string, Promise<void>>();

  const remember = (transcriptPath: string, entry: TranscriptCacheEntry): void => {
    cache.delete(transcriptPath);
    cache.set(transcriptPath, entry);
    while (cache.size > cacheCap) {
      const oldestPath = cache.keys().next().value;
      if (oldestPath === undefined) break;
      cache.delete(oldestPath);
    }
  };

  const load = async (
    transcriptPath: string,
    requirement: TranscriptRequirement,
  ): Promise<TranscriptCacheEntry | null> => {
    for (;;) {
      const inFlight = pending.get(transcriptPath);
      if (inFlight) {
        await inFlight.catch(() => {});
        continue; // Re-open and re-stat after the older version settles.
      }

      let file: OpenTranscriptFile | null;
      try {
        file = await source.open(transcriptPath);
      } catch {
        file = null;
      }
      if (!file) {
        cache.delete(transcriptPath);
        return null;
      }

      const raced = pending.get(transcriptPath);
      if (raced) {
        await closeQuietly(file);
        await raced.catch(() => {});
        continue;
      }

      const version = file.version;
      const cached = cache.get(transcriptPath);
      if (cached && sameVersion(cached.version, version) && hasRequirement(cached, requirement)) {
        await closeQuietly(file);
        remember(transcriptPath, cached);
        return cached;
      }

      const refresh = (async (): Promise<void> => {
        try {
          let state: TranscriptParseState;
          if (
            cached
            && canAppend(cached.version, version)
            && (requirement === "assistant" || cached.stable.userPrompts !== undefined)
          ) {
            state = cloneParseState(cached);
            await scanForward(file!, cached.version.size, version.size, state);
          } else if (requirement === "prompts") {
            state = emptyParseState(true);
            await scanForward(file!, 0, version.size, state);
          } else {
            state = await scanAssistantTail(file!);
          }
          remember(transcriptPath, { ...state, version });
        } finally {
          await closeQuietly(file!);
        }
      })();
      pending.set(transcriptPath, refresh);

      try {
        await refresh;
      } catch (error) {
        // Match the old file readers: transient I/O yields an empty result and
        // is never cached, so the next render/gate retries.
        if (error instanceof TranscriptReadError) return null;
        throw error;
      } finally {
        if (pending.get(transcriptPath) === refresh) pending.delete(transcriptPath);
      }

      const loaded = cache.get(transcriptPath);
      if (loaded && sameVersion(loaded.version, version) && hasRequirement(loaded, requirement)) {
        return loaded;
      }
    }
  };

  return {
    async lastAssistantText(transcriptPath) {
      const entry = await load(transcriptPath, "assistant");
      return entry ? materializeAssistant(entry) : "";
    },
    async countUserPrompts(transcriptPath) {
      const entry = await load(transcriptPath, "prompts");
      return entry ? materializePromptCount(entry) : 0;
    },
  };
}

const transcriptReader = createTranscriptReader({
  async open(transcriptPath) {
    let handle: FileHandle | undefined;
    try {
      handle = await openFile(transcriptPath, "r");
      const transcriptHandle = handle;
      const info = await transcriptHandle.stat({ bigint: true });
      if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        await transcriptHandle.close();
        return null;
      }
      const version: TranscriptVersion = {
        size: Number(info.size),
        mtimeNs: String(info.mtimeNs),
        dev: String(info.dev),
        ino: String(info.ino),
      };
      return {
        version,
        async read(offset, length) {
          const bytes = new Uint8Array(length);
          let total = 0;
          while (total < length) {
            const { bytesRead } = await transcriptHandle.read(
              bytes,
              total,
              length - total,
              offset + total,
            );
            if (!bytesRead) break;
            total += bytesRead;
          }
          return total === length ? bytes : bytes.subarray(0, total);
        },
        close: () => transcriptHandle.close(),
      };
    } catch {
      if (handle) await handle.close().catch(() => {});
      return null;
    }
  },
});

/**
 * The FINAL message of the last turn, not just any trailing text block.
 *
 * A turn's transcript looks like: interim text -> tool calls -> interim
 * text -> tool calls -> final summary (possibly split across entries).
 * Naively taking "the last text seen" can surface a stale interim note
 * ("let me look into it") when the real ending says the work is done.
 * So: walk backwards, skip meta lines, and collect the trailing run of
 * assistant text — stopping at the first tool call or user entry, which
 * by construction is where the final message begins.
 */
export function lastAssistantText(transcriptPath: string): Promise<string> {
  return transcriptReader.lastAssistantText(transcriptPath);
}

/** How many times you'd prompted this session when a turn fired — the "where we were" mark. */
export async function transcriptMark(transcriptPath: string): Promise<number> {
  return transcriptReader.countUserPrompts(transcriptPath);
}

/**
 * True if you typed another prompt to this session since `mark` — i.e. you already
 * responded directly and the conversation moved on, so conch shouldn't still read
 * that turn aloud or nag you for input on it. Counting prompt ENTRIES (not lines)
 * is robust to trailing newlines and interleaved tool_result/meta entries.
 */
export async function userRespondedSince(
  transcriptPath: string | undefined,
  mark: number | undefined,
): Promise<boolean> {
  if (!transcriptPath || mark == null) return false;
  return (await transcriptReader.countUserPrompts(transcriptPath)) > mark;
}

/**
 * Does the tail of a reply actually solicit the user? Used to suppress
 * idle_prompt announcements for sessions that are just... idle ("I'll ping
 * you when it lands, enjoy the 4th") rather than blocked on an answer.
 */
export function looksLikeAwaitingReply(text: string): boolean {
  const tail = splitSentences(text).slice(-3).join(" ");
  if (tail.includes("?")) return true;
  return /\b(let me know|tell me|your call|which (one|way|option)|should i|do you want|want me to|say the word|waiting on you|give me the go)\b/i.test(tail);
}

export async function spokenSnippet(
  transcriptPath: string,
  sentences: number,
  maxChars: number,
): Promise<string> {
  // The Stop hook can fire before the final text is flushed to the
  // transcript; a couple of short retries beat announcing a stale line.
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await lastAssistantText(transcriptPath);
    if (text) return firstSentences(stripMarkdown(text), sentences, maxChars);
    await Bun.sleep(400);
  }
  return "";
}
