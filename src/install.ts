import { join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync, unlinkSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { CONCH_DATA } from "./config.ts";
import { serviceManager } from "./platform.ts";

const SERVICE_LABEL = "com.conch.daemon";

// The two models conch downloads on a fresh machine. Both live under
// ~/.cache/conch/models (where config.ts probes as its second candidate), so an
// install with no seashell checkout resolves them automatically.
const MODELS = [
  {
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    label: "whisper large-v3-turbo (~1.6 GB)",
    minBytes: 500_000_000, // guards against a 404-page masquerading as the model
  },
  {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    label: "silero VAD (~900 KB)",
    minBytes: 100_000,
  },
] as const;

// conch runs two ways: via bun (dev / `bun link`, where process.execPath is bun
// and the entry is src/cli.ts) or as a `bun build --compile` standalone binary
// (where process.execPath IS the conch binary and there is no src/cli.ts). The
// hook + service commands must name whichever actually re-invokes conch here.
const CLI_ENTRY = join(import.meta.dir, "cli.ts");
const IS_COMPILED = !existsSync(CLI_ENTRY);

/** Shell-quoted argv that re-invokes conch: `"conch"` (compiled) or `"bun" "…/cli.ts"`. */
function conchInvocation(): string {
  return IS_COMPILED ? `"${process.execPath}"` : `"${process.execPath}" "${CLI_ENTRY}"`;
}

/**
 * One-command bootstrap for a fresh machine: installs the binaries conch shells
 * out to (via Homebrew), downloads the whisper + VAD models, wires the Claude
 * Code hooks, and runs doctor. Idempotent — re-running skips anything already
 * present, so it's safe on a box that already has a seashell checkout.
 */
export async function runSetup(cfg: Config): Promise<void> {
  console.log("🐚 conch setup — getting your machine ready for voice\n");

  // 1. Binaries. sox + tmux come from Homebrew; whisper-cli/-server ship in the
  //    whisper-cpp formula. `say`/`afplay` are macOS built-ins (checked by doctor).
  const brew = Bun.which("brew");
  const missing: Array<{ formula: string; why: string }> = [];
  if (!Bun.which("sox")) missing.push({ formula: "sox", why: "microphone capture" });
  if (!Bun.which("tmux")) missing.push({ formula: "tmux", why: "daemon hosting + pane injection" });
  // Gate on whisper-cli only — the brew whisper-cpp formula ships it but builds
  // with WHISPER_BUILD_SERVER=OFF, so whisper-server is never present on a brew
  // box. It's an optional speed/partials upgrade, not a requirement.
  if (!existsSync(cfg.whisperCli)) {
    missing.push({ formula: "whisper-cpp", why: "speech-to-text" });
  }
  if (missing.length) {
    if (!brew) {
      console.log("⚠️  Missing dependencies and Homebrew isn't installed. Install brew from https://brew.sh, then:");
      console.log(`      brew install ${missing.map((m) => m.formula).join(" ")}\n`);
    } else {
      console.log(`Installing via Homebrew: ${missing.map((m) => `${m.formula} (${m.why})`).join(", ")}`);
      const proc = Bun.spawn(["brew", "install", ...missing.map((m) => m.formula)], { stdout: "inherit", stderr: "inherit" });
      const code = await proc.exited;
      if (code !== 0) {
        console.error("\n❌ brew install failed — resolve the error above and re-run `conch setup`.");
        process.exit(1);
      }
      console.log("");
    }
  } else {
    console.log("✅ binaries present (sox, tmux, whisper-cpp)");
  }

  // 2. Models. Skip any that config already resolves (a seashell box has them).
  const wanted = [
    { ...MODELS[0], resolved: cfg.whisperModel },
    { ...MODELS[1], resolved: cfg.vadModel },
  ];
  const modelsDir = join(CONCH_DATA, "models");
  for (const m of wanted) {
    if (existsSync(m.resolved)) {
      console.log(`✅ ${m.label} already at ${m.resolved}`);
      continue;
    }
    mkdirSync(modelsDir, { recursive: true });
    const dest = join(modelsDir, m.file);
    console.log(`⬇️  ${m.label}`);
    await downloadModel(m.url, dest, m.minBytes);
    console.log(`   → ${dest}`);
  }

  // 3. Kokoro voices (optional). Without mlx-audio, conch falls back to `say`.
  if (!Bun.which(cfg.ttsServerBin)) {
    console.log('\nℹ️  Natural per-session voices are optional. For them, install mlx-audio:');
    console.log('      uv tool install --with "misaki[en]" "mlx-audio[server]"');
    console.log("   Without it, conch uses the macOS `say` voice.");
  } else {
    console.log(`✅ kokoro voices available via ${cfg.ttsServerBin}`);
  }

  // 4. Wire the Claude Code hooks, then verify the whole chain.
  console.log("\nWiring Claude Code hooks…");
  await runInstall(cfg);
  console.log("\nRunning doctor…\n");
  await runDoctor(cfg);
  console.log("\n🐚 Setup complete. Start the background service with:  conch service install");
}

/** curl a model to a temp path, size-check it, then atomically move into place. */
async function downloadModel(url: string, dest: string, minBytes: number): Promise<void> {
  const tmp = `${dest}.part`;
  try {
    unlinkSync(tmp);
  } catch {}
  const proc = Bun.spawn(["curl", "-L", "--fail", "--progress-bar", "-o", tmp, url], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`❌ download failed (curl exit ${code}). Check your connection and re-run \`conch setup\`.`);
    process.exit(1);
  }
  const size = existsSync(tmp) ? statSync(tmp).size : 0;
  if (size < minBytes) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error(`❌ downloaded file is too small (${size} bytes) — the URL may have returned an error page.`);
    process.exit(1);
  }
  renameSync(tmp, dest); // same dir → atomic, no 1.6 GB re-copy
}

