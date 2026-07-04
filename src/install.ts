import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "./config.ts";

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
  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
