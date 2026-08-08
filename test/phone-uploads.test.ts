import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneUploads, sanitizeExtension, sanitizeUploadId } from "../src/phone-uploads.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("images arriving from the phone in pieces", () => {
  test("reassembles in index order, not arrival order", async () => {
    // A relay that reconnects mid-upload does not guarantee arrival order, so
    // appending as chunks land would corrupt the file.
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      const id = "abc123def";
      expect(await uploads.accept({ uploadId: id, index: 2, total: 3, extension: "png", data: b64("C") }))
        .toEqual({ received: 1, total: 3 });
      expect(await uploads.accept({ uploadId: id, index: 0, total: 3, extension: "png", data: b64("A") }))
        .toEqual({ received: 2, total: 3 });
      const done = await uploads.accept({ uploadId: id, index: 1, total: 3, extension: "png", data: b64("B") });
      expect((done as any).path).toBe(join(dir, `${id}.png`));
      expect(readFileSync((done as any).path, "utf8")).toBe("ABC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a retried chunk overwrites itself rather than duplicating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-uploads-"));
    try {
      const uploads = new PhoneUploads(dir);
      const id = "retry001";
      await uploads.accept({ uploadId: id, index: 0, total: 2, extension: "jpg", data: b64("AA") });
      await uploads.accept({ uploadId: id, index: 0, total: 2, extension: "jpg", data: b64("AA") });
      const done = await uploads.accept({ uploadId: id, index: 1, total: 2, extension: "jpg", data: b64("BB") });
      expect(readFileSync((done as any).path, "utf8")).toBe("AABB");
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
      await uploads.accept({ uploadId: "toobig01", index: 0, total: 2, extension: "png", data: big });
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
