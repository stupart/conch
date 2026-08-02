import { join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync, unlinkSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { CONCH_DATA } from "./config.ts";
import { runInstallPlugin } from "./plugin-install.ts";
import { resolveMlxAudioPython } from "./tts-worker.ts";

const SERVICE_LABEL = "com.conch.daemon";

const REVIEW_INSTRUCTIONS_BEGIN = "<!-- conch:begin -->";
const REVIEW_INSTRUCTIONS_END = "<!-- conch:end -->";

/** The small, user-removable contract installed into each agent's global instructions. */
export const REVIEW_INSTRUCTIONS_BLOCK = `${REVIEW_INSTRUCTIONS_BEGIN}
## Conch review handoff

When a deliverable is DONE, self-critiqued, and ready for the user's final look, end the final reply with its own line:
\`conch:review <one-line spoken summary> | <link-or-path>\`

Use this only as a final approval gate—not for routine "I finished" messages or every iteration. Conch already announces finished turns. If there is no useful link or path, omit the \` | …\` suffix.
${REVIEW_INSTRUCTIONS_END}`;

const REVIEW_INSTRUCTIONS_PATTERN =
  /<!-- conch:begin -->[\s\S]*?<!-- conch:end -->/g;

/**
 * Replace conch's managed block without disturbing any user-authored text.
 * Extra complete blocks are removed so this also heals an older duplicated install.
 */
export function spliceReviewInstructions(existing: string): string {
  const beginCount = existing.split(REVIEW_INSTRUCTIONS_BEGIN).length - 1;
  const endCount = existing.split(REVIEW_INSTRUCTIONS_END).length - 1;
  const matches = [...existing.matchAll(REVIEW_INSTRUCTIONS_PATTERN)];
  if (beginCount !== matches.length || endCount !== matches.length) {
    throw new Error("managed conch markers are incomplete or out of order");
  }

  if (matches.length > 0) {
    let replaced = false;
    return existing.replace(REVIEW_INSTRUCTIONS_PATTERN, () => {
      if (replaced) return "";
      replaced = true;
      return REVIEW_INSTRUCTIONS_BLOCK;
    });
  }

  if (!existing) return `${REVIEW_INSTRUCTIONS_BLOCK}\n`;
  const separator = existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${existing}${separator}${REVIEW_INSTRUCTIONS_BLOCK}\n`;
}

export type ReviewInstructionsInstallResult =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Safely install one global instruction block and report the outcome for this file. */
export async function installReviewInstructions(
  instructionsPath: string,
  fileLabel: "CLAUDE.md" | "AGENTS.md",
): Promise<ReviewInstructionsInstallResult> {
  const existed = existsSync(instructionsPath);
  let existing = "";
  if (existed) {
    try {
      existing = await Bun.file(instructionsPath).text();
    } catch (error) {
      console.warn(
        `${fileLabel}: warning — could not read ${instructionsPath}; conch review contract skipped (${errorMessage(error)})`,
      );
      return "skipped";
    }
  }

  let updated: string;
  try {
    updated = spliceReviewInstructions(existing);
  } catch (error) {
    console.warn(
      `${fileLabel}: warning — could not safely update ${instructionsPath}; conch review contract skipped (${errorMessage(error)})`,
    );
    return "skipped";
  }

  if (updated === existing) {
    console.log(
      `${fileLabel}: conch review contract already wired, skipping -> ${instructionsPath}`,
    );
    return "unchanged";
  }

  mkdirSync(dirname(instructionsPath), { recursive: true });
  if (existed) {
    const backup = `${instructionsPath}.conch-backup-${Date.now()}`;
    await Bun.write(backup, existing);
    console.log(`backed up ${fileLabel} to ${backup}`);
  }
  await Bun.write(instructionsPath, updated);
  const result = existed ? "updated" : "created";
  console.log(`${fileLabel}: conch review contract ${result} -> ${instructionsPath}`);
  return result;
}

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

export interface SetupSelection {
  service: boolean;
  plugin: boolean;
}

export interface SetupOptions extends SetupSelection {
  absBun: string;
  absCli: string;
}

export interface SetupCompletion {
  service: "installed" | "skipped";
  plugin: "installed" | "skipped" | "failed";
}

export interface SetupInstallers {
  service: (cfg: Config, action: "install") => Promise<void>;
  plugin: (absBun: string, absCli: string) => Promise<boolean>;
}

/** Parse setup's two independent opt-outs without making their order significant. */
export function parseSetupArgs(args: readonly string[]): SetupSelection {
  const allowed = new Set(["--no-service", "--no-plugin"]);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) {
    throw new Error(
      `unknown setup option: ${unknown}\nusage: conch setup [--no-service] [--no-plugin]`,
    );
  }
  return {
    service: !args.includes("--no-service"),
    plugin: !args.includes("--no-plugin"),
  };
}

/**
 * Run setup's final integrations through the exact same installers exposed as
 * standalone commands. The small injection seam keeps option handling and call
 * order testable without installing a real launch agent in the test process.
 */
export async function runSetupIntegrations(
  cfg: Config,
  options: SetupOptions,
  installers: SetupInstallers = {
    service: runService,
    plugin: runInstallPlugin,
  },
): Promise<SetupCompletion> {
  let service: SetupCompletion["service"] = "skipped";
  let plugin: SetupCompletion["plugin"] = "skipped";

  if (options.service) {
    console.log("\nInstalling the background service…");
    await installers.service(cfg, "install");
    service = "installed";
  }

  if (options.plugin) {
    console.log("\nInstalling the conch plugin for available apps…");
    try {
      plugin = await installers.plugin(options.absBun, options.absCli)
        ? "installed"
        : "failed";
    } catch (error) {
      console.error(
        `[conch] install-plugin failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      plugin = "failed";
    }
  }

  return { service, plugin };
}