/**
 * Install (or remove) a launchd agent that supervises the daemon: it keeps
 * a detached tmux session alive, starting it at login and resurrecting it
 * within ~15s of any crash. tmux hosting matters on macOS: Terminal.app has
 * a recursive process-tree walk that can segfault on a churning tab tree
 * (observed live, three crashes) — the daemon must never live in a Terminal
 * window. View the dashboard anytime with `tmux attach -t conch`.
 */
export function renderSupervisorScript(tmux: string, daemonCmd: string): string {
  return `#!/bin/zsh
# conch supervisor — keeps the daemon's tmux session alive (installed by \`conch service\`)
while true; do
  "${tmux}" has-session -t conch 2>/dev/null || \\
    "${tmux}" new-session -d -s conch '${daemonCmd}'
  sleep 15
done
`;
}

export function serviceRestartCommands(tmux: string, uid: number): string[][] {
  return [
    [tmux, "kill-session", "-t", "conch"],
    ["launchctl", "kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`],
  ];
}

export async function runService(cfg: Config, action: "install" | "off"): Promise<void> {
  if (serviceManager() !== "launchd") {
    // systemd user unit is on the roadmap for the Linux/WSL port; until then
    // the supervisor loop in a tmux session is the same self-healing daemon.
    console.log("[conch] `conch service` is macOS (launchd) only for now.");
    console.log("        Run the daemon under tmux instead:  tmux new-session -d -s conch 'conch daemon'");
    return;
  }
  const uid = process.getuid?.() ?? 501;
  const plistPath = join(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);

  if (action === "off") {
    Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]);
    try {
      unlinkSync(plistPath);
    } catch {}
    console.log("[conch] service removed (daemon left running if it was up — `tmux kill-session -t conch` to stop it)");
    return;
  }

  const conchRoot = dirname(import.meta.dir); // src/.. (real only when run via bun)
  const tmux = Bun.which("tmux");
  if (!tmux) {
    console.error("[conch] tmux is required for the service (brew install tmux)");
    process.exit(1);
  }

  // The daemon launch line + where the supervisor script lives both depend on
  // whether we're a compiled binary (no repo on disk) or a bun checkout.
  const daemonCmd = IS_COMPILED
    ? `CONCH_KEYSTROKE_FALLBACK=1 ${conchInvocation()} daemon`
    : `cd "${conchRoot}" && CONCH_KEYSTROKE_FALLBACK=1 ${conchInvocation()} daemon`;
  const supervisorDir = IS_COMPILED ? join(homedir(), ".config", "conch") : join(conchRoot, "bin");
  const supervisorPath = join(supervisorDir, "conch-supervisor.sh");
  mkdirSync(supervisorDir, { recursive: true });
  await Bun.write(supervisorPath, renderSupervisorScript(tmux, daemonCmd));
  chmodSync(supervisorPath, 0o755);

  const path = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"), // mlx_audio.server
    join(homedir(), ".bun/bin"),
    "/usr/bin",
    "/bin",
  ].join(":");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>${supervisorPath}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path}</string></dict>
  <key>StandardOutPath</key><string>/tmp/conch-supervisor.log</string>
  <key>StandardErrorPath</key><string>/tmp/conch-supervisor.log</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath), { recursive: true });
  await Bun.write(plistPath, plist);

  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]); // replace any old copy
  const boot = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, plistPath]);
  if (boot.exitCode !== 0) {
    console.error(`[conch] launchctl bootstrap failed: ${boot.stderr.toString().trim()}`);
    process.exit(1);
  }
  // The launchd job is the supervisor shell; the live daemon is detached in
  // tmux. Drop that session first, then kick the managed supervisor so it
  // recreates the daemon immediately with the regenerated launch environment.
  for (const restart of serviceRestartCommands(tmux, uid)) Bun.spawnSync(restart);
  const viewHint = IS_COMPILED ? "tmux attach -t conch" : `tmux attach -t conch   (or open ${conchRoot}/dashboard.command)`;
  console.log(`[conch] service installed — daemon restarted, starts at login, and self-heals within ~15s.
  view:      ${viewHint}
  logs:      /tmp/conch-supervisor.log
  remove:    conch service off`);
}

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

