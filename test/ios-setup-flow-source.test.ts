import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PHONE_SETUP_STAGES } from "../src/phone-setup.ts";

/**
 * The iPhone's first-run setup: the stages it reports must be the daemon's, and its reachability probe of the relay
 * must carry nothing of the pairing. The iOS app has no test target, so both are read from its source.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

test("PHONE_SETUP_STAGES is ConchDesign's PhoneSetupStage, case for case, in order", () => {
  const swift = between(read("design/ConchDesign/Sources/ConchDesign/Onboarding.swift"), "public enum PhoneSetupStage", "public static let mirrored");
  const cases = [...swift.matchAll(/^\s+case (\w+)$/gm)].map((match) => match[1]);
  expect(cases).toEqual([...PHONE_SETUP_STAGES]);
});

test("the relay probe carries nothing of the pairing: scheme, host, port, root", () => {
  const flow = read("mobile/conch-ios/conch-ios/SetupFlow.swift");
  const probe = between(flow, "private static func answers(_ endpoint: URL) async -> Bool {", "\n    }\n");
  expect(probe).not.toMatch(/roomId|secret|endpoint\.path|endpoint\.query|absoluteString/);
});
