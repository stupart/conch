import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const host = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "DaemonHost.swift"), "utf8");

/**
 * An adopted daemon is someone else's process: no exit callback fires when
 * it dies, and the app sat on a dead socket twice on 2026-09-10 — hooks
 * failing, phone gone, window still saying "Running — started outside this
 * app" (A2). The host must poll the socket and start its own when it stops
 * answering; nothing runs this Swift, so the wiring is pinned as text.
 */
test("adopting a daemon starts the watch, and a silent socket starts our own", () => {
  const adoptAt = host.indexOf("state = .adopted\n            watchAdoptedDaemon()");
  expect(adoptAt).toBeGreaterThan(-1);

  const probeAt = host.indexOf("private func probeAdoptedDaemon() {");
  expect(probeAt).toBeGreaterThan(-1);
  const probe = host.slice(probeAt, host.indexOf("\n    }\n", probeAt));
  expect(probe).toContain("guard case .adopted = state else {");
  expect(probe).toContain("guard !socketAnswers() else { return }");
  expect(probe).toContain("state = .stopped\n        start()");

  // stop() must drop the probe, or a deliberate off would flip back on.
  const stopAt = host.indexOf("func stop() {");
  expect(stopAt).toBeGreaterThan(-1);
  expect(host.slice(stopAt, stopAt + 200)).toContain("adoptedProbe?.invalidate()");
});
