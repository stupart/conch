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

  test("it sends what the Mac says is missing, tries a piece again, and never starts over", () => {
    expect(upload).toContain('next = (decoded?["missing"] as? [Int])?.first ?? (index + 1 < total ? index + 1 : nil)');
    expect(upload).toContain("guard let part = ImageUpload.chunk(data, index)");
    expect(upload).toContain("guard tries < Self.uploadTries else {");
    expect(upload).toContain("continue");
    expect(upload).toContain('if let path = decoded?["path"] as? String { return path }');
    // The ids a message uploads under are kept with it, so a Retry resumes the same uploads.
    expect(session).toContain("let uploadId = ImageUpload.newUploadID()");
    expect(session).toContain("await bridge.upload(data: data, ext: ext, id: attachment.uploadId)");
    for (const id of ["videoId", "recordingId", "sheetId"]) expect(video).toContain(`let ${id} = ImageUpload.newUploadID()`);
    expect(bridge).not.toContain("func uploadImage(");
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
      'await bridge.upload(data: sheet.jpeg, ext: "jpg", id: video.sheetId)',
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
