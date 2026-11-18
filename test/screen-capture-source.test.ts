import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The Mac app itself never opens the microphone: listening is the daemon's, behind its one mic reservation, which is
// what keeps the mic shut while conch speaks. An app-side recorder or Apple's speech APIs would go round it.

const root = join(import.meta.dir, "..");
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, readFileSync(join(root, "mac-app/conch-mac", name), "utf8").replace(/\/\/.*$/gm, "")]),
);

test("the app never opens the microphone", () => {
  for (const mic of ["AVAudioEngine", "AVAudioRecorder", "AVCaptureSession", "AVCaptureDeviceInput", "AVCaptureDevice.default", "SFSpeechRecognizer", "import Speech", "sox"]) {
    expect(Object.keys(macSources).filter((name) => macSources[name]!.includes(mic)), mic).toEqual([]);
  }
});
