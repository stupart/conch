#!/usr/bin/env bun
/**
 * Photograph Settings › Skills and Settings › Benchmarks as the Mac app draws them, with this Mac's real skills, without
 * the live app, its daemon or Tyler's accounts ever being involved.
 *
 *   bun scripts/shoot-skills-library.ts [out-dir] [--cache <skill-indexes folder>] [--keep]
 *
 * 1. A sandbox: a temporary HOME holding COPIES of what the library reads — each Claude account's skills, plugin ledger
 *    and the two settings it needs (`enabledPlugins`, `skillOverrides`), the claude.ai sign-in each holds (its
 *    `oauthAccount`, nothing else from `.claude.json`), Codex's skills, config and plugin caches, `~/.agents/skills`, the
 *    working folders, and the Atlas copies Benchmarks' report opens from. Plugins are read where their ledger says they
 *    are, which is read only; every write (Add, Try's trial folder) lands in the sandbox. `--cache` copies an index
 *    cache in, so Discover needn't download the indexes again.
 * 2. This checkout's daemon on the sandbox's own socket, as scripts/skills-library-e2e.ts runs it ($TMUX unset, no
 *    voice, no phone).
 * 3. The Mac app's own sources compiled with every path to the real daemon pointed into the sandbox (as
 *    test/sidebar-settle.test.ts does), with scripts/shoot-skills-library-main.swift, which hosts the real Settings page
 *    in an offscreen window and draws each scene to a PNG.
 *
 * Copies are APFS clones (`cp -c`), so the sandbox costs no space, and it is removed when the shots are taken.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const repo = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const cacheAt = args.includes("--cache") ? args[args.indexOf("--cache") + 1] : undefined;
const out = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--cache") ?? join(repo, "build", "skills-library-shots");
const realHome = homedir();
const say = (line: string) => console.log(line);

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const root = mkdtempSync(join("/tmp", "conch-shoot-"));
const home = join(root, "home");
const configDir = join(root, "config");
const claudeDir = join(root, "claude");
const codexDir = join(root, "codex");
for (const dir of [home, configDir, claudeDir, codexDir]) mkdirSync(dir, { recursive: true });

/** An APFS clone of a file or folder, when it exists. */
function clone(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(join(to, ".."), { recursive: true });
  const made = Bun.spawnSync(["/bin/cp", "-cR", from, to]);
  if (made.exitCode !== 0) cpSync(from, to, { recursive: true });
}

function json(path: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** What the library reads of one Claude profile, and nothing else of it. */
function copyClaude(from: string, statePath: string, to: string): void {
  mkdirSync(join(to, "plugins"), { recursive: true });
  clone(join(from, "skills"), join(to, "skills"));
  clone(join(from, "commands"), join(to, "commands"));
  if (existsSync(join(from, "plugins", "installed_plugins.json"))) copyFileSync(join(from, "plugins", "installed_plugins.json"), join(to, "plugins", "installed_plugins.json"));
  const settings = json(join(from, "settings.json")) ?? {};
  writeFileSync(join(to, "settings.json"), JSON.stringify({ enabledPlugins: settings.enabledPlugins ?? {}, skillOverrides: settings.skillOverrides ?? {} }));
  const state = json(statePath) ?? {};
  writeFileSync(join(to, ".claude.json"), JSON.stringify({ oauthAccount: state.oauthAccount ?? null }));
}

const realClaude = join(realHome, ".claude");
copyClaude(realClaude, join(realHome, ".claude.json"), claudeDir);
const accounts = (json(join(realHome, ".config", "conch", "claude-accounts.json")) as unknown as Array<{ id: string; label: string; configDir: string }>) ?? [];
const sandboxAccounts = accounts.map((account) => {
  const to = join(configDir, "claude", account.id);
  copyClaude(account.configDir, join(account.configDir, ".claude.json"), to);
  return { id: account.id, label: account.label, configDir: to };
});
writeFileSync(join(configDir, "claude-accounts.json"), JSON.stringify(sandboxAccounts));
const realCodex = join(realHome, ".codex");
for (const part of ["skills", "config.toml", "plugins", ".tmp"]) clone(join(realCodex, part), join(codexDir, part));
clone(join(realHome, ".agents", "skills"), join(home, ".agents", "skills"));
clone(join(realHome, ".config", "conch", "working-folders.json"), join(configDir, "working-folders.json"));
clone(join(realHome, "Documents", "conch-notes", "atlas"), join(home, "Documents", "conch-notes", "atlas"));
if (cacheAt) clone(cacheAt, join(home, ".cache", "conch", "skill-indexes"));

const socket = join(root, "conch.sock");
const none = join(root, "none");
const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CONCH_HOME: home, TMPDIR: `${root}/`,
  CONCH_STARTED_BY: "app", CONCH_SOCKET: socket, CONCH_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir,
  CONCH_LOG_FILE: join(root, "daemon.log"), CONCH_STATE_FILE: join(root, "state.json"), CONCH_SESSIONS_FILE: join(root, "state.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"), CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"), CONCH_TMUX_SOCKET: `shoot-${process.pid}`, TMUX_TMPDIR: join(root, "tmux"),
  CONCH_APP_BUNDLE: join(root, "no-app"), CONCH_SEASHELL_ROOT: join(root, "no-seashell"), CONCH_WHISPER_PORT: String(freePort()),
  CONCH_WHISPER_CLI: join(none, "whisper-cli"), CONCH_WHISPER_SERVER: join(none, "whisper-server"), CONCH_WHISPER_MODEL: join(none, "model.bin"),
  CONCH_VAD_MODEL: join(none, "vad.bin"), CONCH_SOX: join(none, "sox"), CONCH_TTS: "say", CONCH_SPEAK: "0", CONCH_BELL: "0",
  CONCH_MIC_CUES: "0", CONCH_PHONE: "0",
};

