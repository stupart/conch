/**
 * Images from the phone, reassembled on the Mac.
 *
 * Claude Code takes images by PATH, not by bytes, so the job is to land the
 * file somewhere the session can read and hand back its path. The phone sends
 * it in pieces because a relay frame caps at 192 KiB and even a
 * correctly-sized photo exceeds that.
 *
 * Sizing is decided on the PHONE, not here — see `prepareForUpload` there. The
 * rule is Anthropic's own: an image whose long edge exceeds 1568px "will first
 * be scaled down", and sending one larger "will increase latency of
 * time-to-first-token, without giving you any additional model performance".
 * So the phone caps at exactly that, which is the most quality that survives
 * the trip rather than a bandwidth compromise.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What an upload may be, and how big, each told by its first bytes rather than its name: a file
 * that says `.png` and is anything else is refused. Images are what Claude accepts (HEIC, which is
 * what an iPhone shoots, is not among them). A video is what the phone transcodes to, H.264 in an
 * MP4; a recording is its sound, 16 kHz mono 16-bit PCM, the only shape whisper is handed.
 * Tyler (09-25): "vise versa if possible": the phone's own recordings, to the Mac.
 */
interface UploadKind {
  noun: string;
  /** The most bytes an upload of it may reach. */
  cap: number;
  is(head: Uint8Array): boolean;
}
const at = (bytes: Uint8Array, text: string, offset: number) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Ten seconds of 1080p would pass it; 720p H.264 runs two minutes (Show's longest) well under it. */
export const VIDEO_MAX_BYTES = 48 * 1024 * 1024;
/** 16 kHz mono 16-bit is 32 KB a second: two minutes is under 4 MB. */
export const RECORDING_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_KINDS: Readonly<Record<string, UploadKind>> = {
  jpg: { noun: "image", cap: 5 * 1024 * 1024, is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { noun: "image", cap: 5 * 1024 * 1024, is: (b) => PNG.every((byte, i) => b[i] === byte) },
  gif: { noun: "image", cap: 5 * 1024 * 1024, is: (b) => at(b, "GIF87a", 0) || at(b, "GIF89a", 0) },
  webp: { noun: "image", cap: 5 * 1024 * 1024, is: (b) => at(b, "RIFF", 0) && at(b, "WEBP", 8) },
  // ISO base media: an `ftyp` box first.
  mp4: { noun: "video", cap: VIDEO_MAX_BYTES, is: (b) => at(b, "ftyp", 4) },
  wav: { noun: "recording", cap: RECORDING_MAX_BYTES, is: isSpeechWav },
};
const ALLOWED_EXTENSIONS = new Set([...Object.keys(UPLOAD_KINDS), "jpeg"]);

/** A canonical WAV header for 16 kHz mono 16-bit PCM, and nothing else. */
function isSpeechWav(b: Uint8Array): boolean {
  if (b.length < 44 || !at(b, "RIFF", 0) || !at(b, "WAVE", 8) || !at(b, "fmt ", 12)) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1
    && view.getUint32(24, true) === 16_000 && view.getUint16(34, true) === 16;
}

/**
 * 5 MB is the per-image API limit. A 1568px image lands far under it; this
 * exists to refuse something pathological rather than to shape normal uploads.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** 64 KiB pieces (the phone's), a video's worth; the byte caps are what bound an upload. */
export const MAX_UPLOAD_CHUNKS = 1024;
/**
 * Unfinished uploads are held in memory, so they are bounded: this many at once, this many bytes
 * over all of them, and each gone ten minutes after it began.
 */
export const MAX_PENDING_UPLOADS = 4;
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
/** How many of the chunks still missing a reply lists: the phone sends those, and asks again. */
const MISSING_LISTED = 64;
/** An upload nobody finished is swept rather than kept forever. */
const UPLOAD_TTL_MS = 10 * 60 * 1000;

export interface UploadChunk {
  uploadId: string;
  index: number;
  total: number;
  extension: string;
  /** Base64, because this rides the same JSON control channel as everything else. */
  data: string;
}

interface PendingUpload {
  chunks: Map<number, Uint8Array>;
  total: number;
  extension: string;
  bytes: number;
  startedAt: number;
}

export interface UploadResult {
  /** Set once every chunk has arrived and the file is on disk. */
  path?: string;
  /** Chunks still outstanding, so the phone can show progress honestly. */
  received: number;
  total: number;
  /**
   * The first chunks still missing, lowest first, while the upload is unfinished: what makes it
   * resumable. After a dropped link or a Retry, the phone sends one chunk of the same upload and
   * then only what this lists, rather than everything again.
   */
  missing?: number[];
}

/** Reject anything that could escape the upload directory or confuse a reader. */
export function sanitizeUploadId(raw: string): string | null {
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  return id;
}

export function sanitizeExtension(raw: string): string | null {
  const ext = raw.trim().toLowerCase().replace(/^\./, "");
  return ALLOWED_EXTENSIONS.has(ext) ? (ext === "jpeg" ? "jpg" : ext) : null;
}

export class PhoneUploads {
  readonly #directory: string;
  readonly #pending = new Map<string, PendingUpload>();
  readonly #now: () => number;

  constructor(directory: string, now: () => number = Date.now) {
    this.#directory = directory;
    this.#now = now;
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * Take one chunk. Returns the finished path only on the last one.
   *
   * Chunks are keyed by index rather than appended, so a retried or reordered
   * chunk overwrites itself instead of corrupting the file — over a relay that
   * reconnects mid-upload, arrival order is not guaranteed.
   */
  async accept(chunk: UploadChunk): Promise<UploadResult | { error: string }> {
    const id = sanitizeUploadId(chunk.uploadId);
    if (!id) return { error: "bad upload id" };
    const extension = sanitizeExtension(chunk.extension);
    if (!extension) return { error: "unsupported upload type" };
    const kind = UPLOAD_KINDS[extension]!;
    if (!Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > MAX_UPLOAD_CHUNKS) {
      return { error: "bad chunk count" };
    }
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= chunk.total) {
      return { error: "bad chunk index" };
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    } catch {
      return { error: "bad chunk encoding" };
    }

    this.#sweep();
    const path = join(this.#directory, `${id}.${extension}`);
    // Finished already: a resend after a lost reply is answered, never written twice. Only a file
    // conch wrote counts; anything else at that name (a link) is never handed back as the upload.
    const there = this.#pending.has(id) ? undefined : lstatSync(path, { throwIfNoEntry: false });
    if (there) return there.isFile() ? { path, received: chunk.total, total: chunk.total, missing: [] } : { error: "the upload couldn't be written" };
    if (!this.#pending.has(id) && this.#pending.size >= MAX_PENDING_UPLOADS) {
      return { error: "too many uploads at once; send again once one has finished" };
    }
    // Its first bytes say what it is; a first chunk that is not what its name says ends the upload.
    if (chunk.index === 0 && !kind.is(bytes)) {
      this.#pending.delete(id);
      return { error: `not a ${kind.noun}: its bytes don't match .${extension}` };
    }
    const pending = this.#pending.get(id) ?? {
      chunks: new Map<number, Uint8Array>(),
      total: chunk.total,
      extension,
      bytes: 0,
      startedAt: this.#now(),
    };
    if (pending.total !== chunk.total || pending.extension !== extension) return { error: "upload changed mid-way" };
    const replaced = pending.chunks.get(chunk.index);
    const grown = bytes.length - (replaced?.length ?? 0);
    pending.bytes += grown;
    if (pending.bytes > kind.cap) {
      this.#pending.delete(id);
      return { error: `${kind.noun} too large` };
    }
    let held = 0;
    for (const other of this.#pending.values()) if (other !== pending) held += other.bytes;
    if (held + pending.bytes > MAX_PENDING_BYTES) {
      pending.bytes -= grown;
      return { error: "too much is being uploaded at once; send again once one has finished" };
    }
    pending.chunks.set(chunk.index, bytes);
    this.#pending.set(id, pending);

    if (pending.chunks.size < pending.total) {
      const missing: number[] = [];
      for (let i = 0; i < pending.total && missing.length < MISSING_LISTED; i += 1) if (!pending.chunks.has(i)) missing.push(i);
      return { received: pending.chunks.size, total: pending.total, missing };
    }

    const ordered = new Uint8Array(pending.bytes);
    let offset = 0;
    for (let i = 0; i < pending.total; i += 1) {
      const part = pending.chunks.get(i)!;
      ordered.set(part, offset);
      offset += part.length;
    }
    this.#pending.delete(id);

    // conch's own folder, its owner's alone, and each file too. Created, never opened: `wx` fails
    // rather than follow anything already at that name.
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    try {
      writeFileSync(path, ordered, { mode: 0o600, flag: "wx" });
    } catch {
      return { error: "the upload couldn't be written" };
    }
    return { path, received: pending.total, total: pending.total, missing: [] };
  }

  /** Drop uploads that were never finished, and old files on disk. */
  #sweep(): void {
    const cutoff = this.#now() - UPLOAD_TTL_MS;
    for (const [id, pending] of this.#pending) {
      if (pending.startedAt < cutoff) this.#pending.delete(id);
    }
    try {
      for (const name of readdirSync(this.#directory)) {
        const path = join(this.#directory, name);
        try {
          // A day, not ten minutes: a finished image is a real file the user may
          // still be talking about, and an agent may read it long after upload.
          if (statSync(path).mtimeMs < this.#now() - 24 * 60 * 60 * 1000) {
            rmSync(path, { force: true });
          }
        } catch {}
      }
    } catch {}
  }
}
