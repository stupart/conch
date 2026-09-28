#!/usr/bin/env bun
/**
 * A folder deliverable, end to end against a real daemon from this checkout: a temporary home, its own socket, its
 * own sessions file, nothing shared with a running conch. A session (this process, registered in a temporary
 * Claude folder) files a folder through the MCP tool's own handler and JSON-RPC dispatch, over the daemon's socket,
 * and the daemon publishes it: kind `folder`, its focus relative to it, the next version when it is filed again, and
 * never a listing of what the folder holds. A focus that leads out of the folder is refused by the tool, and a raw
 * socket write of one is refused by the daemon, which files nothing.
 *
 *   bun scripts/folder-deliverable-e2e.ts [--keep]
 *
 * Never plays audio, never opens the microphone, never downloads a model (the engine paths point at nothing), and
 * stops its daemon by its own pid.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactIdentity } from "../src/deliverables.ts";
import { sendToDaemon } from "../src/hook.ts";
import { createMcpToolHandlers, defaultMcpDependencies, dispatchJsonRpc } from "../src/mcp.ts";

const keep = process.argv.includes("--keep");
const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | null = null;
    try { value = await probe(); } catch {}
    if (value) return value;
    await Bun.sleep(100);
  }
  say(`… gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

const root = mkdtempSync(join(tmpdir(), "conch-folder-e2e-"));
const home = join(root, "home");
const claude = join(root, "claude");
const project = join(root, "project");
const module = join(project, "module");
mkdirSync(home, { recursive: true });
mkdirSync(join(claude, "sessions"), { recursive: true });
mkdirSync(join(module, "src", "parts"), { recursive: true });
mkdirSync(join(module, "test"), { recursive: true });
mkdirSync(join(project, "elsewhere"), { recursive: true });
writeFileSync(join(module, "src", "setup.ts"), "export {};\n");
writeFileSync(join(module, "src", "parts", "never-published.ts"), "export {};\n");
writeFileSync(join(module, "test", "setup.test.ts"), "test\n");
writeFileSync(join(project, "elsewhere", "secret.txt"), "not in the folder\n");
symlinkSync(join(project, "elsewhere"), join(module, "out"));

// The calling session: this process, as Claude Code registers a window (`~/.claude/sessions/<pid>.json`).
const sessionId = "e2e00000-0000-4000-8000-00000000f01d";
writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId, cwd: project, startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", name: "folder-e2e",
}));

const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  // An engine that isn't there: nothing downloads, nothing listens.
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_MODEL: join(root, "no-model.bin"),
  CONCH_WHISPER_CLI: join(root, "no-whisper-cli"),
  CONCH_WHISPER_SERVER: join(root, "no-whisper-server"),
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_RECORDS_ENABLED: "0",
  CONCH_PHONE: "0",
};

type Review = { summary: string; link?: string; kind?: string; version?: number; artifact?: string; focus?: string[]; id?: string };
type Row = { id: string; review?: Review; reviews?: Review[] };
const sessionsFile = () => readFileSync(env.CONCH_SESSIONS_FILE!, "utf8");
const ourRow = (): Row | null => {
  try { return (JSON.parse(sessionsFile()) as { rows?: Row[] }).rows?.find((row) => row.id === sessionId) ?? null; } catch { return null; }
};

const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "daemon"], {
  env,
  cwd: root,
  stdin: "ignore",
  stdout: Bun.file(join(root, "daemon.stdout.log")),
  stderr: Bun.file(join(root, "daemon.stderr.log")),
});
say(`temp root ${root}`);
say(`daemon started, pid ${daemon.pid}`);

// The MCP tool's own handlers, as the plugin's server builds them, pointed at this daemon and its sessions file, and
// called through JSON-RPC as a client calls them. Its parent is this process: the session registered above.
const handlers = createMcpToolHandlers(
  { claudeDir: claude, socketPath: env.CONCH_SOCKET!, sessionsPath: env.CONCH_SESSIONS_FILE! },
  { ...defaultMcpDependencies, parentPid: () => process.pid },
);
let rpcId = 0;
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, handlers);
  const result = (response as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text ?? "";
  return { isError: result?.isError === true, text };
};

try {
  check(Boolean(await until("the session's row", 30_000, () => ourRow())), `the daemon publishes the registered session ${sessionId}`);

  const first = await call("review_to_front", { summary: "The new module layout", link: module, focus: ["src/setup.ts", "test/"] });
  const accepted = first.isError ? null : JSON.parse(first.text);
  check(accepted?.outcome === "accepted" && accepted.kind === "folder" && accepted.version === 1,
    `review_to_front accepted the folder: ${first.text.slice(0, 200)}`);
  const one = await until("the folder deliverable", 10_000, () => ourRow()?.review?.kind === "folder" ? ourRow()!.review! : null);
  const artifact = artifactIdentity(realpathSync(module));
  check(one?.link === module && one.version === 1 && one.artifact === artifact, `published: kind folder, v1, link ${one?.link}`);
  check(JSON.stringify(one?.focus) === JSON.stringify(["src/setup.ts", "test"]), `…with its focus relative to it: ${JSON.stringify(one?.focus)}`);
  check(!sessionsFile().includes("never-published") && !sessionsFile().includes("setup.test.ts"),
    "…and no listing: nothing the folder holds is in the sessions file but the paths named");

  const second = await call("review_to_front", { summary: "The layout, with its tests", link: `${module}/`, kind: "folder", focus: ["test/setup.test.ts"] });
  check(!second.isError && JSON.parse(second.text).version === 2, `filed again, the tool predicts version 2: ${second.text.slice(0, 120)}`);
  const two = await until("version 2", 10_000, () => ourRow()?.review?.version === 2 ? ourRow()! : null);
  check(two?.review?.artifact === artifact && two.reviews?.length === 2 && two.reviews.every((held) => held.artifact === artifact),
    `the daemon filed it as the same artifact's version 2, beside version 1 (${two?.reviews?.map((held) => `v${held.version}`).join(", ")})`);
  check(JSON.stringify(two?.review?.focus) === JSON.stringify(["test/setup.test.ts"]), `…each version with its own focus: ${JSON.stringify(two?.review?.focus)}`);

  const listed = await call("conch_deliverables", {});
  check(!listed.isError && JSON.parse(listed.text).deliverables[0]?.focus?.[0] === "test/setup.test.ts", "conch_deliverables lists the focus");

  const escape = await call("review_to_front", { summary: "escape", link: module, focus: ["out/secret.txt"] });
  check(escape.isError && escape.text.includes("focus[0] out/secret.txt is outside the folder"), `the tool refuses a symlink out: ${escape.text}`);

  // A raw socket write skips the tool: the daemon resolves the focus on the disk itself and files nothing.
  const sent = await sendToDaemon(env.CONCH_SOCKET!, {
    type: "review-published", sessionId, label: "folder-e2e", cwd: project, announce: "raw", eventAt: Date.now(),
    review: { summary: "raw escape", link: module, focus: ["out/secret.txt"] },
  });
  check(sent, "a raw review-published with an escaping focus reached the socket");
  const logged = await until("the daemon's refusal", 10_000, () => readFileSync(env.CONCH_LOG_FILE!, "utf8").includes("refused a deliverable's focus"));
  check(Boolean(logged) && ourRow()?.review?.summary === "The layout, with its tests", "the daemon refused it and filed nothing");
} finally {
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped`);
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