/** Final setup output; nothing actionable is printed after this block. */
export function renderSetupReady(completion: SetupCompletion): string {
  const service = completion.service === "installed"
    ? "✓ background service (running now + starts at login)"
    : "○ background service skipped (--no-service)";
  const plugin = completion.plugin === "installed"
    ? "✓ plugin for available Claude Code / Codex apps"
    : completion.plugin === "failed"
      ? "✗ app plugin installation failed"
      : "○ app plugin skipped (--no-plugin)";
  const manualStart = completion.service === "skipped"
    ? "\n│   Start the daemon your way before trying this."
    : "";

  return `╭─ 🐚 YOU'RE READY
│
│ Installed and configured:
│   ✓ dependencies + speech models
│   ✓ Claude Code hooks
│   ${service}
│   ${plugin}
│
│ FIRST THING TO TRY${manualStart}
│   Finish a turn in any Claude Code session; conch will speak it.
│   Open \`conch\` and press space to talk back.
╰─`;
}

/**
 * One-command bootstrap for a fresh machine: installs the binaries conch shells
 * out to (via Homebrew), downloads the whisper + VAD models, wires the Claude
 * Code hooks, installs the launchd service + app plugin, and runs doctor.
 * Idempotent — re-running skips or safely refreshes managed pieces.
 */
export async function runSetup(
  cfg: Config,
  options: SetupOptions = {
    service: true,
    plugin: true,
    absBun: process.execPath,
    absCli: CLI_ENTRY,
  },
): Promise<void> {
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

  // 3. Kokoro voices (optional). The server extra is retained solely so
  // CONCH_TTS=server remains an immediate rollback path.
  if (!Bun.which(cfg.ttsServerBin)) {
    console.log('\nℹ️  Natural per-session voices are optional. For them, install mlx-audio:');
    console.log('      uv tool install --with "misaki[en]" \\');
    console.log('        --with "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \\');
    console.log('        "mlx-audio[server]"');
    console.log("   Without it, conch uses the macOS `say` voice.");
  } else {
    const workerPython = resolveMlxAudioPython(cfg.ttsWorkerPython, cfg.ttsServerBin);
    console.log(
      workerPython
        ? `✅ kokoro worker available via ${workerPython}`
        : `ℹ️  ${cfg.ttsServerBin} exists but its Python could not be resolved — set CONCH_TTS_WORKER_PYTHON`,
    );
  }

  // 4. Wire Claude Code and give both supported agents the global review
  //    contract. Codex hooks remain an explicit `conch install --codex` opt-in.
  console.log("\nWiring Claude Code hooks and global review instructions…");
  await runInstall(cfg);
  await installReviewInstructions(
    join(homedir(), ".codex", "AGENTS.md"),
    "AGENTS.md",
  );
  console.log("\nRunning doctor…\n");
  await runDoctor(cfg);
  const completion = await runSetupIntegrations(cfg, options);
  if (completion.plugin === "failed") {
    console.error("\n❌ Setup incomplete — plugin installation failed; review the errors above.");
    process.exitCode = 1;
    return;
  }

  console.log(`\n${renderSetupReady(completion)}`);
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
    join(homedir(), ".local/bin"), // mlx_audio.server; its shebang locates the worker Python
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

export interface CodexHooksBuildResult {
  settings: Record<string, any>;
  changed: boolean;
  addedEvents: string[];
}

/**
 * Build the Codex hooks.json merge without touching disk. Keeping this pure
 * makes the opt-in installer fully testable without ever probing ~/.codex.
 */
export function buildCodexHooksSettings(
  existing: Record<string, any>,
  command: string,
): CodexHooksBuildResult {
  const settings = structuredClone(existing);
  settings.hooks ??= {};
  let changed = false;
  const addedEvents: string[] = [];
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    const entries: HookEntry[] = (settings.hooks[event] ??= []);
    const already = entries.some((entry) =>
      entry.hooks?.some((hook) =>
        hook.command === command
        || (hook.command?.includes("conch") && hook.command?.includes("codex-hook"))
      )
    );
    if (already) continue;
    entries.push({ hooks: [{ type: "command", command, timeout: 15 }] });
    changed = true;
    addedEvents.push(event);
  }
  return { settings, changed, addedEvents };
}

