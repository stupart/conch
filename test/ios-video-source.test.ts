import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneUploads } from "../src/phone-uploads.ts";

/**
 * The phone's side of sending a video (phone-uploads.test.ts has the Mac's). Tyler (09-25): "vise versa if possible":
 * the phone's own recordings, to the Mac. The iOS app has no test target, so the Foundation pieces run under `swift`,
 * against the Mac's own validator where they meet it, and the rest is read. Its contact sheet is pulled by the shared
 * package (`VideoFrames.swift`), which the Mac's composer runs too, and which `swift test` runs on real movies
 * (VideoFramesTests). Never its sound (2026-11-12).
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const video = ios("VideoUpload.swift");
const frames = readFileSync(join(root, "design/ConchDesign/Sources/ConchDesign/VideoFrames.swift"), "utf8");
const bridge = ios("BridgeClient.swift");
const session = ios("SessionView.swift");
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

  test("it sends what the Mac says is missing, tries a piece again, and never starts over", () => {
    expect(upload).toContain('next = (decoded?["missing"] as? [Int])?.first ?? (index + 1 < total ? index + 1 : nil)');
    expect(upload).toContain("guard let part = ImageUpload.chunk(data, index)");
    expect(upload).toContain("guard tries < Self.uploadTries else {");
    expect(upload).toContain("continue");
    expect(upload).toContain('if let path = decoded?["path"] as? String { return path }');
    // The ids a message uploads under are kept with it, so a Retry resumes the same uploads.
    expect(session).toContain("let uploadId = ImageUpload.newUploadID()");
    expect(session).toContain("await bridge.upload(data: data, ext: ext, id: attachment.uploadId)");
    for (const id of ["videoId", "sheetId"]) expect(video).toContain(`let ${id} = ImageUpload.newUploadID()`);
    expect(bridge).not.toContain("func uploadImage(");
  });
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

describe("a video's files go with it", () => {
  // The transcode (up to 46 MB), in the phone's temp folder, was never deleted: not once sent, not when removed from the
  // composer, not when the composer was already full.
  test.skipIf(!swift)("discarding a prepared video deletes its transcode", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-discard-"));
    try {
      const prepared = between(video, "struct PreparedVideo {", "\n}\n").replace("let poster: UIImage?", "let poster: Data?") + "\n}\n";
      const out = runSwift([
        "enum CanvasStoryboard { struct Moment {} }",
        "enum ImageUpload { static func newUploadID() -> String { UUID().uuidString } }",
        prepared,
        'let movie = URL(fileURLWithPath: "clip.mp4"), other = URL(fileURLWithPath: "other.mp4")',
        'for file in [movie, other] { try! Data("x".utf8).write(to: file) }',
        "PreparedVideo(video: movie, length: 3, poster: nil, frames: [], sheet: Data()).discard()",
        "print([movie, other].map { FileManager.default.fileExists(atPath: $0.path) })",
      ], dir);
      expect(out).toEqual(["[false, true]"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("whatever takes an attachment off the composer discards a video's files: sent, removed, thrown away", () => {
    // One place, the list itself, so every way off it (the tile's x, the trash, a send that went) is covered.
    const list = between(session, "@State private var attachments: [PendingAttachment] = [] {", "\n    }\n");
    expect(list).toContain("didSet {");
    expect(list).toContain("for gone in oldValue where !attachments.contains(where: { $0.id == gone.id }) {");
    expect(list).toContain("if case let .video(video) = gone.content { video.discard() }");
  });

  test("a video prepared for a composer that is already full is discarded, not left behind", () => {
    const attach = between(session, "    private func attachVideo(_ item: PhotosPickerItem) async {", "\n    }\n");
    const refused = between(attach, "guard attachments.count < Self.attachmentLimit else {", "return");
    expect(refused).toContain("video.discard()");
  });

  test("a message of pictures alone that went takes them off the composer, as one with words does", () => {
    // It never did, so the files of a video sent without words stayed, and a second Send sent it again.
    const draft = between(session, "    private func sendDraft() {", "\n    }\n");
    const deliver = between(draft, "deliver: { body, opId in", "onFinish:");
    expect(deliver).toContain("let delivered = await bridge.inject(sessionId: sessionId, label: label, text: body, opId: opId)");
    expect(deliver).toContain("if delivered.clearsAttachments { attachments.removeAll { sent in pending.contains { $0.id == sent.id } } }");
    expect(deliver).toContain("return delivered");
  });
});

describe("made ready on the phone", () => {
  test("H.264, the short edge at 720, two minutes at most, under the Mac's cap", () => {
    const transcode = between(video, "    static func transcode(_ source: URL) async throws -> URL {", "\n    }\n\n    /// One track's reader output");
    expect(video).toContain("static let shortEdge: CGFloat = 720");
    expect(video).toContain("static let maxBytes = 46 * 1024 * 1024");
    expect(transcode).toContain("AVVideoCodecKey: AVVideoCodecType.h264,");
    expect(transcode).toContain("let scale = min(1, shortEdge / max(1, min(abs(upright.width), abs(upright.height))))");
    expect(transcode).toContain("CMTime(seconds: VideoStoryboard.longest, preferredTimescale: 600)");
    expect(transcode).toContain("guard bytes <= maxBytes else {");
    expect(transcode).toContain("picture.transform = transform");
  });

  test("its frames chosen by the Show's own rule, without words, by the code the Mac runs too, as it is attached", () => {
    const prepare = between(video, "    static func prepare(_ source: URL) async throws -> PreparedVideo {", "\n    }\n");
    expect(prepare).toContain("guard let sheet = await VideoStoryboard.sheet(of: video, length: length) else {");
    expect(prepare).toContain("throw VideoPrepError.noFrames");
    const sheet = between(frames, "    public static func sheet(of video: URL, length: Double) async", "\n    }\n");
    expect(sheet).toContain("let looks = moments(length: length)");
    expect(sheet).toContain("let kept = CanvasStoryboard.keep(looks, prints: prints)");
    expect(sheet).toContain("guard let sheet = contactSheet(pulled), let jpeg = jpeg(sheet) else { return nil }");
    // Nothing of it is left behind in the app to drift from the Mac's.
    for (const gone of ["static func sheet(", "static func generator(", "CGImageDestinationCreateWithData"]) {
      expect(video).not.toContain(gone);
    }
  });

  // Tyler, 2026-11-12: "maybe we remove that functionality? its not v useful and it feels concerning". The video keeps
  // its sound, for people; nothing reads it off for the Mac's whisper.
  test("never its sound: no recording written, uploaded or transcribed, on the phone or in the shared code", () => {
    for (const gone of ["VideoStoryboard.speech", 'appendingPathExtension("wav")', 'ext: "wav"', "recordingId", "bridge.transcript("]) {
      expect(video).not.toContain(gone);
    }
    for (const gone of ["func speech(", "func wavHeader(", "withMediaType: .audio", "AVAssetReaderTrackOutput"]) expect(frames).not.toContain(gone);
    expect(bridge).not.toContain("func transcript(of path: String)");
    expect(bridge).not.toContain('"/transcript"');
    expect(ios("DirectHTTPTransport.swift")).not.toContain("/transcript");
  });

  test("sent in order: the sheet, then the video; one message", () => {
    const send = between(video, "    static func send(_ video: PreparedVideo, bridge: BridgeClient) async -> String? {", "\n    }\n");
    const order = [
      'await bridge.upload(data: video.sheet, ext: "jpg", id: video.sheetId)',
      'await bridge.upload(data: data, ext: "mp4", id: video.videoId)',
      "return VideoStoryboard.prompt(video.frames, length: video.length, sheet: sheetPath, video: videoPath)",
    ].map((step) => send.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the composer takes videos, one at a time, prepared as they are attached", () => {
    expect(session).toContain("PhotosPicker(selection: $pickedPhoto, matching: .any(of: [.images, .videos]), photoLibrary: .shared())");
    expect(session).toContain("if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {");
    expect(session).toContain('attachError = "One video at a time."');
    expect(session).toContain("let video = try await VideoPrep.prepare(picked.url)");
    expect(session).toContain("guard let block = await VideoMessage.send(video, bridge: bridge) else {");
    const project = readFileSync(join(root, "mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj"), "utf8");
    expect(project.match(/\/\* VideoUpload\.swift in Sources \*\/,/g)?.length).toBe(1);
  });
});
