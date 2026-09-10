import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMlxAudioPython } from "../src/tts-worker.ts";

/**
 * `uv tool install` puts mlx_audio.server in ~/.local/bin, which the launchd
 * service and the app-spawned daemon have on PATH but a shell may not — so
 * `conch doctor` said "mlx-audio Python not found" while the daemon had
 * Kokoro loaded (2026-09-11). The resolver looks there itself.
 */
test("the launcher is found under ~/.local/bin even when PATH lacks it", () => {
  const home = mkdtempSync(join(tmpdir(), "conch-home-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const python = join(home, "tool-python");
  writeFileSync(python, "#!/bin/sh\n");
  chmodSync(python, 0o755);
  const launcher = join(bin, "mlx_audio.server.test-only");
  writeFileSync(launcher, `#!${python}\nprint("hi")\n`);
  chmodSync(launcher, 0o755);
  // Not on PATH by construction: the launcher name exists nowhere else.
  expect(Bun.which("mlx_audio.server.test-only")).toBeNull();
  expect(resolveMlxAudioPython("", "mlx_audio.server.test-only", home)).toBe(python);
  // A launcher that is nowhere still resolves to nothing.
  expect(resolveMlxAudioPython("", "mlx_audio.server.absent", home)).toBeNull();
});