/**
 * Merge conch's Stop + Notification hooks into ~/.claude/settings.json.
 * Existing hooks are preserved; a timestamped backup is written first.
 */
export async function runInstall(cfg: Config): Promise<void> {
  const settingsPath = join(cfg.claudeDir, "settings.json");
  // Paths are quoted so an install dir containing spaces still yields a runnable
  // hook command. Resolves to `"conch" hook` (compiled) or `"bun" "…/cli.ts" hook`.
  const command = `${conchInvocation()} hook`;

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    settings = await Bun.file(settingsPath).json(); // let a parse error throw — never clobber a file we can't read
  }

  settings.hooks ??= {};
  let changed = false;
  for (const event of ["Stop", "Notification", "UserPromptSubmit"]) {
    const entries: HookEntry[] = (settings.hooks[event] ??= []);
    const already = entries.some((e) => e.hooks?.some((h) => h.command?.includes("conch") && h.command?.includes("hook")));
    if (already) {
      console.log(`${event}: conch hook already wired, skipping`);
      continue;
    }
    entries.push({ hooks: [{ type: "command", command, timeout: 15 }] });
    changed = true;
    console.log(`${event}: wired -> ${command}`);
  }

  if (changed) {
    // Back up only when we're actually about to modify — the old code wrote a
    // fresh timestamped backup on every run, even "Nothing to do", piling up.
    if (existsSync(settingsPath)) {
      const backup = `${settingsPath}.conch-backup-${Date.now()}`;
      await Bun.write(backup, await Bun.file(settingsPath).text());
      console.log(`backed up settings to ${backup}`);
    }
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("\nDone. Open /hooks in Claude Code (or restart sessions) to reload config.");
  } else {
    console.log("\nNothing to do.");
  }
}

/** Sanity-check every external dependency conch shells out to. */
export async function runDoctor(cfg: Config): Promise<void> {
  const checks: Array<[string, () => boolean | Promise<boolean>]> = [
    ["say (TTS)", () => binaryExists("say")],
    ["afplay (bell)", () => binaryExists("afplay")],
    ["sox (mic capture)", () => binaryExists("sox")],
    ["tmux (pane injection)", () => binaryExists("tmux")],
    [`whisper-cli at ${cfg.whisperCli}`, () => existsSync(cfg.whisperCli)],
    [`whisper model at ${cfg.whisperModel}`, () => existsSync(cfg.whisperModel)],
    [`VAD model at ${cfg.vadModel}`, () => existsSync(cfg.vadModel)],
    [`claude dir at ${cfg.claudeDir}`, () => existsSync(cfg.claudeDir)],
  ];
  let ok = true;
  for (const [label, check] of checks) {
    const pass = await check();
    ok &&= pass;
    console.log(`${pass ? "✅" : "❌"} ${label}`);
  }

  // whisper-server is an OPTIONAL upgrade (faster transcription + live partials).
  // Homebrew's whisper-cpp doesn't build it, so treat its absence as info, not a
  // failure — conch works fine on the cold whisper-cli path without it.
  console.log(
    existsSync(cfg.whisperServerBin)
      ? `ℹ️  whisper-server at ${cfg.whisperServerBin} — fast transcription + live partials`
      : `ℹ️  whisper-server not found — using the cold whisper-cli path (works; no live partials). Build it with WHISPER_BUILD_SERVER=ON for the upgrade.`,
  );

  const ttsAvailable = binaryExists(cfg.ttsServerBin);
  console.log(
    `ℹ️  tts: ${cfg.ttsEngine === "say" ? "say (forced)" : ttsAvailable ? `kokoro via ${cfg.ttsServerBin} on :${cfg.ttsPort}, ${cfg.ttsVoices.length} voices` : `say — ${cfg.ttsServerBin} not found (uv tool install "mlx-audio[server]" for natural per-session voices)`}`,
  );

  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
