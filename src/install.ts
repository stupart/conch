import { join, dirname } from "node:path";
import { existsSync, mkdirSync, chmodSync, unlinkSync, rmSync, renameSync } from "node:fs";
import { conchHome } from "./home.ts";
import type { Config } from "./config.ts";
import { CONCH_DATA } from "./config.ts";
import { readState } from "./daemon-state.ts";
import { runInstallPlugin } from "./plugin-install.ts";
import { checkAgentBinaries, checkConchBinaries, checkKokoro, checkMicrophone, checkNaturalVoices, checkSpeechEngine, checkTmux, checkTts, checkWhisperServer, formatDoctorProbe } from "./doctor-checks.ts";
import { acquireFetchLock, VAD_MODEL, WHISPER_MODEL } from "./speech-engine.ts";
import { CONCH_VERSION } from "./version.ts";

const SERVICE_LABEL = "com.conch.daemon";

// The two models conch downloads on a fresh machine — the daemon does it on its
// first run too (speech-engine.ts); this is the foreground way. Both live under
// ~/.cache/conch/models, the models' last candidate, and both are pinned by
// sha256 (the same pins seashell verifies): a download that is not those exact
// bytes never lands. conch.app carries the VAD model, so with the app installed
// only the whisper model is fetched.
const MODELS = [
  { ...WHISPER_MODEL, label: "whisper large-v3-turbo (~574 MB)", minBytes: 500_000_000 },
  { ...VAD_MODEL, label: "silero VAD (~900 KB)", minBytes: 100_000 },
] as const;

// conch runs two ways: via bun (dev / `bun link`, where process.execPath is bun
// and the entry is src/cli.ts) or as a `bun build --compile` standalone binary
// (where process.execPath IS the conch binary and there is no src/cli.ts). The
// hook + service commands must name whichever actually re-invokes conch here.
const CLI_ENTRY = join(import.meta.dir, "cli.ts");
const IS_COMPILED = !existsSync(CLI_ENTRY);

/**
 * The path that runs `execPath` and survives its package manager's upgrades. Homebrew keeps each version under
 * `<prefix>/Cellar/<formula>/<version>/`, links `<prefix>/bin/<name>` to the current one, and deletes the old version
 * on upgrade. `process.execPath` is the resolved Cellar path, so hooks written with it named
 * `/opt/homebrew/Cellar/bun/1.4.0/bin/bun`, and once bun went to 1.4.2 every prompt in that account failed with
 * "UserPromptSubmit hook error … No such file or directory" (2026-10-03). So the link, whenever there is one.
 */
export function stableExecPath(execPath: string = process.execPath, exists: (path: string) => boolean = existsSync): string {
  const cellar = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/([^/]+)$/.exec(execPath);
  if (cellar) {
    const linked = `${cellar[1]}/bin/${cellar[2]}`;
    if (exists(linked)) return linked;
  }
  return execPath;
}

/** Shell-quoted argv that re-invokes conch: `"conch"` (compiled) or `"bun" "…/cli.ts"`, by its upgrade-proof path. */
export function conchInvocation(execPath: string = stableExecPath()): string {
  return IS_COMPILED ? `"${execPath}"` : `"${execPath}" "${CLI_ENTRY}"`;
}

/**
 * A command of conch's whose program has moved: gone from disk, or pinned inside one Homebrew Cellar version, which
 * the next upgrade deletes (`stableExecPath`). The program is the command's first quoted path, after any `NAME=value`
 * prefixes; a command that names none is never called stale.
 */
export function staleProgram(command: string | undefined, exists: (path: string) => boolean = existsSync): boolean {
  const program = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*"([^"]+)"/.exec(command ?? "")?.[1];
  return !!program && (/\/Cellar\//.test(program) || !exists(program));
}

/** Where `scripts/build-app.sh` and the brew formula put the Mac app. */
export const INSTALLED_APP_PATH = "/Applications/conch.app";

