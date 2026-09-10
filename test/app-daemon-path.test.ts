import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const host = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "DaemonHost.swift"), "utf8");
const install = readFileSync(join(import.meta.dir, "..", "src", "install.ts"), "utf8");

/**
 * The app-spawned daemon inherits the app's PATH. Launched from the Finder or
 * as a login item that is the bare system PATH, so the daemon could not find
 * mlx_audio.server (Kokoro) or brew tools — the launchd service's plist lists
 * those directories explicitly (src/install.ts). Night of 2026-09-10: Kokoro
 * installed, every daemon start still said "voices via say".
 */
test("the app gives its daemon the same PATH the launchd service gets", () => {
  const at = host.indexOf('environment["PATH"] = DaemonHost.daemonPath(inherited: environment["PATH"])');
  expect(at).toBeGreaterThan(-1);
  const assign = host.indexOf("task.environment = environment");
  expect(assign).toBeGreaterThan(at); // set before the environment is handed to the task
  const fn = host.slice(host.indexOf("static func daemonPath("));
  for (const dir of ['"/opt/homebrew/bin"', '"/usr/local/bin"', '".local/bin"', '".bun/bin"']) {
    expect(fn.slice(0, 900)).toContain(dir);
    // The service plist names the same four, so the two owners agree.
    expect(install).toContain(dir.replace('".local/bin"', '".local/bin"').replace('".bun/bin"', '".bun/bin"'));
  }
});