/**
 * Explicit Codex opt-in: merge command hooks into ~/.codex/hooks.json and put
 * the review handoff contract in ~/.codex/AGENTS.md. Existing content in both
 * files is preserved; backups are written only for files that actually change.
 */
export async function runCodexInstall(
  codexDir = join(homedir(), ".codex"),
): Promise<void> {
  const hooksPath = join(codexDir, "hooks.json");
  const instructionsPath = join(codexDir, "AGENTS.md");
  const command = `${conchInvocation()} codex-hook`;

  let existing: Record<string, any> = {};
  if (existsSync(hooksPath)) {
    existing = await Bun.file(hooksPath).json();
  }

  const result = buildCodexHooksSettings(existing, command);
  const instructionsResult = await installReviewInstructions(
    instructionsPath,
    "AGENTS.md",
  );
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    if (result.addedEvents.includes(event)) {
      console.log(`${event}: wired -> ${command}`);
    } else {
      console.log(`${event}: conch codex-hook already wired, skipping`);
    }
  }

  if (result.changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    if (existsSync(hooksPath)) {
      const backup = `${hooksPath}.conch-backup-${Date.now()}`;
      await Bun.write(backup, await Bun.file(hooksPath).text());
      console.log(`backed up hooks to ${backup}`);
    }
    await Bun.write(hooksPath, JSON.stringify(result.settings, null, 2) + "\n");
  }
  const instructionsChanged =
    instructionsResult === "created" || instructionsResult === "updated";
  if (result.changed) {
    console.log("\nDone. Codex hooks installed.");
  } else if (instructionsChanged) {
    console.log("\nDone. Global Codex review instructions installed; hooks were already wired.");
  } else if (instructionsResult === "skipped") {
    console.log("\nCodex hooks were already wired; global review instructions were skipped (see warning above).");
  } else {
    console.log("\nNothing to do.");
  }
  console.log(`
Verify Codex hook activation:
  hooks file: ${hooksPath}
  first run: The first \`codex\` run shows Codex's hook trust-review screen; the conch hooks must be approved there.
  confirm: After Codex starts, run \`conch sessions\` and check that the Codex session is listed.`);
}

/**
 * Merge conch's hooks into ~/.claude/settings.json and put the review handoff
 * contract in global CLAUDE.md. Existing content in both files is preserved;
 * backups are written only for files that actually change.
 */
export async function runInstall(cfg: Config): Promise<void> {
  const settingsPath = join(cfg.claudeDir, "settings.json");
  const instructionsPath = join(cfg.claudeDir, "CLAUDE.md");
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

  const instructionsResult = await installReviewInstructions(
    instructionsPath,
    "CLAUDE.md",
  );

  if (changed) {
    // Back up only when we're actually about to modify — the old code wrote a
    // fresh timestamped backup on every run, even "Nothing to do", piling up.
    if (existsSync(settingsPath)) {
      const backup = `${settingsPath}.conch-backup-${Date.now()}`;
      await Bun.write(backup, await Bun.file(settingsPath).text());
      console.log(`backed up settings to ${backup}`);
    }
    // A Codex-only fresh machine may not have ~/.claude yet. Setup still wires
    // the hooks so Claude Code will pick them up whenever it is installed.
    mkdirSync(dirname(settingsPath), { recursive: true });
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  const instructionsChanged =
    instructionsResult === "created" || instructionsResult === "updated";
  if (changed) {
    console.log("\nDone. Open /hooks in Claude Code (or restart sessions) to reload config.");
  } else if (instructionsChanged) {
    console.log("\nDone. Global Claude Code review instructions installed; hooks were already wired.");
  } else if (instructionsResult === "skipped") {
    console.log("\nClaude Code hooks were already wired; global review instructions were skipped (see warning above).");
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
  const workerPython = resolveMlxAudioPython(cfg.ttsWorkerPython, cfg.ttsServerBin);
  const ttsSummary = cfg.ttsEngine === "say"
    ? "say (forced)"
    : cfg.ttsEngine === "server"
      ? ttsAvailable
        ? `legacy kokoro HTTP server via ${cfg.ttsServerBin} on :${cfg.ttsPort}, ${cfg.ttsVoices.length} voices`
        : `say — ${cfg.ttsServerBin} not found`
      : workerPython
        ? `owned kokoro worker via ${workerPython}, ${cfg.ttsVoices.length} voices (no HTTP listener)`
        : `say — mlx-audio Python not found via ${cfg.ttsServerBin}`;
  console.log(
    `ℹ️  tts: ${ttsSummary}`,
  );

  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
