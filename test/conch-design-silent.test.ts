import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `swift test` for design/ConchDesign never touches audio. Tyler heard a beep from his Mac on every gate run:
 * VideoFramesTests wrote a movie with a 440 Hz AAC tone and decoded its sound back, the round trip went through macOS's
 * audio stack, and coreaudiod ran a microphone permission check for the test process (the unified log showed an
 * `AudioQueueObject` `_Start` and a `kTCCServiceMicrophone` preflight from `xctest` on each run). Tyler, 2026-11-12:
 * "maybe we remove that functionality? its not v useful and it feels concerning". The video soundtrack transcription
 * went, and with it every audio track in the tests.
 *
 * Read, not run: what the tests write and read, and the package code they call, holds no audio writer, reader, player,
 * recorder or capture, so one can't come back by accident. A test that needs a movie writes pictures only.
 */
const root = join(import.meta.dir, "..", "design", "ConchDesign");

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith(".swift") ? [path] : [];
  });
}

/** The code without its comments: a doc comment may name an audio API (Permissions.swift names the microphone's). */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Anything that makes, reads, plays, records or asks for sound. */
const AUDIO: ReadonlyArray<[string, RegExp]> = [
  ["an audio track written or read", /mediaType:\s*\.audio|withMediaType:\s*\.audio|AVMediaType\.audio|AVAssetReaderAudioMixOutput/],
  ["an audio format or sample buffer", /kAudioFormat|AudioStreamBasicDescription|CMAudio\w+|kLinearPCMFormat/],
  ["AVFoundation's audio engine, players and recorders", /\bAV(Audio\w+|Player\w*|QueuePlayer|SpeechSynthesizer\w*)\b/],
  ["Core Audio itself", /\bAudioQueue\w*|\bAudioUnit\w*|\bAudioComponent\w*|\bAudioServices\w*|\bAudioObject\w*|import (AudioToolbox|CoreAudio|AVKit)\b/],
  ["capture", /\bAVCapture\w+/],
  ["a sound played", /\bNSSound\b|\bNSBeep\b|SystemSoundID/],
];

describe("design/ConchDesign's tests never touch audio", () => {
  const tests = swiftFiles(join(root, "Tests"));
  const sources = swiftFiles(join(root, "Sources"));

  test("there are tests and sources to read", () => {
    expect(tests.length).toBeGreaterThan(10);
    expect(tests.some((path) => path.endsWith("VideoFramesTests.swift"))).toBe(true);
    expect(sources.some((path) => path.endsWith("VideoFrames.swift"))).toBe(true);
  });

  for (const [what, pattern] of AUDIO) {
    test(`no ${what}, in a test or in the package code a test calls`, () => {
      const found = [...tests, ...sources].flatMap((path) =>
        code(path).split("\n").flatMap((line, index) => (pattern.test(line) ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`] : [])),
      );
      expect(found).toEqual([]);
    });
  }

  test("the patterns catch what the tone movie did, and a comment naming an API isn't code", () => {
    const toneMovie = [
      "let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [",
      "    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100,",
      "guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }",
      "var description = AudioStreamBasicDescription()",
      "CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil)",
    ];
    for (const line of toneMovie) expect(AUDIO.some(([, pattern]) => pattern.test(line)), line).toBe(true);
    const permissions = join(root, "Sources/ConchDesign/Permissions.swift");
    expect(AUDIO.some(([, pattern]) => pattern.test(readFileSync(permissions, "utf8")))).toBe(true);
    expect(AUDIO.some(([, pattern]) => pattern.test(code(permissions)))).toBe(false);
  });
});
