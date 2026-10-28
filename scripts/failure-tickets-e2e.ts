#!/usr/bin/env bun
/**
 * The failure loop end to end (docs/failure-tickets.md), against this checkout's daemon: records in, tickets out, a
 * send the socket refuses filed as one, Fix starting a Claude session with the brief as its first message, its PR linked
 * and then merged, and the counts the Mac app's gear reads.
 *
 *   bun scripts/failure-tickets-e2e.ts [--keep]
 *   bun scripts/failure-tickets-e2e.ts --shots <conch-mac.app> [--seed-real] [--keep]
 *
 * `--shots` also points a Debug build of the Mac app at the same sandbox and photographs it with its own DebugSnapshot
 * (`conch shot`, on a request file of its own): the sessions' header with the gear's dot, then Settings › Failures, in
 * light and in dark, into /tmp/failure-tickets-shots/. Build that copy with a bundle id of its own, so it never shares
 * what the user's app remembers:
 *
 *   xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac -configuration Debug -destination 'platform=macOS' \
 *     -derivedDataPath build/shots.noindex CODE_SIGNING_ALLOWED=NO PRODUCT_BUNDLE_IDENTIFIER=ai.blueprintstudio.conch.failure-shots build
 *
 * `--seed-real` seeds the sandbox with copies of this Mac's own records (read, never written) for a realistic picture;
 * those pictures hold the user's session names and folders, and are for them, never for the public repository.
 *
 * Nothing real is touched, as scripts/restore-e2e.ts: the daemon gets a temporary HOME, CONCH_CONFIG_DIR, CLAUDE_CONFIG_DIR
 * and socket; its tmux server lives in a temporary TMUX_TMPDIR under a socket name of its own, with $TMUX unset; `claude`
 * and `gh` are fakes that only write down how they were called. The fix session's checkout is a scratch git repository.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const shotsAt = process.argv.indexOf("--shots");
const shotsApp = shotsAt >= 0 ? process.argv[shotsAt + 1] : undefined;
const seedReal = process.argv.includes("--seed-real");
const TMUX = existsSync("/Applications/conch.app/Contents/Helpers/tmux") ? "/Applications/conch.app/Contents/Helpers/tmux" : Bun.which("tmux")!;
const SHOTS = "/tmp/failure-tickets-shots";
const say = (line: string) => console.log(line);

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

function send(socket: string, message: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => resolve(reply));
    client.on("error", reject);
    setTimeout(() => { client.destroy(); resolve(reply); }, 25_000);
  });
}
const ask = async (socket: string, message: Record<string, unknown>) => JSON.parse(await send(socket, message));

/** Registers as Claude Code does, writes down its arguments (the brief is the last), and waits. */
const FAKE_CLAUDE = `#!/bin/bash
# Anything but a fix session (the daemon asking its version, say) is answered and gone.
case "\${@: -1}" in "Fix conch failure ticket"*) ;; *) echo "2.1.300 (Claude Code)"; exit 0 ;; esac
id=$(uuidgen | tr 'A-Z' 'a-z')
mkdir -p "$CLAUDE_CONFIG_DIR/sessions"
for a in "$@"; do printf '%s\\n<<ARG>>\\n' "$a"; done > "$E2E_LAUNCHES/$$"
reg="$CLAUDE_CONFIG_DIR/sessions/$$.json"
printf '{"pid":%d,"sessionId":"%s","cwd":"%s","startedAt":%d,"kind":"interactive","entrypoint":"cli","status":"busy","name":"Fix a failure"}' \\
  $$ "$id" "$PWD" $(($(date +%s)*1000)) > "$reg"
trap 'rm -f "$reg"; exit 0' TERM INT HUP
while :; do sleep 1; done
`;

/** `gh pr list --head <branch> …`: whatever the test last put in the state file, and its call written down. */
const FAKE_GH = `#!/bin/bash
echo "$*" >> "$E2E_GH_CALLS"
cat "$E2E_GH_STATE" 2>/dev/null || echo "[]"
`;

