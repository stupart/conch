import { open } from "node:fs/promises";

/**
 * Marks measured in pixels, made into the fractions conch files.
 *
 * Agent ink's numbers are fractions of the image or canvas, 0 to 1 from the top left
 * (snippet.ts `ReviewMark`), because the apps draw the image at whatever size fits. An agent,
 * though, measures a screenshot in pixels: it read "the button is at 412, 1180" and had to divide
 * by a size it often didn't know, and marks landed off by the ratio (feedback, 2026-10-03). So a
 * mark may say `units: "px"`: its `at`, `to`, `rect` and `pts` are then pixels of an image
 * `size: [width, height]`, or, on an image frame with no `size`, of the image file's own pixel
 * size, read from its header. They are divided here, before the scene is checked, and filed as
 * fractions: the socket, the saved reviews and both apps only ever see 0 to 1, as before.
 *
 * `size` matters when the numbers were measured on a resized view of the image (a model is often
 * shown a screenshot scaled down): pass that view's size, and the fractions come out right.
 */

export const MARK_UNITS = ["px"] as const;
/** A size bigger than any screen or render conch draws on is a typo, not an image. */
export const MARK_PIXELS_MAX = 100_000;

export type ImageSize = [width: number, height: number];
export type ReadImageSize = (path: string) => Promise<ImageSize | null>;

const HEAD_BYTES = 512 * 1024;

/**
 * An image file's pixel size from its header: PNG, JPEG, GIF, WebP and BMP. Null for anything
 * else (SVG has no pixels, HEIC and TIFF are left to `size`) or a file that can't be read.
 */
export async function imagePixelSize(path: string): Promise<ImageSize | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);
    return pixelSizeOf(head.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** The pixel size a header says, or null. Exported for its tests. */
export function pixelSizeOf(bytes: Buffer): ImageSize | null {
  const sized = (width: number, height: number): ImageSize | null =>
    width > 0 && height > 0 && width <= MARK_PIXELS_MAX && height <= MARK_PIXELS_MAX ? [width, height] : null;
  // PNG: the signature, then IHDR's width and height.
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  // GIF87a / GIF89a: the logical screen.
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) {
    return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  // BMP: BITMAPINFOHEADER's width, and its height, negative for a top-down bitmap.
  if (bytes.length >= 26 && bytes.subarray(0, 2).toString("latin1") === "BM") {
    return sized(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)));
  }
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("latin1");
    if (chunk === "VP8 ") return sized(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L") {
      const b = bytes;
      return sized(1 + (b[21]! | ((b[22]! & 0x3f) << 8)), 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)));
    }
    if (chunk === "VP8X") return sized(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      // Fill bytes, and the markers that stand alone with no length.
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = bytes.readUInt16BE(at + 2);
      const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (startOfFrame) return sized(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5));
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(finite);
/** Four decimals: a ten-thousandth of the image, finer than any screen draws, and short on the wire. */
const fraction = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * A raw scene with every `units: "px"` mark made into fractions (`size`, or the image's own),
 * and `units` and `size` taken off it; any other mark as it came. Refused, naming the mark, when a
 * pixel mark has no size to divide by or falls outside it. Anything malformed in other ways is
 * left for `checkReviewScene` to refuse as it always has.
 */
export async function scenePixelsToFractions(
  scene: unknown,
  readSize: ReadImageSize = imagePixelSize,
): Promise<{ ok: true; scene: unknown } | { ok: false; reason: string }> {
  if (!record(scene) || !Array.isArray(scene.marks)) return { ok: true, scene };
  const marks: unknown[] = [];
  for (const [index, candidate] of scene.marks.entries()) {
    const refuse = (reason: string) => ({ ok: false, reason: `scene marks[${index}] ${reason}` }) as const;
    if (!record(candidate) || (candidate.units === undefined && candidate.size === undefined)) {
      marks.push(candidate);
      continue;
    }
    const { units, size, ...mark } = candidate;
    if (units !== "px") return refuse(`units must be "px" (pixels, with size or an image's own); leave it out for fractions from 0 to 1`);
    const frame = record(mark.frame) ? mark.frame : {};
    if (typeof frame.selector === "string" || typeof frame.quote === "string") {
      return refuse("is placed on what its selector or quote names, so it takes no numbers and no units");
    }
    let dimensions: ImageSize | null = null;
    if (size !== undefined) {
      if (!pair(size) || !size.every((side) => side >= 1 && side <= MARK_PIXELS_MAX)) {
        return refuse(`size must be [width, height] in pixels, each from 1 to ${MARK_PIXELS_MAX}`);
      }
      dimensions = size;
    } else if (typeof frame.image === "string" && frame.image.startsWith("/")) {
      dimensions = await readSize(frame.image);
      if (!dimensions) {
        return refuse(`frame.image ${frame.image}: conch can't read its pixel size (it reads PNG, JPEG, GIF, WebP and BMP); pass size: [width, height]`);
      }
    } else {
      return refuse('units "px" needs size: [width, height], the size of the picture you measured on');
    }
    const [width, height] = dimensions;
    const where = `${width}×${height}${size === undefined ? " image" : ""}`;
    const scaled: Record<string, unknown> = { ...mark };
    for (const field of ["at", "to"] as const) {
      if (mark[field] === undefined) continue;
      if (!pair(mark[field])) return refuse(`${field} must be [x, y] in pixels`);
      const [x, y] = mark[field];
      scaled[field] = [fraction(x / width), fraction(y / height)];
    }
    if (mark.rect !== undefined) {
      const rect = mark.rect;
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) return refuse("rect must be [x, y, width, height] in pixels");
      scaled.rect = [fraction(rect[0] / width), fraction(rect[1] / height), fraction(rect[2] / width), fraction(rect[3] / height)];
    }
    if (mark.pts !== undefined) {
      if (!Array.isArray(mark.pts) || !mark.pts.every(pair)) return refuse("pts must be points [x, y] in pixels");
      scaled.pts = mark.pts.map(([x, y]) => [fraction(x / width), fraction(y / height)]);
    }
    // Inside the picture, in its own terms, before `checkReviewScene` says it in fractions.
    const outside = (["at", "to"] as const).find((field) => Array.isArray(scaled[field]) && (scaled[field] as number[]).some((value) => value < 0 || value > 1))
      ?? (Array.isArray(scaled.rect) && ((scaled.rect as number[]).some((value) => value < 0 || value > 1)
        || (scaled.rect as number[])[0]! + (scaled.rect as number[])[2]! > 1.0001
        || (scaled.rect as number[])[1]! + (scaled.rect as number[])[3]! > 1.0001) ? "rect" : undefined)
      ?? (Array.isArray(scaled.pts) && (scaled.pts as number[][]).some((point) => point.some((value) => value < 0 || value > 1)) ? "pts" : undefined);
    if (outside) return refuse(`${outside} reaches outside the ${where} it is measured on`);
    marks.push(scaled);
  }
  return { ok: true, scene: { ...scene, marks } };
}
