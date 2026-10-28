#!/usr/bin/env bun
/**
 * Codex in the background, end to end: this checkout's daemon starting the real `codex` in a tmux pane of its own, the
 * way the app's Start and Resume do, against a local stand-in for the Responses API so a turn really runs and ends.
 *
 *   start    A new background session. Expected: its pane reaches Codex's composer (no hook review, no update
 *            prompt), a first message typed there runs a turn, conch's own hooks run in it (SessionStart registers
 *            the session) without anything written to config.toml, and the session is listed.
 *   send     A message sent through conch's socket, as the app sends one. Expected: delivered, a second turn runs,
 *            and conch says that turn once although its Stop hook and the rollout watch both see it end.
 *   resume   The same conversation resumed in a new background session. Expected: it reaches the composer and is
 *            listed again.
 *
 *   bun scripts/codex-e2e.ts [--keep]
 *
 * Nothing real is touched, the way scripts/restore-e2e.ts does it: a temporary HOME, CONCH_CONFIG_DIR, CODEX_HOME and
 * socket, and tmux servers under a temporary TMUX_TMPDIR with a socket name of their own and $TMUX unset. No account:
 * Codex's model provider is the stand-in, on 127.0.0.1.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const TMUX = "/Applications/conch.app/Contents/Helpers/tmux";
const say = (line: string) => console.log(line);

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

function send(socket: string, message: Record<string, unknown>, ms = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => resolve(reply));
    client.on("error", reject);
    setTimeout(() => { client.destroy(); resolve(reply); }, ms);
  });
}

/** The Responses API, as much of it as a turn needs: one assistant message, then done. */
function mockResponses(port: number) {
  const turns: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) return Response.json({ data: [], models: [] });
      if (request.method !== "POST" || !path.endsWith("/responses")) return new Response("not found", { status: 404 });
      const body = await request.text();
      turns.push(body);
      const id = `resp_${turns.length}`;
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `msg_${turns.length}`,
          content: [{ type: "output_text", text: `Stand-in reply ${turns.length}. Finished.` }] } },
        { type: "response.completed", response: { id, usage: { input_tokens: 10, input_tokens_details: null,
          output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, turns };
}

async function main(): Promise<void> {
  if (!Bun.which("codex", { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" })) throw new Error("needs codex installed");
  // A short /tmp path: a unix socket path must fit sockaddr_un.
  const root = realpathSync(mkdtempSync(join("/tmp", "conch-cx-")));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const none = join(root, "none");
  const work = join(root, "work");
  const tmuxDir = join(root, "tmux");
  for (const dir of [home, codexHome, none, work, tmuxDir]) mkdirSync(dir, { recursive: true });
  const modelPort = freePort();
  const mock = mockResponses(modelPort);
  // The work folder is trusted the way a yes in the app's trust question is (`trustFolder` below); the model is the
  // stand-in. No `[hooks]` and no update setting: what keeps the session off those screens has to be conch's.
  const config = `model = "stand-in"
model_provider = "stand-in"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.stand-in]
name = "stand-in"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
env_key = "E2E_MODEL_KEY"
`;
  writeFileSync(join(codexHome, "config.toml"), config);
  // Manual mode, as Tyler runs it: a finished turn is held, never followed by a mic window this sandbox can't open.
  mkdirSync(join(home, ".config", "conch"), { recursive: true });
  writeFileSync(join(home, ".config", "conch", "state.json"), JSON.stringify({ paused: true }) + "\n");
  // A newer Codex "out", so the update prompt would come up if the launch asked for it.
  writeFileSync(join(codexHome, "version.json"), JSON.stringify({ latest_version: "999.0.0", last_checked_at: new Date().toISOString(), dismissed_version: null }));
  const socket = join(root, "conch.sock");
  const configDir = join(root, "config");
  const tmuxSocket = `cx-e2e-${process.pid}`;
  const env: Record<string, string> = {
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    CONCH_HOME: home,
    TMPDIR: `${root}/`,
    TMUX_TMPDIR: tmuxDir,
    CONCH_TMUX: TMUX,
    CONCH_TMUX_SOCKET: tmuxSocket,
    CONCH_STARTED_BY: "app",
    CONCH_SOCKET: socket,
    CONCH_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: codexHome,
    E2E_MODEL_KEY: "stand-in",
    CONCH_LOG_FILE: join(root, "daemon.log"),
    CONCH_STATE_FILE: join(root, "state.json"),
    CONCH_SESSIONS_FILE: join(root, "sessions.json"),
    CONCH_REVIEWS_FILE: join(root, "reviews.json"),
    CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
    CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
    CONCH_WHISPER_PORT: String(freePort()),
    CONCH_APP_BUNDLE: join(root, "no-app"),
    CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
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
  // Never the user's servers: no $TMUX to follow, and both sockets this tmux could reach are under this root.
  if ("TMUX" in env || !env.TMUX_TMPDIR!.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");
  const tmux = (...args: string[]) => Bun.spawnSync([TMUX, "-L", tmuxSocket, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const screen = (pane: string) => tmux("capture-pane", "-p", "-t", pane).stdout.toString();
  const log = () => { try { return readFileSync(env.CONCH_LOG_FILE!, "utf8"); } catch { return ""; } };
  const published = () => { try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; } };
  const row = (id: string) => (published()?.rows ?? []).find((candidate: { id: string }) => candidate.id === id);
  const registered = () => {
    try {
      return readdirSync(join(configDir, "codex-sessions")).filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(configDir, "codex-sessions", name), "utf8")));
    } catch { return []; }
  };
  /** The pane of a background session conch named, on this test's own server. */
  const paneOf = (name: string) => tmux("list-panes", "-t", name, "-F", "#{pane_id}").stdout.toString().trim();
  const atComposer = (pane: string) => {
    const text = screen(pane);
    if (/Hooks need review|Update available|Do you trust/.test(text)) throw new Error(`the session stopped on a prompt:\n${text}`);
    return /Ask Codex to do anything|› /.test(text) && /stand-in/.test(text);
  };
  const start = async (extra: Record<string, unknown> = {}) => {
    // As the app's Start and Resume send it: the account named, the folder's trust answered in the app.
    const reply = JSON.parse((await send(socket, { kind: "session-start", backend: "codex", host: "background",
      codexAccountId: "default", cwd: work, trustFolder: true, ...extra })).trim().split("\n")[0]!);
    if (reply.kind !== "session-started" || !reply.backgroundId) throw new Error(`start refused: ${JSON.stringify(reply)}`);
    return reply.backgroundId as string;
  };

  const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], { env, cwd: work, stdout: "ignore", stderr: "ignore" });
  try {
    await until("the daemon's socket", () => existsSync(socket));

    say("── start ──");
    const first = await start();
    const pane = await until("its pane", () => paneOf(first) || undefined);
    await until("Codex's composer, with no prompt in the way", () => atComposer(pane));
    say("  the pane reached Codex's composer: no hook review, no update prompt");
    // The app's "Open startup terminal": a new Codex session has no conversation until its first message.
    tmux("send-keys", "-t", pane, "-l", "say hello");
    await Bun.sleep(400);
    tmux("send-keys", "-t", pane, "Enter");
    await until("the first turn at the stand-in", () => mock.turns.length >= 1);
    const entry = await until("conch's SessionStart hook registering it", () => registered().find((item) => item.sessionId));
    const threadId = entry.sessionId as string;
    say(`  conch's hooks ran in it (registered ${threadId.slice(0, 8)}, pid ${entry.pid})`);
    if (/hooks\.state|trusted_hash/.test(readFileSync(join(codexHome, "config.toml"), "utf8"))) {
      throw new Error("config.toml was written: the trust was meant for the launch only");
    }
    say("  config.toml has no hook trust in it: it was for that launch only");
    await until("its row", () => row(threadId));
    say(`  listed: "${row(threadId).label}"`);
    const turnsDone = () => (readFileSync(entry.transcriptPath, "utf8").match(/"type":"task_complete"/g) ?? []).length;
    await until("the first turn ending", () => turnsDone() >= 1);
    // The rollout watch takes the turn it first sees as already said, once a five-second look has seen it.
    await Bun.sleep(7_000);

    say("── send ──");
    const sent = JSON.parse((await send(socket, { type: "inject", sessionId: threadId, label: row(threadId).label,
      announce: "and once more", awaitDelivery: true })).trim().split("\n")[0]!);
    say(`  the send: ${JSON.stringify(sent).slice(0, 160)}`);
    await until("the second turn ending", () => turnsDone() >= 2);
    await until("the rollout watch seeing it end", () => /codex turn ended — /.test(log()), 15_000);
    await Bun.sleep(2_000);
    const ended = (log().match(/codex turn ended — /g) ?? []).length;
    const deduped = (log().match(/said this Codex turn already/g) ?? []).length;
    say(`  the rollout watch saw ${ended} turn end(s); ${deduped} said once, not twice, though its Stop hook saw it too`);
    if (deduped < 1) throw new Error("no turn was said once: the hook's and the watch's turn ids didn't meet");

    say("── resume ──");
    tmux("kill-session", "-t", first);
    // Refused while conch still sees the old process ("already running"), until its next look.
    const second = await until("a resume conch takes", () => start({ resumeSessionId: threadId }).catch(() => undefined), 45_000);
    const resumed = await until("its pane", () => paneOf(second) || undefined);
    await until("Codex's composer on the resumed conversation", () => atComposer(resumed) && screen(resumed).includes("Stand-in reply"));
    say("  resumed onto its conversation, nothing in the way");
    await until("listed again", () => row(threadId));
    say(`  listed again: "${row(threadId).label}"`);
    say("\nall passed");
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    // Only the test's own server, by its own socket name in its own TMUX_TMPDIR, as restore-e2e.ts ends its own: conch
    // keeps its server up when empty (`exit-empty off`), so ending the sessions alone left it running. Never a bare
    // kill-server.
    tmux("kill-server");
    mock.server.stop(true);
    if (keep) say(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

await main();
