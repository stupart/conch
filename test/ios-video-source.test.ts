import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneUploads } from "../src/phone-uploads.ts";

/**
 * The phone's side of sending a video (phone-uploads.test.ts and phone-video.test.ts have the Mac's). Tyler (09-25):
 * "vise versa if possible": the phone's own recordings, to the Mac. The iOS app has no test target, so the Foundation
 * pieces run under `swift`, against the Mac's own validator where they meet it, and the rest is read.
 */
const root = join(import.meta.dir, "..");
const ios = (name: string): string => readFileSync(join(root, "mobile/conch-ios/conch-ios", name), "utf8");
const video = ios("VideoUpload.swift");
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
  test.skipIf(!swift)("the phone's WAV header is the one shape the Mac accepts as a recording", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-video-"));
    try {
      const header = between(video, "    static func wavHeader(pcmBytes: Int) -> Data {", "\n    }\n") + "\n    }\n";
      runSwift([
        `enum Probe {\n${header}\n}`,
        "let pcm = Data(repeating: 7, count: 32_000)",
        'try! (Probe.wavHeader(pcmBytes: pcm.count) + pcm).write(to: URL(fileURLWithPath: "speech.wav"))',
        'print("ok")',
      ], dir);
      const uploads = new PhoneUploads(join(dir, "uploads"));
      const bytes = readFileSync(join(dir, "speech.wav"));
      expect(bytes.length).toBe(44 + 32_000);
      expect(await uploads.accept({ uploadId: "phonewav01", index: 0, total: 1, extension: "wav", data: bytes.toString("base64") }))
        .toMatchObject({ path: join(dir, "uploads", "phonewav01.wav") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

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
    for (const id of ["videoId", "recordingId"]) expect(video).toContain(`let ${id} = ImageUpload.newUploadID()`);
    expect(bridge).not.toContain("func uploadImage(");
  });
});