function send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => { try { resolve(JSON.parse(reply)); } catch (error) { reject(error); } });
    client.on("error", reject);
  });
}

async function swiftc(cwd: string, flags: string[]): Promise<void> {
  const jobs = String(Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)));
  const compile = Bun.spawn(["swiftc", "-swift-version", "5", "-j", jobs, ...flags], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (code !== 0) throw new Error(`swiftc failed:\n${stderr.split("\n").filter((line) => line.includes("error:")).slice(0, 30).join("\n")}`);
}

const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], { env, cwd: home, stdout: "ignore", stderr: "ignore" });
try {
  for (let waited = 0; !existsSync(socket); waited += 1) {
    if (waited > 200) throw new Error("the sandbox daemon never opened its socket");
    await Bun.sleep(100);
  }
  // Discover's indexes, read now, so the shot of Discover isn't of them loading.
  await send({ kind: "skills-library", action: "discover" });
  for (let waited = 0; waited < 120; waited += 1) {
    const reply = await send({ kind: "skills-library", action: "discover" });
    if (reply.refreshing === false) break;
    await Bun.sleep(1_000);
  }
  say("sandbox daemon ready");

  // The app's sources, all but the @main app and the debug-request reader, every path to the real daemon's socket and
  // files pointed into the sandbox, where only this run's daemon listens.
  const build = join(root, "build");
  const src = join(build, "src");
  mkdirSync(src, { recursive: true });
  const app = join(repo, "mac-app", "conch-mac");
  for (const name of readdirSync(app).filter((file) => file.endsWith(".swift"))) {
    if (name === "ConchMacApp.swift" || name === "DebugSnapshot.swift") continue;
    let text = readFileSync(join(app, name), "utf8")
      .replaceAll('"/tmp/conch.sock"', JSON.stringify(socket))
      .replaceAll('"/tmp/conch-sessions.json"', JSON.stringify(join(root, "state.json")))
      .replaceAll('"/tmp/conch-daemon.log"', JSON.stringify(join(root, "daemon.log")));
    if (name === "RemoteMacStore.swift") {
      text = text.replace("        do {\n            pairings = try RemoteMacPairingStore.loadAll()", "        if true { return }\n        do {\n            pairings = try RemoteMacPairingStore.loadAll()");
    }
    for (const real of ["/tmp/conch.sock", "/tmp/conch-sessions.json", "/tmp/conch-daemon.log", "/tmp/conch-shot", "/tmp/conch-inspect", "/tmp/conch-select"]) {
      if (text.includes(`"${real}`)) throw new Error(`${name} still names ${real}`);
    }
    writeFileSync(join(src, name), text);
  }
  const design = join(repo, "design", "ConchDesign", "Sources", "ConchDesign");
  const designSources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  say("compiling ConchDesign…");
  await swiftc(build, ["-parse-as-library", "-emit-library", "-static", "-emit-module", "-module-name", "ConchDesign",
    "-emit-module-path", join(build, "ConchDesign.swiftmodule"), "-o", join(build, "libConchDesign.a"), ...designSources]);
  copyFileSync(join(repo, "scripts", "shoot-skills-library-main.swift"), join(build, "main.swift"));
  say("compiling the app's sources…");
  const binary = join(build, "shoot-skills-library");
  await swiftc(build, ["-I", build, "-L", build, "-lConchDesign", ...readdirSync(src).map((name) => join(src, name)),
    join(repo, "test", "fixtures", "sidebar-settle-stubs.swift"), join(build, "main.swift"), "-o", binary]);

  const scenes = (process.env.SHOOT_SCENES ?? [
    "skills-installed-light:skills:installed:1320x860:light",
    "skills-installed-dark:skills:installed:1320x860:dark",
    "skills-discover-light:skills:discover:1320x860:light",
    "skills-discover-dark:skills:discover:1320x860:dark",
    "skills-installed-narrow:skills:installed:860x720:light",
    "benchmarks-light:benchmarks:installed:1320x860:light",
    "benchmarks-dark:benchmarks:installed:1320x860:dark",
    "add-sheet:skills:discover:560x520:light",
    "try-sheet:skills:discover:560x300:light",
  ].join(" ")).split(" ");
  mkdirSync(out, { recursive: true });
  const shoot = Bun.spawn([binary, out, ...scenes], {
    stdout: "pipe", stderr: "pipe",
    // The real HOME for the app's own reads (its paths are shortened to ~ against it); every conch path is the sandbox's.
    env: { ...env, HOME: realHome, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(shoot.stdout).text(), new Response(shoot.stderr).text(), shoot.exited]);
  process.stdout.write(stdout);
  if (code !== 0) throw new Error(`the harness exited ${code}: ${stderr.split("\n").slice(-12).join("\n")}`);
} finally {
  daemon.kill("SIGTERM");
  await daemon.exited;
  if (!keep) rmSync(root, { recursive: true, force: true });
  else say(`kept ${root}`);
}