export interface SetupSelection {
  service: boolean;
  plugin: boolean;
  /** Why the service was left off without being asked to; printed where it would have installed. */
  serviceNotice?: string;
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
  /** The daemon's persisted state (`readState()`): a manual mode left by an old install is said here, not found by silence. */
  paused?: boolean;
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

/**
 * Resolve setup's hard dependencies without doing any work. conch.app carries
 * sox and whisper.cpp (speech-engine.ts resolves them from the app first), so
 * with the app installed there is nothing to brew. tmux is not one of them:
 * a session in a tmux pane is typed into through tmux, and every other session
 * through its own window (or the clipboard) — conch works without it.
 */
export function missingHardDependencies(
  cfg: Pick<Config, "whisperCli"> & Partial<Pick<Config, "soxBin">>,
  which: (binary: string) => string | null = Bun.which,
  pathExists: (path: string) => boolean = existsSync,
): HardDependency[] {
  const missing: HardDependency[] = [];
  const sox = cfg.soxBin || "sox";
  if (!(sox.includes("/") ? pathExists(sox) : which(sox))) {
    missing.push({ binary: "sox", formula: "sox", why: "microphone capture" });
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

/**
 * Parse setup's opt-outs without making their order significant.
 *
 * The Mac app hosts its own daemon (DaemonHost.swift), so when it is installed
 * the launchd service is a second daemon fighting the app's over the socket and
 * the microphone. Forgetting `--no-service` on a source install was how that
 * happened; now the app's presence is the default and `--service` forces it.
 */
export function parseSetupArgs(
  args: readonly string[],
  appInstalled: boolean = existsSync(INSTALLED_APP_PATH),
): SetupSelection {
  const allowed = new Set(["--service", "--no-service", "--no-plugin"]);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) {
    throw new Error(
      `unknown setup option: ${unknown}\nusage: conch setup [--service|--no-service] [--no-plugin]`,
    );
  }
  const leftToApp = appInstalled && !args.includes("--service") && !args.includes("--no-service");
  return {
    service: args.includes("--service") || !(args.includes("--no-service") || appInstalled),
    plugin: !args.includes("--no-plugin"),
    ...(leftToApp
      ? {
        serviceNotice: `Skipping the background service: ${INSTALLED_APP_PATH} is installed and `
          + "runs the daemon itself — open the app if it is not running. "
          + "To install the launchd service anyway: `conch setup --service`.",
      }
      : {}),
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
  } else if (options.serviceNotice) {
    console.log(`\n${options.serviceNotice}`);
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
  // No Codex step. It used to lead with "Run `conch install --codex`", which wires hooks that Codex 0.144.1 never
  // executes, so the first thing a new person was told to do was the one thing that did not work. conch follows Codex
  // sessions without them (its rollouts and app-server: a Mac with no ~/.codex/hooks.json still hears every Codex turn
  // end), so Codex is named as working. Until 2026-10-09 this line said Codex support was "unfinished and stays off",
  // in 0.4.0's own setup, the release that shipped Codex support.
  const first = "╭─ DO THIS FIRST — Type /hooks in any Claude Code session you already have open.";
  const pickup = options.codexNeedsInstall
    ? "│ Sessions opened from now on pick conch up automatically, Codex's as well as\n│ Claude Code's; Codex needs nothing more."
    : "│ Sessions opened from now on pick conch up automatically.";
  const then = completion.service === "skipped"
    ? "│ THEN — Run `conch daemon` to start the voice loop; leave it open, then\n│ finish a turn. conch reads it aloud, plays a tink, and opens the mic."
    : "│ THEN — Just finish a turn. conch reads it aloud, plays a tink, and opens\n│ the mic; talk, pause, and your words go back into that session.";
  const mode = options.paused
    ? "│ MODE — manual (persisted from a previous install): conch stays silent until\n│ you press p in `conch` or run `conch resume`."
    : "│ MODE — auto: conch speaks after every finished turn; p in `conch` or\n│ `conch pause` makes it manual.";
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
${mode}
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
  console.log("conch setup — getting your machine ready for voice\n");

  // 1. Binaries. conch.app carries sox and whisper-cli/-server; without it they
  //    come from Homebrew (sox, whisper-cpp). tmux is optional. `say`/`afplay`
  //    are macOS built-ins (checked by doctor).
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
  console.log(`✅ binaries present (sox at ${cfg.soxBin}, whisper-cli at ${cfg.whisperCli})`);

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
    // The daemon fetches the same file on its first run (speech-engine.ts):
    // one writer per `.part`, so wait for it rather than race it.
    let held = acquireFetchLock(dest);
    if ("heldBy" in held) console.log(`⏳ ${m.label}: the conch daemon (pid ${held.heldBy}) is downloading it — waiting`);
    while ("heldBy" in held && !existsSync(dest)) {
      await Bun.sleep(2_000);
      held = acquireFetchLock(dest);
    }
    if ("heldBy" in held) {
      console.log(`✅ ${m.label} downloaded by the daemon to ${dest}`);
      continue;
    }
    try {
      if (existsSync(dest)) {
        console.log(`✅ ${m.label} downloaded by the daemon to ${dest}`);
        continue;
      }
      await downloadModel(m, dest);
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}. Check your connection and re-run \`conch setup\`.`);
      process.exit(1);
    } finally {
      held.release();
    }
  }

