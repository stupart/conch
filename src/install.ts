import { join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync, unlinkSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { CONCH_DATA } from "./config.ts";
import { runInstallPlugin } from "./plugin-install.ts";
import { resolveMlxAudioPython } from "./tts-worker.ts";
import { checkMicrophone, checkTts, formatDoctorProbe } from "./doctor-checks.ts";
import { CONCH_VERSION } from "./version.ts";

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

export interface SetupReadyOptions {
  /** A pre-existing Codex install has not opted into conch's lifecycle hooks. */
  codexNeedsInstall?: boolean;
  /** Injectable for stable string tests; defaults to terminal color support. */
  color?: boolean;
}

export interface HardDependency {
  binary: string;
  formula: string;
  why: string;
  path?: string;
}

export interface SetupInstallers {
  service: (cfg: Config, action: "install") => Promise<void>;
  plugin: (absBun: string, absCli: string) => Promise<boolean>;
}

const HARD_DEPENDENCIES = [
  { binary: "sox", formula: "sox", why: "microphone capture" },
  { binary: "tmux", formula: "tmux", why: "daemon hosting + pane injection" },
] as const;

/** Resolve setup's hard, Homebrew-provided dependencies without doing any work. */
export function missingHardDependencies(
  cfg: Pick<Config, "whisperCli">,
  which: (binary: string) => string | null = Bun.which,
  pathExists: (path: string) => boolean = existsSync,
): HardDependency[] {
  const missing: HardDependency[] = [];
  for (const dependency of HARD_DEPENDENCIES) {
    if (!which(dependency.binary)) missing.push({ ...dependency });
  }
  if (!pathExists(cfg.whisperCli)) {
    missing.push({
      binary: "whisper-cli",
      formula: "whisper-cpp",
      why: "speech-to-text",
      path: cfg.whisperCli,
    });
  }
  return missing;
}

export function hardDependencyInstallCommand(
  missing: readonly Pick<HardDependency, "formula">[],
): string {
  const formulas = [...new Set(missing.map((dependency) => dependency.formula))];
  return `brew install ${formulas.join(" ")}`;
}

/** Copyable failure shown before setup is allowed to create/download model files. */
export function renderHardDependencyFailure(
  missing: readonly HardDependency[],
  brewAvailable: boolean,
): string {
  const lines = [
    "❌ conch setup stopped before downloading speech models: required dependencies are missing.",
    `Missing: ${missing.map((dependency) => `${dependency.binary} (${dependency.why})`).join(", ")}`,
  ];
  if (!brewAvailable) lines.push("Install Homebrew: https://brew.sh");
  lines.push(hardDependencyInstallCommand(missing));
  lines.push("Then re-run `conch setup`.");
  return lines.join("\n");
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

/** Final setup output; its first line is the one action a skimming user needs. */
export function renderSetupReady(
  completion: SetupCompletion,
  options: SetupReadyOptions = {},
): string {
  // No Codex nudge. It used to lead with "Run `conch install --codex`", which
  // wires hooks that Codex 0.144.1 never executes — the first thing a new
  // person was told to do was the one thing that does not work.
  const first = "╭─ 🐚 DO THIS FIRST — Type /hooks in any Claude Code session you already have open.";
  const pickup = options.codexNeedsInstall
    ? "│ Codex is present; its support is unfinished and stays off (see the README)."
    : "│ Sessions opened from now on pick conch up automatically.";
  const then = completion.service === "skipped"
    ? "│ THEN — Run `conch daemon` to start the voice loop; leave it open, then\n│ finish a turn. conch reads it aloud, plays a tink, and opens the mic."
    : "│ THEN — Just finish a turn. conch reads it aloud, plays a tink, and opens\n│ the mic; talk, pause, and your words go back into that session.";
  const installed = [
    "hooks",
    ...(completion.plugin === "installed" ? ["plugin"] : []),
    ...(completion.service === "installed"
      ? ["background service (starts at login)"]
      : []),
    "speech models",
  ].join(" · ");
  const useColor = options.color
    ?? (process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY));
  const footer = useColor
    ? `\x1b[2minstalled: ${installed}\x1b[22m`
    : `installed: ${installed}`;

  return `${first}
${pickup}
│
${then}
│
│ macOS will ask for microphone access the first time something speaks. Allow it.
│ If you miss the prompt, run \`conch doctor\`.
│
│ WHERE TO LOOK — \`conch\` (the terminal dashboard, also what to use over ssh)
│ IF IT'S QUIET — \`conch doctor\`
│
│ ${footer}
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
  let missing = missingHardDependencies(cfg);
  if (missing.length) {
    if (!brew) {
      console.error(renderHardDependencyFailure(missing, false));
      process.exitCode = 1;
      return;
    } else {
      console.log(`Installing via Homebrew: ${missing.map((m) => `${m.formula} (${m.why})`).join(", ")}`);
      const proc = Bun.spawn(["brew", "install", ...missing.map((m) => m.formula)], { stdout: "inherit", stderr: "inherit" });
      const code = await proc.exited;
      if (code !== 0) {
        console.error(`\n${renderHardDependencyFailure(missing, true)}`);
        process.exitCode = 1;
        return;
      }
      console.log("");
    }
  }

  // Never cross the large-download boundary until the dependencies actually
  // resolve. A successful package-manager exit is not enough evidence by itself.
  missing = missingHardDependencies(cfg);
  if (missing.length) {
    console.error(renderHardDependencyFailure(missing, true));
    process.exitCode = 1;
    return;
  }
  console.log("✅ binaries present (sox, tmux, whisper-cpp)");

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
  const codexDir = join(homedir(), ".codex");
  // Capture this before writing the cross-agent review contract: setup itself
  // must not make every Claude-only machine look like an existing Codex install.
  const codexWasPresent = existsSync(codexDir);
  console.log("\nWiring Claude Code hooks and global review instructions…");
  await runInstall(cfg);
  // Codex only gets the review contract if its hooks are actually wired.
  //
  // Setup used to write it unconditionally, so every machine with a ~/.codex
  // directory told Codex to end deliverables with `conch:review …` — a line
  // conch can only act on through the Stop hook. Codex 0.144.1 does not
  // execute ~/.codex/hooks.json at all (proven with a bare `touch` hook that
  // never fired), so the instruction went nowhere and Codex spent turns
  // honouring a contract with no counterparty. An integration that does not
  // work should be silent, not advertised.
  if (await codexHooksAreWiredAt(codexDir)) {
    await installReviewInstructions(join(codexDir, "AGENTS.md"), "AGENTS.md");
  }
  console.log("\nRunning doctor…\n");
  await runDoctor(cfg);
  const completion = await runSetupIntegrations(cfg, options);
  if (completion.plugin === "failed") {
    console.error("\n❌ Setup incomplete — plugin installation failed; review the errors above.");
    process.exitCode = 1;
    return;
  }

  const codexNeedsInstall = codexWasPresent
    && !(await codexHooksAreWiredAt(codexDir));
  console.log(`\n${renderSetupReady(completion, { codexNeedsInstall })}`);
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
# conch supervisor — keeps the daemon alive (installed by \`conch service\`)
#
# Liveness is the DAEMON PROCESS, not the tmux session. A session outlives a
# dead pane, so \`has-session\` reported healthy while conch was gone — a silent
# outage that survives indefinitely because the check can never fail. Killing
# the stale session first is what lets new-session run at all.
while true; do
  # Match how the daemon ACTUALLY runs, not one spelling of it. This read
  # \`bun run src/cli.ts daemon\`, but \`conch service install\` starts it as
  # \`bun /abs/path/src/cli.ts daemon\` — no \`run\` — so the pattern never
  # matched, the supervisor believed conch was dead, and it killed and
  # recreated the session every 5 seconds. Observed live: the socket owner
  # changed four times in twelve seconds.
  #
  # \`cli.ts daemon\` covers every spelling; filtering to a bun process is what
  # keeps a tmux wrapper carrying the same words in its argv from counting as
  # the daemon it is merely launching.
  if ! pgrep -f 'cli\.ts daemon' 2>/dev/null | xargs -I{} ps -o comm= -p {} 2>/dev/null | grep -q bun; then
    # Clear a stale session and create on the NEXT pass. Killing the last
    # session stops the tmux server, and a new-session issued in the same
    # breath races that shutdown — measured healing at 30-45s instead of one
    # interval, sometimes not at all. has-session is sound for "is there
    # something to clear"; it was only ever wrong as a liveness test.
    if "${tmux}" has-session -t conch 2>/dev/null; then
      "${tmux}" kill-session -t conch 2>/dev/null
    else
      "${tmux}" new-session -d -s conch '${daemonCmd}'
    fi
  fi
  sleep 5
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

function isConchCodexHook(command: unknown): boolean {
  return typeof command === "string"
    && command.includes("conch")
    && command.includes("codex-hook");
}

/** True only when all Codex lifecycle events have a conch hook command. */
export function codexHooksAreWired(settings: Record<string, any>): boolean {
  return ["Stop", "UserPromptSubmit", "SessionStart"].every((event) => {
    const entries = settings.hooks?.[event];
    return Array.isArray(entries) && entries.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const hooks = (entry as { hooks?: unknown }).hooks;
      return Array.isArray(hooks)
        && hooks.some((hook: unknown) =>
          Boolean(hook && typeof hook === "object"
            && isConchCodexHook((hook as { command?: unknown }).command))
        );
    });
  });
}

/** Safely inspect a pre-existing Codex install for setup's final instruction. */
export async function codexHooksAreWiredAt(codexDir: string): Promise<boolean> {
  const hooksPath = join(codexDir, "hooks.json");
  if (!existsSync(hooksPath)) return false;
  try {
    const settings = await Bun.file(hooksPath).json();
    return Boolean(settings && typeof settings === "object"
      && codexHooksAreWired(settings as Record<string, any>));
  } catch {
    return false;
  }
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
  console.log(`🐚 conch ${CONCH_VERSION}`);
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

  // These exercise the live paths rather than merely checking executables.
  // They are advisory: an ambiently silent input or an unavailable output
  // should produce a concrete recovery action without masking otherwise sound
  // installation state behind a hard doctor failure.
  console.log(formatDoctorProbe(await checkMicrophone()));
  console.log(formatDoctorProbe(await checkTts(cfg)));

  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
