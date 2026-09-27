#!/usr/bin/env bun
/**
 * A frozen daemon, end to end: found by the ping, stopped by its pid, replaced — and named in the log by its own
 * event-loop watchdog. Two runs, each in a temporary home with its own socket and log, never the live daemon's:
 *
 *   freeze  The real 2026-09-28 freeze. A copy of this checkout's daemon with the agent-activity fix taken back out,
 *           whose one Claude session has a live sub-agent and a transcript whose newest 256 KiB read begins on a
 *           newline. Its first panel build spins forever. Expected: the daemon's watchdog logs "event loop blocked"
 *           with the breadcrumb `panel: live sub-agents of "…"`; the Mac app's monitor (ConchDesign's
 *           DaemonHealthMonitor, run by `swift test`) finds it unresponsive; SIGTERM does nothing (the handler is
 *           JavaScript, on the stuck thread), SIGKILL ends it; this checkout's fixed daemon, started in its place on the
 *           same home and transcript, answers pong and publishes the session.
 *   stop    This checkout's daemon, answering, then `kill -STOP`. Expected: the same stop and replacement.
 *
 *   bun scripts/daemon-watchdog-e2e.ts [--keep]
 *
 * Nothing is spoken, no microphone opens, no model downloads (the engine's paths are set to files that do not exist),
 * no phone. Every process signalled is one the test launched, by pid. The real ~/.claude, ~/.codex and ~/.config/conch
 * are never read or written: the daemons get a temporary HOME, CONCH_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

const LIVE_SOCKET = "/tmp/conch.sock";
const CHUNK = 256 * 1024;

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** This checkout's daemon with the fix in `previousNewline` taken back out: the code that froze. */
function buggyCopy(root: string): string {
  const copy = join(root, "buggy");
  mkdirSync(copy, { recursive: true });
  for (const part of ["src", "docs", "plugin", "package.json", "tsconfig.json"]) cpSync(join(repo, part), join(copy, part), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"));
  const file = join(copy, "src", "agent-activity.ts");
  const source = readFileSync(file, "utf8");
  const fixed = "return end > 0 ? buffer.lastIndexOf(0x0a, end - 1) : -1;";
  if (source.split(fixed).length !== 2) throw new Error("the fix is not where this script expects it");
  writeFileSync(file, source.replace(fixed, "return buffer.lastIndexOf(0x0a, end - 1);"));
  return copy;
}

/** One Claude session whose transcript's newest read starts on a newline, with a sub-agent still out. */
function frozenSession(claudeDir: string, cwd: string, pid: number): { sessionId: string; label: string } {
  const sessionId = "0f0f0f0f-2222-4333-8444-555555555555";
  const agentId = "a0e2e0e2e0e2e0e2e";
  const label = "watchdog e2e";
  const project = join(claudeDir, "projects", "-tmp-conch-watchdog-e2e");
  mkdirSync(join(project, sessionId, "subagents"), { recursive: true });
  writeFileSync(join(project, sessionId, "subagents", `agent-${agentId}.jsonl`), "{}\n");
  const line = (value: unknown) => JSON.stringify(value);
  const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
  // Older than the boundary: the launch (async, still out) and filler.
  const older = [
    prompt("delegate this"),
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Agent", id: "toolu_e2e", input: { description: "inspect it" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e2e", content: [{ type: "text", text: `agentId: ${agentId}` }] }] },
      toolUseResult: { isAsync: true, status: "async_launched", agentId } },
    ...Array.from({ length: 30 }, (_, n) => ({ type: "assistant", n, message: { role: "assistant", content: [{ type: "text", text: "o".repeat(9_000) }] } })),
  ].map(line).join("\n");
  // The newest read, exactly CHUNK bytes: the newline that ends `older`, a line that names the agent (so the chunk is
  // read line by line) and resolves nothing, and filler to the byte.
  let newest = "\n" + line(prompt(`how is ${agentId} doing?`)) + "\n";
  const pad = CHUNK - newest.length - line({ type: "system", filler: "" }).length - 1;
  newest += line({ type: "system", filler: "f".repeat(pad) }) + "\n";
  if (Buffer.byteLength(newest) !== CHUNK) throw new Error("fixture arithmetic");
  writeFileSync(join(project, `${sessionId}.jsonl`), older + newest);
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd, name: label, startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle",
  }));
  return { sessionId, label };
}