  // 3. Natural voices (Kokoro). Nothing to install: the daemon builds conch's
  // own voice environment in the background with the uv the app carries
  // (voice-env.ts), and speaks with `say` until it is ready. Setup only says so.
  console.log(`\n${formatDoctorProbe(checkNaturalVoices(cfg))}`);
  if (cfg.ttsEngine === "worker" && !cfg.ttsWorkerPython.trim()) {
    console.log("   Every session gets its own voice. To opt out: CONCH_TTS=say. To use your own Python: CONCH_TTS_WORKER_PYTHON.");
  }

  // 4. Wire Claude Code's hooks. Codex hooks remain an explicit
  //    `conch install --codex` opt-in.
  //
  // Nothing here writes to CLAUDE.md or AGENTS.md. Conch used to splice a
  // managed review-contract block into the user's GLOBAL instruction files,
  // which meant installing a voice tool silently edited the prompt of every
  // session on the machine, and every wording change needed a reinstall to
  // take. The contract now ships entirely inside the plugin, rendered from
  // `src/agent-instructions.ts` into its AGENTS.md, its conch-control skill,
  // the help session and the tool descriptions, so it arrives and updates with
  // the thing it describes, and uninstalling actually removes it.
  const codexDir = join(conchHome(), ".codex");
  // Capture this before the install runs: setup must not make every
  // Claude-only machine look like an existing Codex install.
  const codexWasPresent = existsSync(codexDir);
  console.log("\nWiring Claude Code hooks…");
  await runInstall(cfg);
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
  console.log(`\n${renderSetupReady(completion, { codexNeedsInstall, paused: readState().paused })}`);
}

/** Where download progress goes; injectable so a test can read it back. */
export interface DownloadOutput {
  write(text: string): void;
  tty: boolean;
}

/** "885 KB", "574 MB", "1.62 GB" — coarse on purpose, so a redraw only fires when the text reads differently. */
export function formatBytes(n: number): string {
  if (n < 1_000_000) return `${Math.round(n / 1_000)} KB`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

/** "120 MB / 574 MB (20%)", or "120 MB / size unknown" when the server sent no Content-Length. */
export function formatProgress(done: number, total?: number): string {
  if (!total) return `${formatBytes(done)} / size unknown`;
  return `${formatBytes(done)} / ${formatBytes(total)} (${Math.floor((done / total) * 100)}%)`;
}

/**
 * A progress line that redraws in place on a terminal. Piped (CI, a log file)
 * it prints once per 10% — once per 100 MB when the size is unknown — so the
 * log stays readable.
 */
export function progressReporter(total: number | undefined, out: DownloadOutput): (done: number) => void {
  let last: string | number = "";
  return (done) => {
    const line = formatProgress(done, total);
    const key = out.tty ? line : total ? Math.floor((done / total) * 10) : Math.floor(done / 100_000_000);
    if (key === last) return;
    last = key;
    out.write(out.tty ? `\r   ${line}\x1b[K` : `   ${line}\n`);
  };
}

/**
 * Stream a model to a temp path with a progress line, size-check it, then
 * atomically move it into place. Throws on an HTTP error or a too-small file
 * (a 404 page masquerading as the model); the caller says what to do next.
 *
 * This was a curl subprocess. Its bar showed neither the total nor the bytes,
 * and nothing said how big the file was before it began, so on a slow
 * connection `conch setup` looked hung for the length of a 574 MB download.
 */
export async function downloadModel(
  model: { url: string; label: string; minBytes: number; sha256?: string },
  dest: string,
  out: DownloadOutput = { write: (text) => process.stdout.write(text), tty: Boolean(process.stdout.isTTY) },
): Promise<void> {
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || undefined;
  out.write(`⬇️  ${model.label}: ${total ? formatBytes(total) : "size unknown"} → ${dest}\n`);
  const report = progressReporter(total, out);
  const sink = Bun.file(tmp).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let done = 0;
  for await (const chunk of res.body) {
    sink.write(chunk);
    hasher.update(chunk);
    done += chunk.byteLength;
    report(done);
  }
  await sink.end();
  if (out.tty) out.write("\n");
  if (done < model.minBytes) {
    rmSync(tmp, { force: true });
    throw new Error(`downloaded file is too small (${done} bytes) — the URL may have returned an error page`);
  }
  // Pinned: the same bytes seashell verifies, or nothing lands.
  const digest = hasher.digest("hex");
  if (model.sha256 && digest !== model.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`checksum mismatch — sha256 ${digest}, expected ${model.sha256}`);
  }
  renameSync(tmp, dest); // same dir → atomic, no 574 MB re-copy
}

