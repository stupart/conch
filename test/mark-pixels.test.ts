import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagePixelSize, pixelSizeOf, scenePixelsToFractions } from "../src/mark-pixels.ts";
import { checkReviewScene } from "../src/snippet.ts";

/**
 * Agent ink's numbers are fractions of the image, but an agent measures a screenshot in pixels, and marks landed off
 * by the ratio (2026-10-03). A mark may say `units: "px"`; conch divides by `size`, or by the image's own pixel size,
 * before the scene is checked, so everything after sees 0 to 1 as before.
 */

const folder = mkdtempSync(join(tmpdir(), "conch-mark-px-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with its height and width.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function gif(width: number, height: number): Buffer {
  const head = Buffer.alloc(10);
  head.write("GIF89a", 0, "latin1");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return head;
}

function bmp(width: number, height: number): Buffer {
  const head = Buffer.alloc(26);
  head.write("BM", 0, "latin1");
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  return head;
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const head = Buffer.alloc(30);
  head.write("RIFF", 0, "latin1");
  head.write("WEBP", 8, "latin1");
  head.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    head.writeUInt16LE(width, 26);
    head.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    const w = width - 1;
    const h = height - 1;
    head[21] = w & 0xff;
    head[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
    head[23] = (h >> 2) & 0xff;
    head[24] = (h >> 10) & 0x0f;
  } else {
    head.writeUIntLE(width - 1, 24, 3);
    head.writeUIntLE(height - 1, 27, 3);
  }
  return head;
}

const box = (frame: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({ v: 1, target: { kind: "auto" }, marks: [{ id: "cta", kind: "box", frame, rect: [320, 200, 640, 400], units: "px", ...extra }] });

describe("an image's own pixel size, from its header", () => {
  test("PNG, JPEG, GIF, BMP and the three WebPs", () => {
    expect(pixelSizeOf(png(1280, 800))).toEqual([1280, 800]);
    expect(pixelSizeOf(jpeg(3024, 4032))).toEqual([3024, 4032]);
    expect(pixelSizeOf(gif(320, 240))).toEqual([320, 240]);
    expect(pixelSizeOf(bmp(640, -480))).toEqual([640, 480]);
    expect(pixelSizeOf(webp("VP8 ", 800, 600))).toEqual([800, 600]);
    expect(pixelSizeOf(webp("VP8L", 1000, 750))).toEqual([1000, 750]);
    expect(pixelSizeOf(webp("VP8X", 4000, 3000))).toEqual([4000, 3000]);
  });

  test("nothing for what it can't read: an SVG, a truncated header, a zero size", () => {
    expect(pixelSizeOf(Buffer.from('<svg width="10" height="10"/>'))).toBeNull();
    expect(pixelSizeOf(png(1280, 800).subarray(0, 20))).toBeNull();
    expect(pixelSizeOf(png(0, 800))).toBeNull();
    expect(pixelSizeOf(Buffer.alloc(0))).toBeNull();
  });

  test("read off the disk, and nothing for a file that isn't there", async () => {
    const shot = join(folder, "shot.png");
    writeFileSync(shot, png(2880, 1800));
    expect(await imagePixelSize(shot)).toEqual([2880, 1800]);
    expect(await imagePixelSize(join(folder, "missing.png"))).toBeNull();
  });
});

describe("marks in pixels become fractions before anything checks them", () => {
  test("of the image file's own size when no size is given, and then pass the 0-1 check unchanged", async () => {
    const shot = join(folder, "hero.png");
    writeFileSync(shot, png(1280, 800));
    const converted = await scenePixelsToFractions(box({ image: shot }));
    expect(converted).toEqual({
      ok: true,
      scene: { v: 1, target: { kind: "auto" }, marks: [{ id: "cta", kind: "box", frame: { image: shot }, rect: [0.25, 0.25, 0.5, 0.5] }] },
    });
    expect(checkReviewScene((converted as { scene: unknown }).scene, false).ok).toBe(true);
  });

  test("of size when given: the view the agent measured on, which a model is often shown scaled down", async () => {
    const shot = join(folder, "retina.png");
    writeFileSync(shot, png(2880, 1800));
    const scene = { v: 1, target: { kind: "auto" }, marks: [
      { id: "a", kind: "arrow", frame: { image: shot }, at: [0, 0], to: [720, 450], units: "px", size: [1440, 900] },
      { id: "p", kind: "pin", frame: { canvas: "c-1" }, at: [100, 50], units: "px", size: [200, 100] },
      { id: "s", kind: "stroke", frame: { canvas: "c-1" }, pts: [[0, 0], [200, 100], [100, 25]], units: "px", size: [200, 100] },
    ] };
    const converted = await scenePixelsToFractions(scene, async () => { throw new Error("size was given: the file is not read"); });
    expect(converted.ok && (converted.scene as { marks: unknown[] }).marks).toEqual([
      { id: "a", kind: "arrow", frame: { image: shot }, at: [0, 0], to: [0.5, 0.5] },
      { id: "p", kind: "pin", frame: { canvas: "c-1" }, at: [0.5, 0.5] },
      { id: "s", kind: "stroke", frame: { canvas: "c-1" }, pts: [[0, 0], [1, 1], [0.5, 0.25]] },
    ]);
  });

  test("fractions as they always were pass through untouched, beside pixel marks or alone", async () => {
    const fractions = { v: 1, target: { kind: "link" }, marks: [{ id: "f", kind: "pin", frame: { canvas: "c" }, at: [0.1, 0.9] }] };
    expect(await scenePixelsToFractions(fractions)).toEqual({ ok: true, scene: fractions });
    expect(await scenePixelsToFractions(undefined)).toEqual({ ok: true, scene: undefined });
    expect(await scenePixelsToFractions({ v: 1, target: { kind: "auto" } })).toEqual({ ok: true, scene: { v: 1, target: { kind: "auto" } } });
  });

  test("four decimals: a ten-thousandth of the image, and short on the wire", async () => {
    const converted = await scenePixelsToFractions(
      { v: 1, target: { kind: "auto" }, marks: [{ id: "t", kind: "pin", frame: { canvas: "c" }, at: [1, 2], units: "px", size: [3, 7] }] },
    );
    expect(converted.ok && (converted.scene as { marks: Array<{ at: number[] }> }).marks[0]!.at).toEqual([0.3333, 0.2857]);
  });

  test("refused, naming the mark and the size, when there is nothing to divide by or it reaches outside", async () => {
    const shot = join(folder, "small.png");
    writeFileSync(shot, png(100, 100));
    const svg = join(folder, "logo.svg");
    writeFileSync(svg, "<svg/>");
    const cases: Array<[unknown, string]> = [
      [box({ canvas: "c-1" }), 'scene marks[0] units "px" needs size: [width, height], the size of the picture you measured on'],
      [box({ image: svg }), `scene marks[0] frame.image ${svg}: conch can't read its pixel size (it reads PNG, JPEG, GIF, WebP and BMP); pass size: [width, height]`],
      [box({ image: shot }), "scene marks[0] rect reaches outside the 100×100 image it is measured on"],
      [box({ canvas: "c" }, { size: [1000, 500] }), "scene marks[0] rect reaches outside the 1000×500 it is measured on"],
      [box({ canvas: "c" }, { size: [0, 10] }), "scene marks[0] size must be [width, height] in pixels, each from 1 to 100000"],
      [box({ canvas: "c" }, { units: "pt", size: [10, 10] }), 'scene marks[0] units must be "px" (pixels, with size or an image\'s own); leave it out for fractions from 0 to 1'],
      [box({ selector: ".cta" }), "scene marks[0] is placed on what its selector or quote names, so it takes no numbers and no units"],
      [{ v: 1, target: { kind: "auto" }, marks: [{ id: "p", kind: "pin", frame: { canvas: "c" }, at: ["x", 1], units: "px", size: [10, 10] }] }, "scene marks[0] at must be [x, y] in pixels"],
    ];
    for (const [scene, reason] of cases) expect(await scenePixelsToFractions(scene), reason).toEqual({ ok: false, reason });
  });
});
