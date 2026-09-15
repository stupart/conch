/** One UTF-8 JSON line, including its trailing LF, on every control transport. */
export const CONTROL_FRAME_MAX_BYTES = 64 * 1024;

export class ControlFrameError extends Error {
  constructor(readonly code: "frame-too-large" | "invalid-utf8" | "empty-frame" | "truncated-frame" | "invalid-json", message: string) {
    super(message);
  }
}

export function decodeControlText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ControlFrameError("invalid-utf8", "control frame is not valid UTF-8"); }
}

export function encodeControlFrame(line: string): Buffer {
  const frame = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
  if (frame.byteLength > CONTROL_FRAME_MAX_BYTES) throw new ControlFrameError("frame-too-large", "control frame exceeds 64 KiB including its newline");
  return frame;
}

/** Keep bytes until the delimiter: a socket read is not a Unicode boundary. */
export class ControlFrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private complete = false;

  push(chunk: Uint8Array): string | undefined {
    if (this.complete) return;
    const newline = chunk.indexOf(10);
    const bytes = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
    this.size += bytes.byteLength;
    if (this.size > CONTROL_FRAME_MAX_BYTES || (this.size === CONTROL_FRAME_MAX_BYTES && newline < 0)) {
      throw new ControlFrameError("frame-too-large", "control frame exceeds 64 KiB including its newline");
    }
    this.chunks.push(Buffer.from(bytes));
    if (newline < 0) return;
    this.complete = true;
    const line = decodeControlText(Buffer.concat(this.chunks, this.size).subarray(0, -1));
    this.chunks = [];
    if (!line.trim()) throw new ControlFrameError("empty-frame", "control frame is empty");
    return line;
  }

  end(): never {
    throw new ControlFrameError(this.size ? "truncated-frame" : "empty-frame", this.size ? "control frame ended before its newline" : "control reply was empty");
  }
}

/** Streaming HTTP bound; account for the LF the Unix forwarder must add. */
export async function readControlBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CONTROL_FRAME_MAX_BYTES) throw new ControlFrameError("frame-too-large", "control body exceeds 64 KiB");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CONTROL_FRAME_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ControlFrameError("frame-too-large", "control body exceeds 64 KiB");
      }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  const body = decodeControlText(Buffer.concat(chunks, size));
  encodeControlFrame(body);
  try { JSON.parse(body); } catch { throw new ControlFrameError("invalid-json", "control body is not valid JSON"); }
  return body;
}
