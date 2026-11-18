import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneUploads } from "../src/phone-uploads.ts";

/**
 * The phone's side of sending a video (phone-uploads.test.ts has the Mac's): pieces the Mac can ask for again, an upload
 * that resumes and always ends, and a Retry that sends the same files under the same ids. The iOS app has no test
 * target, so these Foundation pieces run under `swift`, against the Mac's own validator where they meet it.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const video = ios("VideoUpload.swift");
const bridge = ios("BridgeClient.swift");
const swift = Bun.which("swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

function runSwift(lines: string[], dir: string): string[] {
  const file = join(dir, "main.swift");
  writeFileSync(file, ["import Foundation", ...lines].join("\n"));
  const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe", cwd: dir });
  if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim().split("\n");
}

describe("the pieces the Mac checks", () => {
  test.skipIf(!swift)("a piece asked for by its number is the same piece the sequence sends", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-video-"));
    try {
      const upload = ios("ImageUpload.swift");
      const chunks = between(upload, "    struct Chunks: Sequence {", "\n    }\n\n    static func chunks") + "\n    }\n";
      const chunk = between(upload, "    static func chunk(_ data: Data, _ index: Int) -> String? {", "\n    }\n") + "\n    }\n";
      const out = runSwift([
        `enum ImageUpload {\n    static let chunkBytes = 64 * 1024\n${chunks}\n${chunk}\n}`,
        "let data = Data((0..<200_000).map { UInt8($0 % 251) })",
        "let sequence = Array(ImageUpload.Chunks(data: data))",
        "print(sequence.count, ImageUpload.Chunks(data: data).count)",
        "print((0..<sequence.count).allSatisfy { ImageUpload.chunk(data, $0) == sequence[$0] })",
        'print(ImageUpload.chunk(data, sequence.count) == nil, ImageUpload.chunk(data, -1) == nil)',
      ], dir);
      expect(out).toEqual(["4 4", "true", "true true"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("resumable, as the Mac answers", () => {
  const upload = between(bridge, "    func upload(data: Data, ext: String, id: String) async -> String? {", "\n    }\n");

  /**
   * The phone's own loop, run against a Mac that answers each piece as told: `BridgeClient.upload` and the constants it
   * reads, in a stand-in with `perform` and `reportAppError`, over pieces of 4 bytes.
   */
  function runUpload(mac: string, bytes: number): string[] {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-upload-"));
    try {
      const images = ios("ImageUpload.swift");
      const chunks = between(images, "    struct Chunks: Sequence {", "\n    }\n\n    static func chunks") + "\n    }\n";
      const chunk = between(images, "    static func chunk(_ data: Data, _ index: Int) -> String? {", "\n    }\n") + "\n    }\n";
      const constants = [...bridge.matchAll(/^    private static let upload\w+ = .*$/gm)].map((line) => line[0]).join("\n");
      return runSwift([
        "struct BridgeRequest { let method: String; let path: String; let body: Data }",
        "struct BridgeResponse { let status: Int; let body: Data }",
        `enum ImageUpload {\n    static let chunkBytes = 4\n${chunks}\n    static func chunks(_ data: Data) -> Chunks { Chunks(data: data) }\n${chunk}\n}`,
        "final class Probe {",
        "    var sends = 0",
        "    let mac: (Int, Int) -> [String: Any]",
        "    init(mac: @escaping (Int, Int) -> [String: Any]) { self.mac = mac }",
        "    func authorizedRequest(method: String, path: String, body: Data) -> BridgeRequest { BridgeRequest(method: method, path: path, body: body) }",
        "    func reportAppError(operation: String, message: String) async -> Bool { true }",
        "    func perform(_ request: BridgeRequest, within limit: Duration = .seconds(30)) async throws -> BridgeResponse {",
        "        sends += 1",
        '        if sends > 5_000 { print("runaway"); exit(0) }',
        '        let sent = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]',
        '        return BridgeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: mac(sent["index"] as! Int, sent["total"] as! Int)))',
        "    }",
        constants,
        upload + "\n    }",
        "}",
        `let probe = Probe(mac: ${mac})`,
        `let path = await probe.upload(data: Data(count: ${bytes}), ext: "mp4", id: "video01")`,
        'print(path ?? "nil", probe.sends)',
      ], dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.skipIf(!swift)("an upload that never finishes stops: at most three times its pieces are sent, never forever", () => {
    // A Mac that has forgotten the upload each time it is asked (swept, restarted): it always wants piece 0.
    const [line] = runUpload('{ _, _ in ["received": 1, "total": 10, "missing": [0]] }', 40);
    expect(line).not.toBe("runaway");
    const [path, sends] = line!.split(" ");
    expect(path).toBe("nil");
    expect(Number(sends)).toBeGreaterThanOrEqual(30);
    expect(Number(sends)).toBeLessThanOrEqual(3 * 10 + 4);
  }, 60_000);

  test.skipIf(!swift)("an upload the Mac takes piece by piece sends each piece once", () => {
    const [line] = runUpload('{ index, total in index + 1 == total ? ["path": "/mac/video01.mp4"] : ["missing": [index + 1]] }', 40);
    expect(line).toBe("/mac/video01.mp4 10");
  }, 60_000);
});

describe("a Retry sends the same sheet and video, under the same ids", () => {
  /** What the stand-ins need of the shared package: a moment, and a prompt that names the sheet it was given. */
  const STORYBOARD = [
    "enum CanvasStoryboard { struct Moment {} }",
    "enum VideoStoryboard {",
    "    static func prompt(_ frames: [CanvasStoryboard.Moment], length: Double, sheet: String, video: String) -> String { sheet }",
    "}",
  ];
  const SHEET = Buffer.from([0xff, 0xd8, 0xff, ...Array<number>(21).fill(0xaa)]);

  /**
   * `VideoMessage.send` twice, as the composer's Retry runs it, with a stand-in bridge: the first time the video doesn't
   * go (the link dropped), the second time it does. What each attempt uploaded, by extension, id and bytes. The sheet
   * was drawn once, when the video was attached (`VideoPrep.prepare`); until 2026-11-12 it was drawn again each attempt
   * from the words that attempt had, under a new id.
   */
  function attempts(): Array<{ attempt: number; ext: string; id: string; bytes: Buffer }> {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-sheet-"));
    try {
      const prepared = between(video, "struct PreparedVideo {", "\n}\n").replace("let poster: UIImage?", "let poster: Data?") + "\n}\n";
      const message = between(video, "enum VideoMessage {", "\n}\n") + "\n}\n";
      const newId = between(ios("ImageUpload.swift"), "    static func newUploadID() -> String {", "\n    }\n") + "\n    }\n";
      const out = runSwift([
        ...STORYBOARD,
        `enum ImageUpload {\n${newId}\n}`,
        prepared,
        "@MainActor final class BridgeClient {",
        "    var attempt = 0",
        "    func upload(data: Data, ext: String, id: String) async -> String? {",
        '        print(attempt, ext, id, data.base64EncodedString())',
        '        return ext == "mp4" && attempt == 1 ? nil : "/mac/\\(id).\\(ext)"',
        "    }",
        "}",
        message,
        'let movie = URL(fileURLWithPath: "clip.mp4")',
        'try! Data("ftyp".utf8).write(to: movie)',
        `let prepared = PreparedVideo(video: movie, length: 3, poster: nil, frames: [CanvasStoryboard.Moment()], sheet: Data(base64Encoded: "${SHEET.toString("base64")}")!)`,
        "let bridge = BridgeClient()",
        "bridge.attempt = 1",
        'print("sent", await VideoMessage.send(prepared, bridge: bridge) ?? "nil")',
        "bridge.attempt = 2",
        'print("sent", await VideoMessage.send(prepared, bridge: bridge) ?? "nil")',
      ], dir);
      expect(out.filter((line) => line.startsWith("sent "))).toEqual(["sent nil", expect.stringMatching(/^sent \/mac\/[\w-]+\.jpg$/)]);
      return out.filter((line) => !line.startsWith("sent ")).map((line) => {
        const [attempt, ext, id, bytes] = line.split(" ");
        return { attempt: Number(attempt), ext: ext!, id: id!, bytes: Buffer.from(bytes!, "base64") };
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Send `bytes` to the Mac as the phone does, 8 bytes a piece, stopping after `pieces` (the link dropping). */
  async function toMac(uploads: PhoneUploads, id: string, bytes: Buffer, pieces = Infinity): Promise<string | undefined> {
    const total = Math.ceil(bytes.length / 8);
    let next: number | undefined = 0;
    for (let sent = 0; next !== undefined && sent < pieces; sent += 1) {
      const reply = await uploads.accept({ uploadId: id, index: next, total, extension: "jpg", data: bytes.subarray(next * 8, next * 8 + 8).toString("base64") });
      if ("error" in reply) throw new Error(reply.error);
      if (reply.path) return reply.path;
      next = reply.missing?.[0];
    }
  }

  test.skipIf(!swift)("each attempt sends the sheet drawn when it was attached, and the video, each under its own id", () => {
    const sent = attempts();
    for (const ext of ["jpg", "mp4"]) {
      const each = sent.filter((one) => one.ext === ext);
      expect(each.map((one) => one.attempt)).toEqual([1, 2]);
      expect(each[0]!.id).toBe(each[1]!.id);
      expect(each[0]!.bytes.equals(each[1]!.bytes)).toBe(true);
    }
    expect(sent.find((one) => one.ext === "jpg")!.bytes.equals(SHEET)).toBe(true);
    // Nothing else goes: no recording of its sound.
    expect(new Set(sent.map((one) => one.ext))).toEqual(new Set(["jpg", "mp4"]));
  }, 60_000);

  test.skipIf(!swift)("a sheet half sent when the link dropped is finished by the Retry, not begun again", async () => {
    const [first, second] = attempts().filter((one) => one.ext === "jpg");
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-sheet-mac-"));
    try {
      const uploads = new PhoneUploads(dir);
      expect(await toMac(uploads, first!.id, first!.bytes, 2)).toBeUndefined();
      const landed = await toMac(uploads, second!.id, second!.bytes);
      expect(readFileSync(landed!).equals(SHEET)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
