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
import { mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Formats Claude accepts. HEIC is absent, which is what an iPhone shoots. */
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

/**
 * 5 MB is the per-image API limit. A 1568px image lands far under it; this
 * exists to refuse something pathological rather than to shape normal uploads.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
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
    if (!extension) return { error: "unsupported image type" };
    if (!Number.isInteger(chunk.total) || chunk.total < 1 || chunk.total > 256) {
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
    const pending = this.#pending.get(id) ?? {
      chunks: new Map<number, Uint8Array>(),
      total: chunk.total,
      extension,
      bytes: 0,
      startedAt: this.#now(),
    };
    if (pending.total !== chunk.total) return { error: "chunk count changed mid-upload" };

    const replaced = pending.chunks.get(chunk.index);
    pending.bytes += bytes.length - (replaced?.length ?? 0);
    if (pending.bytes > MAX_UPLOAD_BYTES) {
      this.#pending.delete(id);
      return { error: "image too large" };
    }
    pending.chunks.set(chunk.index, bytes);
    this.#pending.set(id, pending);

    if (pending.chunks.size < pending.total) {
      return { received: pending.chunks.size, total: pending.total };
    }

    const ordered = new Uint8Array(pending.bytes);
    let offset = 0;
    for (let i = 0; i < pending.total; i += 1) {
      const part = pending.chunks.get(i)!;
      ordered.set(part, offset);
      offset += part.length;
    }
    this.#pending.delete(id);

    mkdirSync(this.#directory, { recursive: true });
    const path = join(this.#directory, `${id}.${pending.extension}`);
    await Bun.write(path, ordered);
    return { path, received: pending.total, total: pending.total };
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