/**
 * Install (or remove) a launchd agent that runs the daemon directly.
 *
 * This used to be a shell loop that polled every five seconds and kept the
 * daemon inside a detached tmux session. Both halves are gone. launchd's
 * KeepAlive already restarts a dead job, so the polling loop was a second
 * supervisor competing with the first — racing it produced three simultaneous
 * daemons and most of one day's instability.
 *
 * The tmux host was worse than redundant: a detached pane is a terminal with
 * no reader, so the daemon's own dashboard would eventually block inside
 * write(2) with the socket accept loop stuck behind it. conch stayed alive in
 * `ps` while every phone request timed out as "couldn't reach your Mac". The
 * original reason for tmux still holds — Terminal.app can segfault walking a
 * churning process tree, so the daemon must never live in a Terminal window —
 * but launchd gives us no terminal at all, which satisfies that constraint
 * more completely than tmux did.
 *
 * With no TTY the daemon selects the headless renderer and draws nothing. To
 * watch it, run `conch` in a terminal or open the Mac app: both are viewers
 * that attach over the socket, which is what they were always meant to be.
 */
export function renderSupervisorScript(_tmux: string, _daemonCmd: string): string {
  // Retained only so an older installed copy can still be recognised and
  // replaced; nothing generates a supervisor script any more.
  return "#!/bin/zsh\n# obsolete — conch is supervised by launchd directly\n";
}

