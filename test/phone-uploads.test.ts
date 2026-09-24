import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneUploads, sanitizeExtension, sanitizeUploadId } from "../src/phone-uploads.ts";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
/** A first chunk that is what it says: every upload's type is checked on its bytes. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe("images arriving from the phone in pieces", () => {
  test("reassembles in index order, not arrival order", async () => {
    // A relay that reconnects mid-upload does not guarantee arrival order, so
    // appending as chunks land would corrupt the file.
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      const id = "abc123def";
      expect(await uploads.accept({ uploadId: id, index: 2, total: 3, extension: "png", data: b64("C") }))
        .toEqual({ received: 1, total: 3, missing: [0, 1] });
      expect(await uploads.accept({ uploadId: id, index: 0, total: 3, extension: "png", data: b64(Buffer.concat([PNG, Buffer.from("A")])) }))
        .toEqual({ received: 2, total: 3, missing: [1] });
      const done = await uploads.accept({ uploadId: id, index: 1, total: 3, extension: "png", data: b64("B") });
      expect((done as any).path).toBe(join(dir, `${id}.png`));
      expect(readFileSync((done as any).path).subarray(8).toString()).toBe("ABC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a retried chunk overwrites itself rather than duplicating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      const id = "retry001";
      await uploads.accept({ uploadId: id, index: 0, total: 2, extension: "jpg", data: b64(Buffer.concat([JPG, Buffer.from("AA")])) });
      await uploads.accept({ uploadId: id, index: 0, total: 2, extension: "jpg", data: b64(Buffer.concat([JPG, Buffer.from("AA")])) });
      const done = await uploads.accept({ uploadId: id, index: 1, total: 2, extension: "jpg", data: b64("BB") });
      expect(readFileSync((done as any).path).subarray(4).toString()).toBe("AABB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses formats Claude cannot read", () => {
    // HEIC is the one that matters: it is what an iPhone shoots by default and
    // Claude does not accept it, so it must be converted before it gets here.
    expect(sanitizeExtension("heic")).toBeNull();
    expect(sanitizeExtension("HEIC")).toBeNull();
    expect(sanitizeExtension("jpeg")).toBe("jpg");
    expect(sanitizeExtension(".PNG")).toBe("png");
    expect(sanitizeExtension("webp")).toBe("webp");
  });

  test("an upload id cannot escape the upload directory", () => {
    expect(sanitizeUploadId("../../etc/passwd")).toBeNull();
    expect(sanitizeUploadId("a/b")).toBeNull();
    expect(sanitizeUploadId("short")).toBeNull();
    expect(sanitizeUploadId("fine-Upload_1")).toBe("fine-Upload_1");
  });

  test("rejects an image beyond the API's per-image limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      const big = Buffer.alloc(3 * 1024 * 1024, 1).toString("base64");
      await uploads.accept({ uploadId: "toobig01", index: 0, total: 2, extension: "png", data: b64(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 1)])) });
      expect(await uploads.accept({ uploadId: "toobig01", index: 1, total: 2, extension: "png", data: big }))
        .toEqual({ error: "image too large" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a malformed chunk rather than writing a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      expect(await uploads.accept({ uploadId: "ok123456", index: 5, total: 3, extension: "png", data: b64("x") }))
        .toEqual({ error: "bad chunk index" });
      expect(await uploads.accept({ uploadId: "ok123456", index: 0, total: 0, extension: "png", data: b64("x") }))
        .toEqual({ error: "bad chunk count" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Tyler (09-25): "vise versa if possible": the phone's own recordings, to the Mac. A video, its sound for whisper, and
// the contact sheet of its frames arrive by the same pieces as a picture; every rule that keeps that safe is here.
describe("videos and their recordings, by the same pieces", () => {
  const { chmodSync, existsSync, lstatSync, statSync, symlinkSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { MAX_PENDING_BYTES, MAX_PENDING_UPLOADS, RECORDING_MAX_BYTES, VIDEO_MAX_BYTES } = require("../src/phone-uploads.ts") as typeof import("../src/phone-uploads.ts");
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom")]);
  /** A WAV header: 16 kHz mono 16-bit unless told otherwise. */
  const wav = (rate = 16_000, channels = 1, bits = 16, body = Buffer.alloc(32)) => {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + body.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * channels * bits / 8, 28); header.writeUInt16LE(channels * bits / 8, 32); header.writeUInt16LE(bits, 34);
    header.write("data", 36); header.writeUInt32LE(body.length, 40);
    return Buffer.concat([header, body]);
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "conch-uploads-video-"));
  const piece = (uploadId: string, index: number, total: number, extension: string, data: Buffer | string) =>
    ({ uploadId, index, total, extension, data: b64(data) });

  test("a type is told by its bytes, not its name", async () => {
    const dir = scratch();
    try {
      const uploads = new PhoneUploads(dir);
      expect(await uploads.accept(piece("fakepng01", 0, 1, "png", "not a png at all"))).toEqual({ error: "not a image: its bytes don't match .png" });
      expect(await uploads.accept(piece("fakemp401", 0, 1, "mp4", "RIFFxxxxWAVEfmt "))).toMatchObject({ error: expect.stringMatching(/not a video/) });
      for (const [rate, channels, bits] of [[44_100, 1, 16], [16_000, 2, 16], [16_000, 1, 32]] as const) {
        expect(await uploads.accept(piece(`badwav${rate}${channels}${bits}`, 0, 1, "wav", wav(rate, channels, bits))))
          .toMatchObject({ error: expect.stringMatching(/not a recording/) });
      }
      expect(await uploads.accept(piece("goodmp401", 0, 1, "mp4", MP4))).toMatchObject({ path: join(dir, "goodmp401.mp4") });
      expect(await uploads.accept(piece("goodwav01", 0, 1, "wav", wav()))).toMatchObject({ path: join(dir, "goodwav01.wav") });
      // A first chunk resent as something else ends the upload rather than slipping in.
      expect(await uploads.accept(piece("swapped01", 0, 2, "mp4", MP4))).toMatchObject({ missing: [1] });
      expect(await uploads.accept(piece("swapped01", 0, 2, "mp4", "garbage bytes here"))).toMatchObject({ error: expect.stringMatching(/not a video/) });
      expect(await uploads.accept(piece("swapped01", 1, 2, "mp4", "tail"))).toMatchObject({ missing: [0] });
      expect(await uploads.accept(piece("htmlinmp4", 0, 1, "html", "<script>"))).toEqual({ error: "unsupported upload type" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each kind has its own cap: a video 48 MB, a recording 8 MB", async () => {
    const dir = scratch();
    try {
      const uploads = new PhoneUploads(dir);
      await uploads.accept(piece("bigvideo1", 0, 2, "mp4", MP4));
      expect(await uploads.accept(piece("bigvideo1", 1, 2, "mp4", Buffer.alloc(VIDEO_MAX_BYTES)))).toEqual({ error: "video too large" });
      await uploads.accept(piece("bigsound1", 0, 2, "wav", wav()));
      expect(await uploads.accept(piece("bigsound1", 1, 2, "wav", Buffer.alloc(RECORDING_MAX_BYTES)))).toEqual({ error: "recording too large" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumable: a reply lists what is missing, and a finished upload sent again is answered, not written twice", async () => {
    const dir = scratch();
    try {
      const uploads = new PhoneUploads(dir);
      expect(await uploads.accept(piece("resume001", 0, 4, "mp4", MP4))).toMatchObject({ received: 1, missing: [1, 2, 3] });
      expect(await uploads.accept(piece("resume001", 2, 4, "mp4", "C"))).toMatchObject({ missing: [1, 3] });
      // The link dropped; the phone resends its first chunk and learns what is still to send.
      expect(await uploads.accept(piece("resume001", 0, 4, "mp4", MP4))).toMatchObject({ received: 2, missing: [1, 3] });
      await uploads.accept(piece("resume001", 1, 4, "mp4", "B"));
      const done = await uploads.accept(piece("resume001", 3, 4, "mp4", "D"));
      expect(done).toMatchObject({ path: join(dir, "resume001.mp4"), missing: [] });
      const written = statSync(join(dir, "resume001.mp4")).mtimeMs;
      expect(await uploads.accept(piece("resume001", 3, 4, "mp4", "D"))).toMatchObject({ path: join(dir, "resume001.mp4"), missing: [] });
      expect(statSync(join(dir, "resume001.mp4")).mtimeMs).toBe(written);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("what is held unfinished is bounded, and forgotten after ten minutes", async () => {
    const dir = scratch();
    try {
      let now = 1_000_000;
      const uploads = new PhoneUploads(dir, () => now);
      for (let index = 0; index < MAX_PENDING_UPLOADS; index += 1) {
        expect(await uploads.accept(piece(`pending0${index}`, 0, 2, "mp4", MP4))).toMatchObject({ missing: [1] });
      }
      expect(await uploads.accept(piece("oneTooMany", 0, 2, "mp4", MP4))).toMatchObject({ error: expect.stringMatching(/too many uploads/) });
      // Ten minutes on, an unfinished upload is gone: its chunks are asked for again from the start.
      now += 10 * 60 * 1000 + 1;
      expect(await uploads.accept(piece("pending02", 1, 2, "mp4", "tail"))).toMatchObject({ received: 1, missing: [0] });

      // The bytes held over all of them are bounded too.
      const bytes = new PhoneUploads(scratch());
      const big = Buffer.alloc(Math.ceil(MAX_PENDING_BYTES / 2) + 1);
      await bytes.accept(piece("heldBytes1", 0, 3, "mp4", MP4));
      expect(await bytes.accept(piece("heldBytes1", 1, 3, "mp4", big))).toMatchObject({ missing: [2] });
      await bytes.accept(piece("heldBytes2", 0, 3, "mp4", MP4));
      expect(await bytes.accept(piece("heldBytes2", 1, 3, "mp4", big))).toMatchObject({ error: expect.stringMatching(/too much is being uploaded/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an upload still arriving is never forgotten: the ten minutes count from its last piece", async () => {
    // A 46 MB video is 736 pieces, one after another; over a slow uplink each takes most of a second, so the whole of
    // it runs past ten minutes. Counted from its first piece, it was swept while still arriving, the Mac asked for
    // piece 0 again, and the phone sent the video round and round for as long as it had signal.
    const dir = scratch();
    try {
      let now = 1_000_000;
      const uploads = new PhoneUploads(dir, () => now);
      const total = 736;
      let next: number | undefined = 0;
      let sent = 0;
      let path: string | undefined;
      while (next !== undefined && sent < 2 * total) {
        const reply = await uploads.accept(piece("slowvideo01", next, total, "mp4", next === 0 ? MP4 : "x"));
        sent += 1;
        now += 900;
        if ("error" in reply) throw new Error(reply.error);
        if (reply.path) { path = reply.path; break; }
        next = reply.missing?.[0];
      }
      expect(sent).toBe(total);
      expect(path).toBe(join(dir, "slowvideo01.mp4"));
      // One left alone that long is still forgotten.
      await uploads.accept(piece("idlevideo01", 0, 2, "mp4", MP4));
      now += 10 * 60 * 1000 + 1;
      expect(await uploads.accept(piece("idlevideo01", 1, 2, "mp4", "tail"))).toMatchObject({ received: 1, missing: [0] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("written 0600 in a 0700 folder, and never through anything already at its name", async () => {
    const dir = scratch();
    try {
      chmodSync(dir, 0o755);
      const uploads = new PhoneUploads(dir);
      const done = await uploads.accept(piece("private01", 0, 1, "mp4", MP4)) as { path: string };
      expect(statSync(done.path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      // A link planted where the next upload would land is not followed.
      const outside = join(mkdtempSync(join(tmpdir(), "conch-outside-")), "target.mp4");
      writeFileSync(outside, "keep");
      symlinkSync(outside, join(dir, "planted02.mp4"));
      expect(lstatSync(join(dir, "planted02.mp4")).isSymbolicLink()).toBe(true);
      // Neither written through nor handed back as a finished upload.
      expect(await uploads.accept(piece("planted02", 0, 1, "mp4", MP4))).toEqual({ error: "the upload couldn't be written" });
      // Finished first, then the link: the write itself refuses to follow it.
      await uploads.accept(piece("planted03", 0, 2, "mp4", MP4));
      symlinkSync(outside, join(dir, "planted03.mp4"));
      expect(await uploads.accept(piece("planted03", 1, 2, "mp4", "tail"))).toEqual({ error: "the upload couldn't be written" });
      expect(readFileSync(outside, "utf8")).toBe("keep");
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