async function run(mode: "freeze" | "stop"): Promise<void> {
  say(`── ${mode} ──`);
  // A short /tmp path: a unix socket path must fit sockaddr_un.
  const root = mkdtempSync(join("/tmp", `conch-wd-${mode}-`));
  const home = join(root, "home");
  const claudeDir = join(root, "claude");
  const none = join(root, "none");
  for (const dir of [home, claudeDir, none]) mkdirSync(dir, { recursive: true });
  const socket = join(root, "conch.sock");
  const log = join(root, "daemon.log");
  if (socket === LIVE_SOCKET) throw new Error("refusing the live socket");
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CONCH_HOME: home,
    TMPDIR: `${root}/`,
    CONCH_STARTED_BY: "app",
    CONCH_SOCKET: socket,
    CONCH_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: join(root, "codex"),
    CONCH_LOG_FILE: log,
    CONCH_STATE_FILE: join(root, "state.json"),
    CONCH_SESSIONS_FILE: join(root, "sessions.json"),
    CONCH_REVIEWS_FILE: join(root, "reviews.json"),
    CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
    CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
    CONCH_WHISPER_PORT: String(freePort()),
    CONCH_APP_BUNDLE: join(root, "no-app"),
    CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
    // Paths that do not exist: an explicit model that is missing is never downloaded.
    CONCH_WHISPER_CLI: join(none, "whisper-cli"),
    CONCH_WHISPER_SERVER: join(none, "whisper-server"),
    CONCH_WHISPER_MODEL: join(none, "model.bin"),
    CONCH_VAD_MODEL: join(none, "vad.bin"),
    CONCH_SOX: join(none, "sox"),
    CONCH_TTS: "say",
    CONCH_SPEAK: "0",
    CONCH_BELL: "0",
    CONCH_MIC_CUES: "0",
    CONCH_PHONE: "0",
  };
  // The session's own process: something alive at the registry's pid, as a real Claude Code is.
  const stand = Bun.spawn(["/bin/sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  const session = mode === "freeze" ? frozenSession(claudeDir, root, stand.pid) : null;
  const fixedArgv = [process.execPath, join(repo, "src", "cli.ts"), "daemon"];
  const frozenArgv = mode === "freeze" ? [process.execPath, join(buggyCopy(root), "src", "cli.ts"), "daemon"] : fixedArgv;
  const config = {
    socket,
    log,
    result: join(root, "result.json"),
    mode,
    frozen: { argv: frozenArgv, env, cwd: root },
    replacement: { argv: fixedArgv, env, cwd: root },
    ...(session ? { published: { path: env.CONCH_SESSIONS_FILE, contains: session.sessionId } } : {}),
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2));
  say(`temp root ${root}`);

  try {
    const swift = Bun.spawn(
      ["swift", "test", "--package-path", join(repo, "design", "ConchDesign"), "--filter", "DaemonHealthE2ETests"],
      { env: { ...process.env, CONCH_DAEMON_E2E: join(root, "config.json") }, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, exit] = await Promise.all([new Response(swift.stdout).text(), new Response(swift.stderr).text(), swift.exited]);
    writeFileSync(join(root, "swift-test.log"), out + err);
    check(exit === 0 && /Executed 1 test, with 0 failures/.test(out + err), `swift test DaemonHealthE2ETests (${mode}) passed — ${join(root, "swift-test.log")}`);
    const result = existsSync(config.result) ? JSON.parse(readFileSync(config.result, "utf8")) : null;
    if (!result) {
      check(false, "the test wrote its result");
      console.log((out + err).split("\n").filter((l) => /error|failed|XCT/.test(l)).slice(0, 20).join("\n"));
      return;
    }
    say(`  frozen pid ${result.frozenPid}${mode === "stop" ? ` (answered ${result.answeredBeforeFreeze}, then SIGSTOP)` : ""}`);
    say(`  verdicts: ${result.verdicts.join(" → ")}  (${result.secondsToVerdict.toFixed(1)}s)`);
    say(`  termination: ${result.termination}; frozen pid alive after: ${result.frozenAliveAfter}`);
    say(`  replacement pid ${result.replacementPid} answered pong as pid ${result.replacementPong} after ${result.secondsToReplacementPong.toFixed(1)}s`);
    check(result.verdicts.at(-1) === `unresponsive(pid: ${result.frozenPid})`, "found unresponsive by the ping, after three silent ones");
    check(result.verdicts.filter((v: string) => v.startsWith("suspect")).length === 2, "…and not before: two suspects first");
    check(result.termination === "killed", "SIGTERM could not end it (its handler needs the loop); SIGKILL did");
    check(result.frozenAliveAfter === false, "the frozen pid is gone");
    check(result.replacementPong === result.replacementPid && result.replacementPid !== result.frozenPid, "a new daemon answers pong with its own pid");

    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    const app = lines.filter((l) => l.includes("] app: "));
    for (const l of app) say(`  log: ${l}`);
    check(app.some((l) => l.includes(`the daemon (pid ${result.frozenPid}) has not answered a ping for at least 13s`)), "the app's stop is in the daemon log, with the pid");
    check(app.some((l) => l.includes("ignored SIGTERM") && l.endsWith("starting a new one")), "…and how it ended");
    if (mode === "freeze") {
      const blocked = lines.filter((l) => l.includes("event loop blocked") || l.includes("event loop still blocked"));
      for (const l of blocked.slice(0, 3)) say(`  log: ${l}`);
      check(blocked.some((l) => l.includes(`last breadcrumb: "panel: live sub-agents of \\"${session!.label}\\""`)), "the daemon's own watchdog named where it was stuck");
      // The replacement has the fix: it publishes the session instead of freezing on it.
      check(result.replacementPublished === true, "the fixed daemon, on the same transcript, published the session");
    }
  } finally {
    stand.kill("SIGKILL");
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

await run("freeze");
await run("stop");
say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