export function serviceRestartCommands(tmux: string | null, uid: number): string[][] {
  return [
    // Clear a session left by an older tmux-hosted install, so its daemon
    // cannot keep the socket while launchd starts the replacement. No tmux,
    // no such session: spawning a missing binary would throw before kickstart.
    ...(tmux ? [[tmux, "kill-session", "-t", "conch"]] : []),
    ["launchctl", "kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`],
  ];
}

/**
 * `conch service off`, and what the Mac app's "Let the app own it" runs (A3):
 * unload the agent by its label — never a kill by pattern — and drop the plist
 * so login does not bring it back. Both effects are injected for the test.
 */
export function serviceOff(
  uid: number,
  plistPath: string,
  run: (argv: string[]) => unknown = (argv) => Bun.spawnSync(argv),
  unlink: (path: string) => void = unlinkSync,
): void {
  run(["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]);
  try {
    unlink(plistPath);
  } catch {}
}

/**
 * launchd exec's ProgramArguments directly — no shell — so every element is
 * one argv word and nothing may carry quotes. The compiled branch used
 * `conchInvocation()`, a SHELL-quoted string, so a brew install wrote
 * `"/opt/homebrew/bin/conch"` (quotes included) as argv[0] and the service
 * never started. Found by the A2/A3 agent, 2026-09-11.
 */
export function serviceDaemonArgv(compiled: boolean, execPath: string, conchRoot: string): string[] {
  return compiled
    ? [execPath, "daemon"]
    : [execPath, join(conchRoot, "src", "cli.ts"), "daemon"];
}

export function renderServicePlist(
  { daemonArgv, conchRoot, path, carriedEnv }: { daemonArgv: string[]; conchRoot: string; path: string; carriedEnv: string },
): string {
  // CONCH_STARTED_BY is how the daemon's identity file names launchd as its
  // owner, which is what lets the Mac app say so instead of "outside this app".
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${daemonArgv.map((arg) => `<string>${arg}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${conchRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path}</string>
    <key>CONCH_STARTED_BY</key><string>launchd</string>${carriedEnv}
  </dict>
  <key>StandardOutPath</key><string>/tmp/conch-supervisor.log</string>
  <key>StandardErrorPath</key><string>/tmp/conch-supervisor.log</string>
</dict>
</plist>
`;
}

export async function runService(cfg: Config, action: "install" | "off"): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  const plistPath = join(conchHome(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);

  if (action === "off") {
    serviceOff(uid, plistPath);
    console.log("[conch] service removed — the daemon it was running has stopped");
    return;
  }

  const conchRoot = dirname(import.meta.dir); // src/.. (real only when run via bun)
  // tmux is still how the daemon types into a session's pane; it just no longer
  // hosts the daemon itself. An install without it is degraded, not broken.
  const tmux = Bun.which("tmux");

  // A launchd job inherits none of the shell you installed from, so settings
  // that live only in the environment would silently revert to their defaults
  // at login. CONCH_TTS is the one that matters in practice: the MLX voice
  // model needs several gigabytes, and on a machine already swapping it stalls
  // the daemon in page-fault waits — alive in `ps`, never reading its socket,
  // which is what "couldn't reach your Mac" actually was. Installing with
  // `CONCH_TTS=say conch service install` has to stick — and so does pointing
  // the voices at your own Python (CONCH_TTS_WORKER_PYTHON) or uv (CONCH_UV).
  const carriedEnv = ["CONCH_TTS", "CONCH_TTS_MODEL", "CONCH_TTS_VOICES", "CONCH_TTS_WORKER_PYTHON", "CONCH_UV", "CONCH_SEASHELL_ROOT"]
    .filter((key) => process.env[key])
    .map((key) => `\n    <key>${key}</key><string>${process.env[key]}</string>`)
    .join("");

  // launchd exec's this directly — no shell, so every word is its own argv
  // entry and nothing needs quoting.
  // Homebrew's stable path, not this version's Cellar folder, which the next `brew upgrade` deletes: the hooks broke
  // that way (#496), and a login service pointing there would simply never start again.
  const daemonArgv = serviceDaemonArgv(IS_COMPILED, stableExecPath(), conchRoot);

  const path = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(conchHome(), ".local/bin"), // mlx_audio.server; its shebang locates the worker Python
    join(conchHome(), ".bun/bin"),
    "/usr/bin",
    "/bin",
  ].join(":");
  const plist = renderServicePlist({ daemonArgv, conchRoot, path, carriedEnv });
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
  console.log(`[conch] service installed — daemon restarted, starts at login, and restarts if it dies.
  view:      open the conch app, or run \`conch\` in a terminal
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

/** Any case: a source checkout at ~/Projects/Conch writes `"<bun>" "…/Conch/src/cli.ts" codex-hook`, as Claude's side found. */
function isConchCodexHook(command: unknown): boolean {
  return typeof command === "string"
    && /conch|cli\.ts/i.test(command)
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
    // As Claude's: a conch hook whose program has moved is pointed at this one (`staleProgram`).
    for (const hook of entries.flatMap((entry) => entry.hooks ?? [])) {
      if (hook.command !== command && isConchCodexHook(hook.command) && staleProgram(hook.command)) {
        hook.command = command;
        changed = true;
      }
    }
    const already = entries.some((entry) =>
      entry.hooks?.some((hook) =>
        hook.command === command
        || isConchCodexHook(hook.command)
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
/** What an install wrote: whether the agent's file changed, the file, and where the old one was backed up. */
export interface HooksInstallResult {
  changed: boolean;
  file: string;
  backup: string | null;
}

export async function runCodexInstall(
  codexDir = join(conchHome(), ".codex"),
): Promise<HooksInstallResult> {
  const hooksPath = join(codexDir, "hooks.json");
  const command = `${conchInvocation()} codex-hook`;

  let existing: Record<string, any> = {};
  if (existsSync(hooksPath)) {
    existing = await Bun.file(hooksPath).json();
  }

  const result = buildCodexHooksSettings(existing, command);
  for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
    if (result.addedEvents.includes(event)) {
      console.log(`${event}: wired -> ${command}`);
    } else {
      console.log(`${event}: conch codex-hook already wired, skipping`);
    }
  }

  let backup: string | null = null;
  if (result.changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    if (existsSync(hooksPath)) {
      backup = `${hooksPath}.conch-backup-${Date.now()}`;
      await Bun.write(backup, await Bun.file(hooksPath).text());
      console.log(`backed up hooks to ${backup}`);
    }
    await Bun.write(hooksPath, JSON.stringify(result.settings, null, 2) + "\n");
  }
  if (result.changed) {
    console.log("\nDone. Codex hooks installed.");
  } else {
    console.log("\nNothing to do.");
  }
  console.log(`
Verify Codex hook activation:
  hooks file: ${hooksPath}
  first run: The first \`codex\` run shows Codex's hook trust-review screen; the conch hooks must be approved there.
  confirm: After Codex starts, run \`conch sessions\` and check that the Codex session is listed.`);
  return { changed: result.changed, file: hooksPath, backup };
}

/** Said only when hooks were actually written: an unchanged install has nothing for open sessions to reload. */
export const HOOKS_WIRED_LINE =
  "Done. Any Claude Code session already open needs `/hooks` typed once; sessions opened from now on pick conch up automatically.";

/**
 * The Claude Code events `conch install` wires to `conch hook`.
 *
 * PermissionRequest: the only moment a pending permission's tool call is knowable on
 * Claude Code 2.1.280 (see hook.ts); conch reports it and never answers it here.
 * SessionStart: a stopped session resumed in a new terminal is a new process under its
 * old id, and conch knew only the old one until the first prompt (see hook.ts).
 *
 * The merge adds only what an install lacks, so an existing install gains a new event on
 * its next `conch install` or `conch setup`, and keeps the rest untouched.
 */
export const CLAUDE_HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "PermissionRequest", "SessionStart"] as const;

/**
 * A hook command that runs conch's hook: `"<bun>" "<…>/src/cli.ts" hook`, `"<…>/conch" hook`, or the Mac app's own
 * daemon, `"<…>/conch.app/Contents/Helpers/conch-daemon" hook`, which is what setup writes from the app.
 */
export function isConchHookCommand(command: string | undefined): boolean {
  return /(?:conch(?:-daemon)?|cli\.ts)"?\s+hook\s*$/i.test(command ?? "");
}

/**
 * Repair, never add: point conch's own hooks in `<claudeDir>/settings.json` whose program has moved (`staleProgram`)
 * at this one. The daemon runs it for every account at start, so a Homebrew upgrade of bun can't leave an account's
 * every prompt failing until someone re-runs setup (2026-10-03). A hook someone removed stays removed; a file that
 * can't be read is left alone. How many were repaired.
 */
export async function repairConchHooks(claudeDir: string): Promise<number> {
  const settingsPath = join(claudeDir, "settings.json");
  let settings: Record<string, any>;
  try {
    settings = await Bun.file(settingsPath).json();
  } catch {
    return 0;
  }
  const command = `${conchInvocation()} hook`;
  let repaired = 0;
  for (const entries of Object.values(settings?.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const hook of (entries as HookEntry[]).flatMap((entry) => entry?.hooks ?? [])) {
      if (hook && hook.command !== command && isConchHookCommand(hook.command) && staleProgram(hook.command)) {
        hook.command = command;
        repaired += 1;
      }
    }
  }
  if (!repaired) return 0;
  await Bun.write(`${settingsPath}.conch-backup-${Date.now()}`, await Bun.file(settingsPath).text());
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return repaired;
}

/**
 * Merge conch's hooks into ~/.claude/settings.json and put the review handoff
 * contract in global CLAUDE.md. Existing content in both files is preserved;
 * backups are written only for files that actually change.
 */
export async function runInstall(cfg: Pick<Config, "claudeDir">): Promise<HooksInstallResult> {
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
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entries: HookEntry[] = (settings.hooks[event] ??= []);
    // A hook of conch's whose bun has moved is pointed at this one, in place: "already wired" left it failing on every
    // prompt after a Homebrew upgrade (`staleProgram`).
    for (const hook of entries.flatMap((entry) => entry.hooks ?? [])) {
      if (hook.command !== command && isConchHookCommand(hook.command) && staleProgram(hook.command)) {
        console.log(`${event}: repaired ${hook.command} -> ${command}`);
        hook.command = command;
        changed = true;
      }
    }
    // Exact match first, as the Codex merge does. The loose match alone missed a
    // source checkout whose path has no lowercase "conch" in it (~/Projects/Conch),
    // so every re-run appended a fresh copy of each hook and "Done" fired every time.
    // And by shape, not exact text: a Homebrew bun upgrade (1.4.0 -> 1.4.2) changed the
    // interpreter's path in `command`, so on 2026-09-23 a re-run added a second copy of all
    // three hooks and every turn would have reached conch twice. Any `… conch hook` or
    // `… cli.ts" hook` command is conch's, whatever runs it and however the checkout is cased.
    const already = entries.some((e) => e.hooks?.some((h) =>
      h.command === command || isConchHookCommand(h.command)));
    if (already) {
      console.log(`${event}: conch hook already wired, skipping`);
      continue;
    }
    entries.push({ hooks: [{ type: "command", command, timeout: 15 }] });
    changed = true;
    console.log(`${event}: wired -> ${command}`);
  }

  let backup: string | null = null;
  if (changed) {
    // Back up only when we're actually about to modify — the old code wrote a
    // fresh timestamped backup on every run, even "Nothing to do", piling up.
    if (existsSync(settingsPath)) {
      backup = `${settingsPath}.conch-backup-${Date.now()}`;
      await Bun.write(backup, await Bun.file(settingsPath).text());
      console.log(`backed up settings to ${backup}`);
    }
    // A Codex-only fresh machine may not have ~/.claude yet. Setup still wires
    // the hooks so Claude Code will pick them up whenever it is installed.
    mkdirSync(dirname(settingsPath), { recursive: true });
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  if (changed) {
    console.log(`\n${HOOKS_WIRED_LINE}`);
  } else {
    console.log("\nNothing to do.");
  }
  return { changed, file: settingsPath, backup };
}

/** Sanity-check every external dependency conch shells out to. */
export async function runDoctor(cfg: Config): Promise<void> {
  console.log(`conch ${CONCH_VERSION}`);
  const checks: Array<[string, () => boolean | Promise<boolean>]> = [
    ["say (TTS)", () => binaryExists("say")],
    ["afplay (bell)", () => binaryExists("afplay")],
    [`sox (mic capture) at ${cfg.soxBin}`, () => cfg.soxBin.includes("/") ? existsSync(cfg.soxBin) : binaryExists(cfg.soxBin)],
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
  const ttsSummary = cfg.ttsEngine === "say"
    ? "say (forced)"
    : cfg.ttsEngine === "server"
      ? ttsAvailable
        ? `legacy kokoro HTTP server via ${cfg.ttsServerBin} on :${cfg.ttsPort}, ${cfg.ttsVoices.length} voices`
        : `say — ${cfg.ttsServerBin} not found`
      : `owned kokoro worker, ${cfg.ttsVoices.length} voices (no HTTP listener); its Python is under natural voices below`;
  console.log(
    `ℹ️  tts: ${ttsSummary}`,
  );

  // These exercise the live paths rather than merely checking executables.
  // They are advisory: an ambiently silent input or an unavailable output
  // should produce a concrete recovery action without masking otherwise sound
  // installation state behind a hard doctor failure.
  // Optional: a session in a tmux pane is typed into through tmux; every other
  // session through its own window, or the clipboard. Which tmux conch's own
  // sessions run in — the app carries one — and where it came from.
  console.log(formatDoctorProbe(checkTmux()));
  console.log(formatDoctorProbe(checkSpeechEngine(cfg)));
  console.log(formatDoctorProbe(checkConchBinaries()));
  console.log(formatDoctorProbe(await checkAgentBinaries()));
  console.log(formatDoctorProbe(await checkMicrophone({ sox: cfg.soxBin })));
  console.log(formatDoctorProbe(await checkTts(cfg)));
  console.log(formatDoctorProbe(await checkWhisperServer(cfg)));
  console.log(formatDoctorProbe(checkNaturalVoices(cfg)));
  console.log(formatDoctorProbe(await checkKokoro(cfg)));

  if (!ok) process.exit(1);
}

function binaryExists(name: string): boolean {
  return Bun.which(name) !== null;
}
