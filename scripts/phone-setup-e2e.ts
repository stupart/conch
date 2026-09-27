#!/usr/bin/env bun
/**
 * The phone's setup against a real daemon from this checkout: a temporary home, its own socket, its own phone port,
 * nothing shared with a running conch. A fake phone does what the app does: the Mac opens a pairing window (the
 * app's `open-pairing`), the phone redeems the six-digit code over the LAN bridge, then reports each setup stage.
 * Checks the `phone` block the daemon publishes to its sessions file (what the Mac's setup window reads): its exact
 * shape, `enabled` following the setting, the stages moving only forward, and all of it surviving a daemon restart,
 * with no key or token in it. The relay's key exchange is covered in process by test/phone-setup-e2e.test.ts.
 *
 *   bun scripts/phone-setup-e2e.ts [--keep]
 *
 * Never plays audio, never opens the microphone, never downloads a model (the engine paths point at nothing), and
 * stops its daemon by its own pid.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardToDaemonSocket } from "../src/phone-bridge.ts";

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

const root = mkdtempSync(join(tmpdir(), "conch-phone-setup-e2e-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const phonePort = freePort();
const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
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
  // The phone bridge on a port of its own, listening only while this runs.
  CONCH_PHONE_PORT: String(phonePort),
  CONCH_PHONE_LAN: "on",
  CONCH_PHONE_RELAY_URL: "",
};

type Phone = { enabled: boolean; paired: boolean; device: string | null; setup: { stage: string; declined: string[] } };
const published = (): { phone?: Phone } | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")) as { phone?: Phone }; } catch { return null; }
};
const control = async (message: object) => JSON.parse(await forwardToDaemonSocket(env.CONCH_SOCKET!, JSON.stringify(message))) as Record<string, unknown>;

function startDaemon() {
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "daemon"], {
    env,
    cwd: root,
    stdin: "ignore",
    stdout: Bun.file(join(root, "daemon.stdout.log")),
    stderr: Bun.file(join(root, "daemon.stderr.log")),
  });
  say(`daemon started, pid ${daemon.pid}`);
  return daemon;
}

async function stopDaemon(daemon: ReturnType<typeof startDaemon>) {
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped`);
}

let daemon = startDaemon();
let token = "";
let code = "";
try {
  const first = await until("the first publish", 30_000, () => published()?.phone);
  check(JSON.stringify(first) === JSON.stringify({ enabled: false, paired: false, device: null, setup: { stage: "waiting", declined: [] } }),
    `a fresh daemon publishes phone = ${JSON.stringify(first)}`);

  const set = await control({ kind: "set-config", key: "phone", value: true });
  check(set.kind === "config-ack", `\`phone\` turned on over the socket (${set.kind})`);
  check(Boolean(await until("enabled", 10_000, () => published()?.phone?.enabled)), "…and `enabled` follows it");

  const window = await control({ kind: "open-pairing" });
  code = String(window.code ?? "");
  check(/^\d{6}$/.test(code) && window.port === phonePort, `a pairing window opened on the daemon's own port ${window.port}`);

  const pair = await fetch(`http://127.0.0.1:${phonePort}/pair`, { method: "POST", body: JSON.stringify({ code }) });
  token = String(((await pair.json()) as { token?: string }).token ?? "");
  check(pair.status === 200 && token.length >= 24, "the phone redeemed the code for its token");
  const paired = await until("paired", 10_000, () => (published()?.phone?.paired ? published()!.phone! : null));
  check(paired?.setup.stage === "paired", `the key exchange shows as paired: ${JSON.stringify(paired)}`);

  const report = async (stage: string, declined: string[] = []) => {
    const response = await fetch(`http://127.0.0.1:${phonePort}/setup-stage`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: "setup-stage", stage, declined, device: "Test iPhone" }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const ack = await report("paired");
  check(ack.status === 200 && ack.body.kind === "setup-stage-ack" && typeof ack.body.mac === "string" && Boolean(ack.body.mac),
    `the phone's report is answered with the Mac's name (${JSON.stringify(ack.body)})`);
  await report("microphone");
  await report("tour", ["microphone"]);
  const late = await report("microphone");
  check(late.body.stage === "tour" && late.body.moved === false, "a late report is answered and ignored");
  const refused = await report("waiting");
  check(refused.status === 400, `a stage that is the Mac's to say is refused (${JSON.stringify(refused.body)})`);
  const unauthorised = await fetch(`http://127.0.0.1:${phonePort}/setup-stage`, { method: "POST", body: JSON.stringify({ stage: "finished", declined: [], device: "x" }) });
  check(unauthorised.status === 401, "without the phone's token, nothing is taken");
  const tour = await until("tour published", 10_000, () => (published()?.phone?.setup.stage === "tour" ? published()!.phone! : null));
  check(JSON.stringify(tour) === JSON.stringify({ enabled: true, paired: true, device: "Test iPhone", setup: { stage: "tour", declined: ["microphone"] } }),
    `published: ${JSON.stringify(tour)}`);
  await report("finished", ["microphone"]);
  check(Boolean(await until("finished", 10_000, () => published()?.phone?.setup.stage === "finished")), "finished is published");

  await stopDaemon(daemon);
  daemon = startDaemon();
  await Bun.sleep(500);
  const again = await until("the restarted daemon's publish", 30_000, () => {
    const phone = published()?.phone;
    return phone?.setup.stage === "finished" ? phone : null;
  });
  check(JSON.stringify(again) === JSON.stringify({ enabled: true, paired: true, device: "Test iPhone", setup: { stage: "finished", declined: ["microphone"] } }),
    `after a restart: ${JSON.stringify(again)}`);

  const file = readFileSync(join(home, ".config", "conch", "phone-setup.json"), "utf8");
  const sessions = readFileSync(env.CONCH_SESSIONS_FILE!, "utf8");
  const phoneBlock = JSON.stringify(published()?.phone);
  check(!file.includes(token) && !phoneBlock.includes(token) && !file.includes(code), "no token or code in the published block or on disk beside it");
  check(sessions.length > 0 && phoneBlock.length < 200, `the published block is ${phoneBlock.length} bytes`);
} finally {
  await stopDaemon(daemon);
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
