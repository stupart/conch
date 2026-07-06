import { join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";

const SERVICE_LABEL = "com.conch.daemon";

/**
 * Install (or remove) a launchd agent that supervises the daemon: it keeps
 * a detached tmux session alive, starting it at login and resurrecting it
 * within ~15s of any crash. tmux hosting matters on macOS: Terminal.app has
 * a recursive process-tree walk that can segfault on a churning tab tree
 * (observed live, three crashes) — the daemon must never live in a Terminal
 * window. View the dashboard anytime with `tmux attach -t conch`.
 */
export async function runService(cfg: Config, action: "install" | "off"): Promise<void> {
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

  const conchRoot = dirname(import.meta.dir); // src/..
  const bun = process.execPath;
  const tmux = Bun.which("tmux");
  if (!tmux) {
    console.error("[conch] tmux is required for the service (brew install tmux)");
    process.exit(1);
  }

  const supervisorPath = join(conchRoot, "bin", "conch-supervisor.sh");
  mkdirSync(join(conchRoot, "bin"), { recursive: true });
  await Bun.write(
    supervisorPath,
    `#!/bin/zsh
# conch supervisor — keeps the daemon's tmux session alive (installed by \`conch service\`)
while true; do
  "${tmux}" has-session -t conch 2>/dev/null || \\
    "${tmux}" new-session -d -s conch 'cd "${conchRoot}" && CONCH_KEYSTROKE_FALLBACK=1 "${bun}" run src/cli.ts daemon'
  sleep 15
done
`,
  );
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
  console.log(`[conch] service installed — daemon starts at login and self-heals within ~15s.
  view:      tmux attach -t conch   (or open ${conchRoot}/dashboard.command)
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
  const cliPath = join(import.meta.dir, "cli.ts");
  const command = `${process.execPath} ${cliPath} hook`;

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    settings = await Bun.file(settingsPath).json(); // let a parse error throw — never clobber a file we can't read
    const backup = `${settingsPath}.conch-backup-${Date.now()}`;
    await Bun.write(backup, await Bun.file(settingsPath).text());
    console.log(`backed up settings to ${backup}`);
  }

  settings.hooks ??= {};
  let changed = false;
  for (const event of ["Stop", "Notification"]) {
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
    [`whisper-server at ${cfg.whisperServerBin} (warm transcription + live partials)`, () => existsSync(cfg.whisperServerBin)],
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

  const ttsAvailable = binaryExists(cfg.ttsServerBin);
  console.log(
    `ℹ️  tts: ${cfg.ttsEngine === "say" ? "say (forced)" : ttsAvailable ? `kokoro via ${cfg.ttsServerBin} on :${cfg.ttsPort}, ${cfg.ttsVoices.length} voices` : `say — ${cfg.ttsServerBin} not found (uv tool install "mlx-audio[server]" for natural per-session voices)`}`,
  );

  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