const NOW = Date.now();
const MINUTE = 60_000;
const at = (ago: number) => new Date(NOW - ago).toISOString();
const errorRecord = (ago: number, source: string, operation: string, message: string, sessionId?: string, state: Record<string, unknown> = {}) =>
  `${JSON.stringify({ v: 1, at: at(ago), source, operation, message, ...(sessionId ? { sessionId } : {}), state, daemonState: null })}\n`;

/** Made-up failures shaped like the real ones: today's Allow, a missing deliverable three ways, a clipboard landing. */
function syntheticRecords(): { errors: string; mcp: string } {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  return {
    errors: [
      errorRecord(40 * 24 * 60 * MINUTE, "daemon", "session-routing", "Codex row has no pid"), // past the look-back: not filed
      errorRecord(50 * MINUTE, "daemon", "inject", "Account profiles must have separate directories", a, { label: "Billing dashboard", threw: true, stack: "at accountFor (~/conch/src/claude-account-sessions.ts:70:11)" }),
      errorRecord(9 * MINUTE, "daemon", "inject", "Account profiles must have separate directories", b, { label: "Landing page", threw: true }),
      errorRecord(3 * 60 * MINUTE, "mac", "open-deliverable", "Couldn't find plan-v2.md", a, { target: "/tmp/example/plan-v2.md" }),
      errorRecord(2 * 60 * MINUTE, "mac", "open-deliverable", "Couldn't find clip.mp4", b, { target: "/tmp/example/clip.mp4" }),
      errorRecord(26 * 60 * MINUTE, "daemon", "inject", "message landed on clipboard (front-window-changed)", a, { label: "Billing dashboard", route: "clipboard", reason: "front-window-changed", chars: 88 }),
      errorRecord(5 * 24 * 60 * MINUTE, "daemon", "permission-answer", "Could not answer the permission: that permission is no longer waiting", b, {}),
      errorRecord(6 * 24 * 60 * MINUTE, "mac", "session-close", "Ctrl-D was sent, but the session is still running after 15 s. It may be finishing up; check its Terminal tab.", a, {}),
    ].join(""),
    mcp: `${JSON.stringify({ ts: NOW - 30 * MINUTE, tool: "conch_capture", session: a, backend: "claude", ms: 6982, outcome: "failed", error: "failed: the target is on the page but conch couldn't bring it into view. What conch got: \"Example\" at <url>.", args: ["target", "url"] })}\n`,
  };
}

