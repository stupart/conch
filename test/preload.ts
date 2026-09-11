import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before any test module is imported. The daemon log path is read once
// at import time by src/status.ts, so this is the only place it can be
// redirected for the whole suite. Tests exercising the theater renderer
// copy fixture selections through `logAbove`; before this they landed in the
// live /tmp/conch-daemon.log as phantom "copied N chars" lines (A7).
if (!process.env.CONCH_LOG_FILE) {
  process.env.CONCH_LOG_FILE = join(mkdtempSync(join(tmpdir(), "conch-test-log-")), "daemon.log");
}
// The inject step log follows the daemon log's directory, but say so
// explicitly: 117 `pid=none` ghosts in the live /tmp file were this suite
// (audit 5a), and an explicit override is what the log-path test pins.
if (!process.env.CONCH_INJECT_DEBUG_LOG) {
  process.env.CONCH_INJECT_DEBUG_LOG = join(process.env.CONCH_LOG_FILE, "..", "inject-debug.log");
}