describe("a Retry sends the contact sheet it made, not pieces of the last one", () => {
  /**
   * `VideoMessage.send` twice, as the composer's Retry runs it, with a stand-in bridge. The first time the Mac has no
   * words for it (whisper busy, the link down) and the video doesn't go; the second time it has words, so the sheet's
   * frames, and its bytes, differ. What each attempt uploaded, by extension, id and bytes.
   */
  function attempts(): Array<{ attempt: number; ext: string; id: string; bytes: Buffer }> {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-sheet-"));
    try {
      const prepared = between(video, "struct PreparedVideo {", "\n}\n").replace("let poster: UIImage?", "let poster: Data?") + "\n}\n";
      const message = between(video, "enum VideoMessage {", "\n}\n") + "\n}\n";
      const newId = between(ios("ImageUpload.swift"), "    static func newUploadID() -> String {", "\n    }\n") + "\n    }\n";
      const out = runSwift([
        "enum CanvasStoryboard { struct Said { let start: Double; let end: Double; let text: String }; struct Moment {} }",
        "enum VideoStoryboard { static func prompt(_ frames: [CanvasStoryboard.Moment], said: [CanvasStoryboard.Said], length: Double, sheet: String, video: String) -> String { sheet } }",
        `enum ImageUpload {\n${newId}\n}`,
        prepared,
        "enum VideoPrep {",
        "    // Its frames are chosen by the words: with none, a frame every three seconds; with some, where they end.",
        "    static func sheet(of video: URL, said: [CanvasStoryboard.Said], length: Double) async -> (frames: [CanvasStoryboard.Moment], jpeg: Data)? {",
        "        ([CanvasStoryboard.Moment()], Data([0xff, 0xd8, 0xff] + [UInt8](repeating: said.isEmpty ? 0xaa : 0xbb, count: 21)))",
        "    }",
        "}",
        "@MainActor final class BridgeClient {",
        "    var attempt = 0",
        "    func upload(data: Data, ext: String, id: String) async -> String? {",
        '        print(attempt, ext, id, data.base64EncodedString())',
        '        return ext == "mp4" && attempt == 1 ? nil : "/mac/\\(id).\\(ext)"',
        "    }",
        "    func transcript(of path: String) async -> [CanvasStoryboard.Said]? {",
        '        attempt == 1 ? nil : [CanvasStoryboard.Said(start: 0, end: 1, text: "look here")]',
        "    }",
        "}",
        message,
        'let movie = URL(fileURLWithPath: "clip.mp4"), sound = URL(fileURLWithPath: "clip.wav")',
        'try! Data("ftyp".utf8).write(to: movie); try! Data("RIFF".utf8).write(to: sound)',
        "let prepared = PreparedVideo(video: movie, recording: sound, length: 3, poster: nil)",
        "let bridge = BridgeClient()",
        "bridge.attempt = 1",
        'print("sent", await VideoMessage.send(prepared, bridge: bridge) ?? "nil")',
        "bridge.attempt = 2",
        'print("sent", await VideoMessage.send(prepared, bridge: bridge) ?? "nil")',
      ], dir);
      expect(out.filter((line) => line.startsWith("sent "))).toEqual(["sent nil", expect.stringMatching(/^sent \/mac\/\w+\.jpg$/)]);
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

  test.skipIf(!swift)("the second sheet arriving after half of the first is the second sheet, whole", async () => {
    const sent = attempts();
    const [first, second] = [1, 2].map((attempt) => sent.find((one) => one.attempt === attempt && one.ext === "jpg")!);
    expect(first!.bytes.equals(second!.bytes)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-sheet-mac-"));
    try {
      const uploads = new PhoneUploads(dir);
      expect(await toMac(uploads, first!.id, first!.bytes, 2)).toBeUndefined();
      const landed = await toMac(uploads, second!.id, second!.bytes);
      expect(readFileSync(landed!).equals(second!.bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!swift)("the second sheet after the first one landed is the second sheet, not the first handed back", async () => {
    const sent = attempts();
    const [first, second] = [1, 2].map((attempt) => sent.find((one) => one.attempt === attempt && one.ext === "jpg")!);
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-sheet-mac-"));
    try {
      const uploads = new PhoneUploads(dir);
      await toMac(uploads, first!.id, first!.bytes);
      const landed = await toMac(uploads, second!.id, second!.bytes);
      expect(readFileSync(landed!).equals(second!.bytes)).toBe(true);
      // What doesn't change between attempts keeps its id, so the Mac isn't sent it twice.
      for (const ext of ["wav", "mp4"]) {
        const ids = sent.filter((one) => one.ext === ext).map((one) => one.id);
        expect(ids.length).toBe(2);
        expect(ids[0]).toBe(ids[1]!);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("a video's files go with it", () => {
  // The transcode (up to 46 MB) and its sound, in the phone's temp folder, were never deleted: not once sent, not when
  // removed from the composer, not when the composer was already full.
  test.skipIf(!swift)("discarding a prepared video deletes its transcode and its sound", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-ios-discard-"));
    try {
      const prepared = between(video, "struct PreparedVideo {", "\n}\n").replace("let poster: UIImage?", "let poster: Data?") + "\n}\n";
      const out = runSwift([
        "enum ImageUpload { static func newUploadID() -> String { UUID().uuidString } }",
        prepared,
        'let movie = URL(fileURLWithPath: "clip.mp4"), sound = URL(fileURLWithPath: "clip.wav"), other = URL(fileURLWithPath: "other.mp4")',
        'for file in [movie, sound, other] { try! Data("x".utf8).write(to: file) }',
        "PreparedVideo(video: movie, recording: sound, length: 3, poster: nil).discard()",
        "PreparedVideo(video: other, recording: nil, length: 3, poster: nil).discard()",
        "print([movie, sound, other].map { FileManager.default.fileExists(atPath: $0.path) })",
      ], dir);
      expect(out).toEqual(["[false, false, false]"]);
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

  test("its sound as whisper takes it, and its frames chosen by the Show's own rule", () => {
    const recording = between(video, "    static func recording(of source: URL) async throws -> URL? {", "\n    }\n");
    for (const setting of ["AVSampleRateKey: 16_000,", "AVNumberOfChannelsKey: 1,", "AVLinearPCMBitDepthKey: 16,", "AVLinearPCMIsFloatKey: false,"]) {
      expect(recording).toContain(setting);
    }
    const sheet = between(video, "    static func sheet(of video: URL, said: [CanvasStoryboard.Said], length: Double) async", "\n    }\n");
    expect(sheet).toContain("let moments = VideoStoryboard.moments(said: said, length: length)");
    expect(sheet).toContain("let kept = CanvasStoryboard.keep(moments, prints: prints)");
    expect(sheet).toContain("guard let sheet = VideoStoryboard.contactSheet(frames), let jpeg = jpeg(sheet) else { return nil }");
  });

  test("sent in order: the words first, which choose the frames; then the sheet; then the video; one message", () => {
    const send = between(video, "    static func send(_ video: PreparedVideo, bridge: BridgeClient) async -> String? {", "\n    }\n");
    const order = [
      'await bridge.upload(data: data, ext: "wav", id: video.recordingId)',
      "said = await bridge.transcript(of: path) ?? []",
      "await VideoPrep.sheet(of: video.video, said: said, length: video.length)",
      'await bridge.upload(data: sheet.jpeg, ext: "jpg", id: ImageUpload.newUploadID())',
      'await bridge.upload(data: data, ext: "mp4", id: video.videoId)',
      "return VideoStoryboard.prompt(sheet.frames, said: said, length: video.length, sheet: sheetPath, video: videoPath)",
    ].map((step) => send.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const words = between(bridge, "    func transcript(of path: String) async -> [CanvasStoryboard.Said]? {", "\n    }\n");
    expect(words).toContain('authorizedRequest(method: "GET", path: Self.route("/transcript", ["path": path]))');
    expect(ios("DirectHTTPTransport.swift")).toContain('request.path.hasPrefix("/transcript?") ? 150');
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