async function main(): Promise<void> {
  // A short /tmp path: a unix socket path must fit sockaddr_un.
  const root = mkdtempSync(join("/tmp", "conch-ft-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const claudeDir = join(root, "claude");
  const bin = join(root, "bin");
  const none = join(root, "none");
  const checkout = join(root, "checkout");
  const tmuxDir = join(root, "tmux");
  const launches = join(root, "launches");
  for (const dir of [home, config, claudeDir, bin, none, checkout, tmuxDir, launches]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(home, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
  Bun.spawnSync(["git", "init", "-q", checkout]);

  // The records, made up, or copies of this Mac's own (`--seed-real`), with today's Allow made up beside them.
  const synthetic = syntheticRecords();
  if (seedReal) {
    const real = join(homedir(), ".config", "conch");
    copyFileSync(join(real, "errors.jsonl"), join(config, "errors.jsonl"));
    copyFileSync(join(real, "mcp-usage.jsonl"), join(config, "mcp-usage.jsonl"));
    writeFileSync(join(config, "errors.jsonl"), synthetic.errors.split("\n").filter((line) => line.includes("separate directories")).join("\n") + "\n", { flag: "a" });
  } else {
    writeFileSync(join(config, "errors.jsonl"), synthetic.errors);
    writeFileSync(join(config, "mcp-usage.jsonl"), synthetic.mcp);
  }
  const realErrors = join(homedir(), ".config", "conch", "errors.jsonl");
  const realBefore = existsSync(realErrors) ? statSync(realErrors).mtimeMs : 0;

  const socket = join(root, "conch.sock");
  const sessionsFile = join(root, "sessions.json");
  const tmuxSocket = `ft-e2e-${process.pid}`;
  const ghState = join(root, "gh-state.json");
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    CONCH_HOME: home,
    TMPDIR: `${root}/`,
    TMUX_TMPDIR: tmuxDir,
    CONCH_TMUX: TMUX,
    CONCH_TMUX_SOCKET: tmuxSocket,
    CONCH_STARTED_BY: "app",
    CONCH_SOCKET: socket,
    CONCH_CONFIG_DIR: config,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: join(root, "codex"),
    CONCH_LOG_FILE: join(root, "daemon.log"),
    CONCH_STATE_FILE: join(root, "state.json"),
    CONCH_SESSIONS_FILE: sessionsFile,
    CONCH_REVIEWS_FILE: join(root, "reviews.json"),
    CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
    CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
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
    CONCH_GH: join(bin, "gh"),
    CONCH_FIX_FOLDER: checkout,
    CONCH_FAILURE_CHECK_MS: "1500",
    E2E_LAUNCHES: launches,
    E2E_GH_STATE: ghState,
    E2E_GH_CALLS: join(root, "gh-calls.log"),
  };
  // Never the user's servers: no $TMUX to follow, and the one socket this tmux could reach is under this root.
  if ("TMUX" in env || !env.TMUX_TMPDIR.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");
  const tmux = (...args: string[]) => Bun.spawnSync([TMUX, ...args], { env, stdout: "pipe", stderr: "pipe" });

  const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], { env, cwd: root, stdout: "ignore", stderr: "ignore" });
  const published = () => { try { return JSON.parse(readFileSync(sessionsFile, "utf8")); } catch { return null; } };
  const list = () => ask(socket, { kind: "failure-tickets" });
  type Listed = { id: string; number: number; origin: string; operation: string; title: string; status: string; unseen: boolean; count: number; fix?: { pr?: { url: string; state: string } } };
  const ticket = async (match: (t: Listed) => boolean) => ((await list()).tickets as Listed[]).find(match);
  let failed = false;
  try {
    await until("the daemon's socket", () => existsSync(socket));

    // 1. Records become tickets: grouped, the old one past the look-back left out, MCP's failure among them.
    const first = await until("the tickets", async () => {
      const reply = await list();
      return reply.tickets?.length >= (seedReal ? 5 : 6) ? reply : undefined;
    });
    const tickets = first.tickets as Listed[];
    if (!seedReal) {
      const find = (title: string) => tickets.find((t) => t.title === title);
      if (find("Account profiles must have separate directories")?.count !== 2) throw new Error("today's Allow is not one ticket of two");
      if (find("Couldn't find <file>")?.count !== 2) throw new Error("the missing files are not one ticket");
      if (tickets.some((t) => t.title === "Codex row has no pid")) throw new Error("a record past the look-back was filed");
      if (!tickets.some((t) => t.origin === "mcp" && t.operation === "conch_capture failed")) throw new Error("the MCP failure is not a ticket");
    }
    say(`  ✓ ${tickets.length} tickets from the records, ${tickets.filter((t) => t.unseen).length} new`);

    // 2. The published counts, for the gear's dot.
    const digest = await until("the published counts", () => published()?.failures?.unseen > 0 && published().failures);
    say(`  ✓ published: ${JSON.stringify(digest)}`);

    // 3. A send the socket refuses (its session isn't live) is filed: the Mac app shows nothing for it.
    const refused = await ask(socket, { type: "inject", sessionId: crypto.randomUUID(), label: "Old work", announce: "the words" });
    if (refused.kind !== "session-error") throw new Error(`the stale inject was ${JSON.stringify(refused)}`);
    const filed = await until("the refused send's ticket", () => ticket((t) => t.title.startsWith("Refused before delivery")));
    if (readFileSync(join(config, "errors.jsonl"), "utf8").includes("the words")) throw new Error("the words were recorded");
    say(`  ✓ a refused send is #${filed.number}: ${filed.title}`);

    // 4. Fix: a background Claude session in the checkout, the brief its last argument.
    const allow = await until("today's Allow", () => ticket((t) => t.title === "Account profiles must have separate directories"));
    const fixing = await ask(socket, { kind: "failure-ticket", id: allow.id, action: "fix" });
    if (fixing.kind !== "failure-ticket" || fixing.ticket.status !== "fixing") throw new Error(`Fix answered ${JSON.stringify(fixing)}`);
    const launch = await until("the fix session", () => readdirSync(launches)[0]);
    await Bun.sleep(300);
    const args = readFileSync(join(launches, launch), "utf8").split("\n<<ARG>>\n").filter(Boolean);
    const brief = args.at(-1)!;
    for (const needed of [`Fix conch failure ticket #${allow.number}.`, `-b fix/ticket-${allow.number} origin/main`, "regression test", "Don't merge it", "The repository is PUBLIC"]) {
      if (!brief.includes(needed)) throw new Error(`the brief lacks "${needed}"`);
    }
    const panes = tmux("-L", tmuxSocket, "list-sessions", "-F", "#{session_name}").stdout.toString();
    if (!panes.includes(fixing.ticket.fix.backgroundId)) throw new Error("the fix session isn't on conch's (test) tmux server");
    say(`  ✓ Fix started ${fixing.ticket.fix.backgroundId} in the checkout with a ${brief.length}-character brief`);

    // 5. Its PR, found by its branch: linked while open, the ticket fixed once merged.
    writeFileSync(ghState, JSON.stringify([{ url: "https://github.com/example/conch/pull/9001", number: 9001, state: "OPEN", mergedAt: null }]));
    await until("the PR linked", () => ticket((t) => t.id === allow.id && t.fix?.pr?.state === "open"));
    say("  ✓ the PR is linked by its branch");
    if (!shotsApp) {
      writeFileSync(ghState, JSON.stringify([{ url: "https://github.com/example/conch/pull/9001", number: 9001, state: "MERGED", mergedAt: new Date().toISOString() }]));
      await until("the ticket fixed", () => ticket((t) => t.id === allow.id && t.status === "fixed"));
      say("  ✓ merged: the ticket is fixed");
      const calls = readFileSync(env.E2E_GH_CALLS, "utf8").trim().split("\n");
      if (calls.some((call) => !call.startsWith(`pr list --head fix/ticket-${allow.number} --state all`))) throw new Error(`gh was asked something else: ${calls.join(" | ")}`);
    }

    if (shotsApp) await shoot(shotsApp, { socket, sessionsFile, config, logFile: env.CONCH_LOG_FILE, ask: (m) => ask(socket, m), list });

    // 6. Seen: the counts go to zero, which is what clears the gear's dot.
    await ask(socket, { kind: "failure-ticket", id: "all", action: "seen" });
    await until("the dot cleared", () => published()?.failures?.unseen === 0);
    say("  ✓ seen: the published count of new ones is 0");

    // Nothing real was touched.
    if (existsSync(realErrors) && statSync(realErrors).mtimeMs !== realBefore) throw new Error("the real errors.jsonl changed");
    if ((statSync(join(config, "failure-tickets.json")).mode & 0o777) !== 0o600) throw new Error("the store is not the owner's alone");
    say("  ✓ the store is 0600, and the real records are untouched");
  } catch (error) {
    failed = true;
    say(`  ✗ ${(error as Error).message}`);
    try { say(readFileSync(env.CONCH_LOG_FILE, "utf8").split("\n").slice(-25).join("\n")); } catch {}
  } finally {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5_000)]);
    daemon.kill("SIGKILL");
    // Only the test's own server, by its own socket name. Never a bare kill-server.
    tmux("-L", tmuxSocket, "kill-server");
    if (!keep) rmSync(root, { recursive: true, force: true });
    else say(`  kept ${root}`);
  }
  process.exit(failed ? 1 : 0);
}

