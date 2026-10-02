import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conchHome } from "../src/home.ts";
import { assertUnderTestRoot } from "./isolation-guard.ts";

// Every scratch folder a test makes with `tmpdir()` lands in one folder per run, removed when the run ends. Tests
// called `mkdtempSync(join(tmpdir(), …))` straight into the user's temp folder and never removed them: 86,567
// `conch-*` folders (1.8 GB) had piled up there by 2026-09-27. `os.tmpdir()` reads TMPDIR on every call, so setting
// it here, before any test module loads, catches every call site, later ones included, and the processes they spawn.
// Removed in a run-wide `afterAll`: `bun test` never fires the process's "exit" event (measured 2026-09-27), which is
// how 4,050 `conch-test-config-*` roots below outlived their runs too. A run killed before its end leaves its folder,
// so each run first sweeps runs older than an hour.
const systemTemp = tmpdir();
for (const name of readdirSync(systemTemp)) {
  if (!name.startsWith("conch-test-run-")) continue;
  const path = join(systemTemp, name);
  try {
    if (Date.now() - statSync(path).mtimeMs > 60 * 60 * 1000) rmSync(path, { recursive: true, force: true });
  } catch {}
}
const runRoot = mkdtempSync(join(systemTemp, "conch-test-run-"));
process.env.TMPDIR = runRoot;
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));

// Default config/provider discovery and IPC must stay away from a running install.
const testConfigRoot = mkdtempSync(join(tmpdir(), "conch-test-config-"));
const testHome = join(testConfigRoot, "home");
const testConfigDir = join(testConfigRoot, "config");
const testClaudeDir = join(testConfigRoot, "claude");
mkdirSync(testHome, { recursive: true });

// Every user-owned path conch writes — `~/.claude/settings.json` hooks,
// `~/.codex/`, `~/Library/LaunchAgents`, `~/.claude/plugins`, `~/.config/conch`,
// `~/.cache/conch` — hangs off `conchHome()`. Bun caches `os.homedir()` at
// process start, so assigning `process.env.HOME` here cannot move it (verified);
// CONCH_HOME is the seam that can, and it closes all of those at once, call
// sites added later included.
//
// Assigned, not `??=`, unlike the log paths below: a CONCH_HOME or
// CLAUDE_CONFIG_DIR inherited from the shell that launched `bun test` is
// exactly the "one bad path" this file exists to prevent, so the suite's own
// root always wins over the environment.
process.env.CONCH_HOME = testHome;
process.env.CONCH_CONFIG_DIR = testConfigDir;
process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
// Published so a test can check its own scratch paths sit inside the root.
process.env.CONCH_TEST_ROOT = testConfigRoot;

process.env.CONCH_SOCKET ??= join(testConfigRoot, "conch.sock");

// tmux, likewise. A suite run from inside a tmux pane (a conch background session) inherits `$TMUX`, which
// points every bare `tmux` at that real server — on 2026-10-02 one `tmux kill-server` meant for a test server
// ended every background session on the Mac. So the suite gets a tmux folder of its own (short: a socket path
// has a ~104-byte limit), no `$TMUX`, and its own name for conch's server.
const tmuxRoot = mkdtempSync("/tmp/ctmux-");
process.env.TMUX_TMPDIR = tmuxRoot;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.CONCH_TMUX_SOCKET = `conch-test-${process.pid}`;
afterAll(() => {
  for (const tmux of ["tmux", "/Applications/conch.app/Contents/Helpers/tmux"]) {
    try { Bun.spawnSync([tmux, "-L", process.env.CONCH_TMUX_SOCKET!, "kill-server"], { stdout: "ignore", stderr: "ignore" }); } catch {}
  }
  rmSync(tmuxRoot, { recursive: true, force: true });
});
process.on("exit", () => rmSync(testConfigRoot, { recursive: true, force: true }));

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
// The voice-loop tests drive delivery paths that record inject telemetry;
// TELEMETRY_PATH is read at import time, like the log path above.
if (!process.env.CONCH_TELEMETRY_FILE) {
  process.env.CONCH_TELEMETRY_FILE = join(process.env.CONCH_LOG_FILE, "..", "telemetry.jsonl");
}
// setState writes the state file on every call and the suite calls it, so
// every run overwrote the live daemon's /tmp/conch-state.json (A7's class).
if (!process.env.CONCH_STATE_FILE) {
  process.env.CONCH_STATE_FILE = join(process.env.CONCH_LOG_FILE, "..", "state.json");
}
// A ledger given this path rewrites it whenever a deliverable is filed or its
// session forgotten; the live daemon restores from it on start.
if (!process.env.CONCH_REVIEWS_FILE) {
  process.env.CONCH_REVIEWS_FILE = join(process.env.CONCH_LOG_FILE, "..", "reviews.json");
}

// Nothing below this line runs if a path escaped: the whole run fails here,
// naming it, rather than a test quietly rewriting Tyler's live hooks.
assertUnderTestRoot({
  "conch home (CONCH_HOME)": conchHome(),
  "Claude settings": join(conchHome(), ".claude", "settings.json"),
  "Claude plugins": join(conchHome(), ".claude", "plugins"),
  "Codex home": process.env.CODEX_HOME ?? join(conchHome(), ".codex"),
  LaunchAgents: join(conchHome(), "Library", "LaunchAgents"),
  CONCH_CONFIG_DIR: testConfigDir,
  CLAUDE_CONFIG_DIR: testClaudeDir,
}, testConfigRoot);