/**
 * The Mac app's copy, pointed at the sandbox and photographed by its own DebugSnapshot on a request file of its own:
 * the sessions' header while tickets are new (the gear's dot), then Settings › Failures, in light and dark. The page
 * marks every ticket seen when it shows, so the headers go first.
 */
async function shoot(app: string, sandbox: {
  socket: string; sessionsFile: string; config: string; logFile: string;
  ask(message: Record<string, unknown>): Promise<any>;
  list(): Promise<any>;
}): Promise<void> {
  if (!existsSync(join(app, "Contents", "MacOS", "conch-mac"))) throw new Error(`no app at ${app}`);
  mkdirSync(SHOTS, { recursive: true });
  // A ticket in every state: one being fixed (above), one fixed, two ignored, the rest open.
  const tickets = (await sandbox.list()).tickets as Array<{ id: string; status: string }>;
  const open = tickets.filter((t) => t.status === "open");
  if (open[open.length - 1]) await sandbox.ask({ kind: "failure-ticket", id: open[open.length - 1]!.id, action: "mark-fixed" });
  for (const t of open.slice(-3, -1)) await sandbox.ask({ kind: "failure-ticket", id: t.id, action: "ignore" });
  const request = `/tmp/conch-ft-shot-${process.pid}.request`;
  const binary = join(app, "Contents", "MacOS", "conch-mac");
  const pass = async (name: string, appearance: "light" | "dark", settings: boolean, size = { width: 1060, height: 980 }) => {
    const env: Record<string, string> = {
      CONCH_SOCKET: sandbox.socket,
      CONCH_STATE_FILE: sandbox.sessionsFile,
      CONCH_CONFIG_DIR: sandbox.config,
      CONCH_LOG_FILE: sandbox.logFile,
      CONCH_SHOT_REQUEST: request,
      CONCH_DEBUG_APPEARANCE: appearance,
      ...(settings ? { CONCH_DEBUG_SETTINGS: "failures" } : {}),
    };
    // No restored state: a copy stopped with its window closed would otherwise come back with none.
    // Quoted: an argument's value is read as a property list, where bare braces are a dictionary, not the string the
    // window's frame is kept as.
    const args = ["-conch.dashboard.windowFrame", `"{{40, 40}, {${size.width}, ${size.height}}}"`, "-ApplePersistenceIgnoreState", "YES"];
    // Through Launch Services (a process started directly gets no window from SwiftUI), a new instance, in the
    // background. Its pid is found by this build's own executable path, so only this copy is ever stopped, never the
    // user's conch.
    const opened = Bun.spawnSync(["open", "-n", "-g", "-a", app, ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--args", ...args]);
    if (opened.exitCode !== 0) throw new Error(`open: ${opened.stderr.toString()}`);
    const pid = await until("the app's process", () => {
      const found = Bun.spawnSync(["pgrep", "-f", binary]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
      return found.length === 1 ? found[0] : undefined;
    });
    const child = { kill: (signal: NodeJS.Signals) => { try { process.kill(pid, signal); } catch {} }, exited: until("the app to quit", () => { try { process.kill(pid, 0); return false; } catch { return true; } }, 6_000).catch(() => {}) };
    try {
      const out = join(SHOTS, `${name}-${appearance}.png`);
      const shot = await until(`a picture for ${name}`, async () => {
        await Bun.sleep(settings ? 2_500 : 1_500);
        const run = Bun.spawnSync([process.execPath, join(repo, "src", "cli.ts"), "shot", `/tmp/conch-ft-${name}-${appearance}.png`, "--window", "dashboard"], {
          env: { ...process.env, CONCH_SHOT_REQUEST: request }, stdout: "pipe", stderr: "pipe",
        });
        if (run.exitCode !== 0) return undefined;
        // The menu bar's own window answers too until the window is up: only a picture of the window counts.
        const taken = JSON.parse(readFileSync(`/tmp/conch-ft-${name}-${appearance}.png.json`, "utf8"));
        const window = taken.windows?.find((w: { name: string; frame: { width: number } }) => w.name === "dashboard" && w.frame.width > 500);
        return window ? `/tmp/conch-ft-${name}-${appearance}.png` : undefined;
      }, 40_000);
      copyFileSync(shot, out);
      const sidecar = JSON.parse(readFileSync(`${shot}.json`, "utf8"));
      say(`  ✓ ${out} (${sidecar.windows?.find((w: { name: string; frame: { width: number } }) => w.name === "dashboard" && w.frame.width > 500)?.appearance ?? "?"})`);
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(4_000)]);
      child.kill("SIGKILL");
    }
  };
  await pass("header", "light", false);
  await pass("header", "dark", false);
  await pass("failures", "light", true);
  await pass("failures", "dark", true);
  // conch beside other work: the panel's ~860 points (the section column narrows, nothing may clip).
  await pass("failures-860", "light", true, { width: 860, height: 980 });
}

await main();
