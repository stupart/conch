import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Config } from "./config.ts";

const REVIEW_INSTRUCTIONS_BEGIN = "<!-- conch:begin -->";
const REVIEW_INSTRUCTIONS_END = "<!-- conch:end -->";
const REVIEW_INSTRUCTIONS_PATTERN =
  /<!-- conch:begin -->[\s\S]*?<!-- conch:end -->(?:\r?\n)?/g;

export type HookKind = "claude" | "codex";

export interface HookRemovalResult {
  settings: Record<string, unknown>;
  changed: boolean;
  removedHooks: number;
  removedByEvent: Record<string, number>;
}

export interface ManagedBlockRemovalResult {
  content: string;
  changed: boolean;
  removedBlocks: number;
}

export interface UninstallSelection {
  models: boolean;
  /**
   * Which agent's wiring to remove. Undefined means all of it.
   *
   * Scoping exists because an integration can rot while the rest is healthy.
   * Codex 0.144.1 does not execute ~/.codex/hooks.json at all — proven with a
   * bare `touch` hook that never ran — so conch's Stop hook never fires and no
   * Codex session ever registers. Meanwhile AGENTS.md still instructs Codex to
   * end deliverables with `conch:review …`, so it dutifully emits a line into
   * a void. Advertising a capability that does nothing is worse than having
   * none: the agent spends turns on it and the user reads a directive that
   * will never be honoured. `--codex` removes that side without disturbing
   * Claude Code, which works.
   */
  only?: HookKind;
}

export interface UninstallPaths {
  claudeSettings: string;
  claudeInstructions: string;
  codexHooks: string;
  codexInstructions: string;
  servicePlist: string;
  modelsDir: string;
}

export type TmuxRemovalResult = "removed" | "absent" | "unavailable";

export interface UninstallIntegrations {
  serviceOff: (cfg: Config) => Promise<void>;
  stopTmux: () => TmuxRemovalResult | Promise<TmuxRemovalResult>;
  pluginOff: () => boolean | Promise<boolean>;
}

export interface RunUninstallOptions extends UninstallSelection {
  paths?: Partial<UninstallPaths>;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface UninstallSummary {
  ok: boolean;
  claudeHooks: number;
  codexHooks: number;
  claudeInstructionBlocks: number;
  codexInstructionBlocks: number;
  serviceRemoved: boolean;
  tmux: TmuxRemovalResult;
  pluginOk: boolean;
  modelsRemovedBytes: number;
  failures: string[];
}

interface HookFileRemoval {
  path: string;
  existed: boolean;
  removedHooks: number;
  removedByEvent: Record<string, number>;
}

interface InstructionsFileRemoval {
  path: string;
  existed: boolean;
  removedBlocks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split the deliberately small shell command shape emitted by install.ts.
 * Returning null for shell metacharacters is intentional: uninstall should
 * leave a command alone unless it can prove that Conch created it.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const character of command.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (/[;&|<>`]/.test(character)) return null;
    word += character;
    started = true;
  }

  if (quote || escaped) return null;
  if (started) words.push(word);
  return words;
}

function isConchSourceCli(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.endsWith("/src/cli.ts")) return false;
  return normalized
    .split("/")
    .some((part) => part === "conch" || part.startsWith("conch-"));
}

/** Match only the two command shapes written by conch install. */
export function isConchHookCommand(
  command: unknown,
  kind: HookKind,
): boolean {
  if (typeof command !== "string") return false;
  const words = shellWords(command);
  if (!words) return false;
  const action = kind === "claude" ? "hook" : "codex-hook";

  if (words.length === 2) {
    return basename(words[0]!) === "conch" && words[1] === action;
  }
  if (words.length === 3) {
    return basename(words[0]!).startsWith("bun")
      && isConchSourceCli(words[1]!)
      && words[2] === action;
  }
  return false;
}

/**
 * Remove Conch command hooks without mutating the input. A hook entry may hold
 * several commands, so remove only owned commands and retain the entry when an
 * unrelated command remains.
 */
export function removeConchHooks(
  existing: Record<string, unknown>,
  kind: HookKind,
): HookRemovalResult {
  const settings = structuredClone(existing);
  if (!isRecord(settings.hooks)) {
    return {
      settings,
      changed: false,
      removedHooks: 0,
      removedByEvent: {},
    };
  }

  const hooks = settings.hooks;
  const removedByEvent: Record<string, number> = {};
  let removedHooks = 0;

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const keptEntries: unknown[] = [];
    let eventRemoved = 0;

    for (const entry of value) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        keptEntries.push(entry);
        continue;
      }

      const keptCommands = entry.hooks.filter((hook) => {
        const owned = isRecord(hook)
          && hook.type === "command"
          && isConchHookCommand(hook.command, kind);
        if (owned) eventRemoved += 1;
        return !owned;
      });
      if (keptCommands.length > 0) {
        keptEntries.push({ ...entry, hooks: keptCommands });
      }
    }

    if (eventRemoved === 0) continue;
    removedByEvent[event] = eventRemoved;
    removedHooks += eventRemoved;
    if (keptEntries.length > 0) hooks[event] = keptEntries;
    else delete hooks[event];
  }

  if (removedHooks > 0 && Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
  return {
    settings,
    changed: removedHooks > 0,
    removedHooks,
    removedByEvent,
  };
}

/** Remove every complete Conch-managed instruction block, and nothing else. */
export function removeManagedInstructionBlocks(
  existing: string,
): ManagedBlockRemovalResult {
  const beginCount = existing.split(REVIEW_INSTRUCTIONS_BEGIN).length - 1;
  const endCount = existing.split(REVIEW_INSTRUCTIONS_END).length - 1;
  const matches = [
    ...existing.matchAll(
      /<!-- conch:begin -->[\s\S]*?<!-- conch:end -->/g,
    ),
  ];
  if (beginCount !== matches.length || endCount !== matches.length) {
    throw new Error("managed conch markers are incomplete or out of order");
  }

  return {
    content: existing.replace(REVIEW_INSTRUCTIONS_PATTERN, ""),
    changed: matches.length > 0,
    removedBlocks: matches.length,
  };
}

/** Parse the one destructive opt-in separately so unknown flags fail closed. */
export function parseUninstallArgs(args: readonly string[]): UninstallSelection {
  const known = new Set(["--models", "--codex", "--claude"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) {
    throw new Error(
      `unknown uninstall option: ${unknown}\nusage: conch uninstall [--models] [--codex | --claude]`,
    );
  }
  if (args.includes("--codex") && args.includes("--claude")) {
    throw new Error("choose one of --codex or --claude, or neither to remove both");
  }
  const only = args.includes("--codex")
    ? "codex" as const
    : args.includes("--claude")
      ? "claude" as const
      : undefined;
  if (only && args.includes("--models")) {
    // The models are shared by both agents and by the terminal loop. Deleting
    // 1.6 GB while scoping to one agent would be a surprise, not a shortcut.
    throw new Error("--models removes shared speech models; run it without --codex/--claude");
  }
  return { models: args.includes("--models"), ...(only ? { only } : {}) };
}

export function defaultUninstallPaths(
  cfg: Pick<Config, "claudeDir">,
  home = homedir(),
): UninstallPaths {
  return {
    claudeSettings: join(cfg.claudeDir, "settings.json"),
    claudeInstructions: join(cfg.claudeDir, "CLAUDE.md"),
    codexHooks: join(home, ".codex", "hooks.json"),
    codexInstructions: join(home, ".codex", "AGENTS.md"),
    servicePlist: join(
      home,
      "Library/LaunchAgents/com.conch.daemon.plist",
    ),
    modelsDir: join(home, ".cache", "conch", "models"),
  };
}

export async function removeHooksFile(
  path: string,
  kind: HookKind,
): Promise<HookFileRemoval> {
  if (!existsSync(path)) {
    return { path, existed: false, removedHooks: 0, removedByEvent: {} };
  }

  const parsed: unknown = await Bun.file(path).json();
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const result = removeConchHooks(parsed, kind);
  if (result.changed) {
    await Bun.write(path, `${JSON.stringify(result.settings, null, 2)}\n`);
  }
  return {
    path,
    existed: true,
    removedHooks: result.removedHooks,
    removedByEvent: result.removedByEvent,
  };
}

export async function removeInstructionsFile(
  path: string,
): Promise<InstructionsFileRemoval> {
  if (!existsSync(path)) {
    return { path, existed: false, removedBlocks: 0 };
  }
  const result = removeManagedInstructionBlocks(await Bun.file(path).text());
  if (result.changed) await Bun.write(path, result.content);
  return { path, existed: true, removedBlocks: result.removedBlocks };
}

/** Calculate size without following symlinks out of the managed model tree. */
export function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.isSymbolicLink() ? 0 : stat.size;

  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += directorySize(child);
    else if (!entry.isSymbolicLink()) bytes += lstatSync(child).size;
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

async function defaultServiceOff(cfg: Config): Promise<void> {
  const { runService } = await import("./install.ts");
  await runService(cfg, "off");
}

function defaultStopTmux(): TmuxRemovalResult {
  const tmux = Bun.which("tmux");
  if (!tmux) return "unavailable";
  const present = Bun.spawnSync([tmux, "has-session", "-t", "conch"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (present.exitCode !== 0) return "absent";

  const stopped = Bun.spawnSync([tmux, "kill-session", "-t", "conch"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stopped.exitCode !== 0) {
    const detail = stopped.stderr.toString().trim();
    throw new Error(`tmux kill-session failed${detail ? `: ${detail}` : ""}`);
  }
  return "removed";
}

async function defaultPluginOff(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const { runUninstallPlugin } = await import("./plugin-install.ts");
  return runUninstallPlugin(env);
}

function mergePaths(
  cfg: Pick<Config, "claudeDir">,
  overrides: Partial<UninstallPaths> | undefined,
): UninstallPaths {
  const defaults = defaultUninstallPaths(cfg);
  return { ...defaults, ...overrides };
}

function eventSummary(removedByEvent: Record<string, number>): string {
  return Object.entries(removedByEvent)
    .map(([event, count]) => `${event} (${count})`)
    .join(", ");
}

/**
 * Invert every managed part of setup. Files and integrations are independent:
 * one malformed user file is reported and left untouched without preventing
 * cleanup of the service, tmux session, plugin, or the other app's files.
 */
export async function runUninstall(
  cfg: Config,
  options: RunUninstallOptions = { models: false },
  integrations: Partial<UninstallIntegrations> = {},
): Promise<UninstallSummary> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const paths = mergePaths(cfg, options.paths);
  const env = options.env ?? process.env;
  const failures: string[] = [];
  let claudeHooks = 0;
  let codexHooks = 0;
  let claudeInstructionBlocks = 0;
  let codexInstructionBlocks = 0;
  let serviceRemoved = false;
  let tmux: TmuxRemovalResult = "absent";
  let pluginOk = false;
  let modelsRemovedBytes = 0;

  const hookFiles: ReadonlyArray<readonly [string, HookKind, string]> = [
    [paths.claudeSettings, "claude", "Claude Code hooks"],
    [paths.codexHooks, "codex", "Codex hooks"],
  ];
  for (const [path, kind, label] of hookFiles) {
    if (options.only && options.only !== kind) continue;
    try {
      const result = await removeHooksFile(path, kind);
      if (kind === "claude") claudeHooks = result.removedHooks;
      else codexHooks = result.removedHooks;
      if (result.removedHooks > 0) {
        log(
          `${label}: removed ${result.removedHooks} Conch command${result.removedHooks === 1 ? "" : "s"} (${eventSummary(result.removedByEvent)}) — ${path}`,
        );
      } else {
        log(`${label}: ${result.existed ? "no Conch commands found" : "already absent"} — ${path}`);
      }
    } catch (caught) {
      const message = `${label}: not changed — ${caught instanceof Error ? caught.message : String(caught)}`;
      failures.push(message);
      error(message);
    }
  }

  const instructionFiles: ReadonlyArray<readonly [string, "claude" | "codex", string]> = [
    [paths.claudeInstructions, "claude", "Claude Code instructions"],
    [paths.codexInstructions, "codex", "Codex instructions"],
  ];
  for (const [path, kind, label] of instructionFiles) {
    if (options.only && options.only !== kind) continue;
    try {
      const result = await removeInstructionsFile(path);
      if (kind === "claude") {
        claudeInstructionBlocks = result.removedBlocks;
      } else {
        codexInstructionBlocks = result.removedBlocks;
      }
      if (result.removedBlocks > 0) {
        log(
          `${label}: removed ${result.removedBlocks} managed block${result.removedBlocks === 1 ? "" : "s"} — ${path}`,
        );
      } else {
        log(`${label}: ${result.existed ? "no managed block found" : "already absent"} — ${path}`);
      }
    } catch (caught) {
      const message = `${label}: not changed — ${caught instanceof Error ? caught.message : String(caught)}`;
      failures.push(message);
      error(message);
    }
  }

  // Everything past this point is SHARED — the launchd service, the tmux
  // session, the speech models. An agent scope must not reach any of it.
  //
  // It did, once, on Tyler's machine: `conch uninstall --codex` removed the
  // Codex hooks as asked and then went on to delete the launch agent and kill
  // the daemon, because the scope only guarded the two loops above. A flag
  // named for one integration took the whole thing down. The guard belongs
  // here, at the boundary between per-agent wiring and the install itself.
  if (options.only) {
    log(`Left alone: the background service, the tmux session, and the speech models are shared.`);
    return {
      ok: failures.length === 0,
      claudeHooks,
      codexHooks,
      claudeInstructionBlocks,
      codexInstructionBlocks,
      serviceRemoved: false,
      tmux: "absent",
      pluginOk: true,
      modelsRemovedBytes: 0,
      failures,
    };
  }

  const serviceWasPresent = existsSync(paths.servicePlist);
  try {
    await (integrations.serviceOff ?? defaultServiceOff)(cfg);
    const serviceStillPresent = existsSync(paths.servicePlist);
    serviceRemoved = serviceWasPresent && !serviceStillPresent;
    if (serviceStillPresent) {
      throw new Error(`launch agent still exists at ${paths.servicePlist}`);
    }
    log(
      serviceRemoved
        ? `Background service: removed — ${paths.servicePlist}`
        : `Background service: already absent — ${paths.servicePlist}`,
    );
  } catch (caught) {
    const message = `Background service: removal failed — ${caught instanceof Error ? caught.message : String(caught)}`;
    failures.push(message);
    error(message);
  }

  try {
    tmux = await (integrations.stopTmux ?? defaultStopTmux)();
    if (tmux === "removed") log("tmux session: stopped — conch");
    else if (tmux === "absent") log("tmux session: already absent — conch");
    else {
      const message = "tmux session: could not check — tmux is not installed";
      failures.push(message);
      error(message);
    }
  } catch (caught) {
    const message = `tmux session: removal failed — ${caught instanceof Error ? caught.message : String(caught)}`;
    failures.push(message);
    error(message);
    tmux = "unavailable";
  }

  try {
    pluginOk = await (integrations.pluginOff
      ?? (() => defaultPluginOff(env)))();
    if (pluginOk) log("Plugin cleanup: complete");
    else {
      const message = "Plugin cleanup: one or more app removals failed";
      failures.push(message);
      error(message);
    }
  } catch (caught) {
    const message = `Plugin cleanup: failed — ${caught instanceof Error ? caught.message : String(caught)}`;
    failures.push(message);
    error(message);
  }

  try {
    const modelPath = resolve(paths.modelsDir);
    if (!existsSync(modelPath)) {
      log(`Speech models: already absent — ${modelPath}`);
    } else {
      const bytes = directorySize(modelPath);
      if (options.models) {
        rmSync(modelPath, { recursive: true, force: true });
        modelsRemovedBytes = bytes;
        log(`Speech models: removed ${formatBytes(bytes)} — ${modelPath}`);
      } else {
        log(`Speech models: kept ${formatBytes(bytes)} — ${modelPath}`);
        log("To remove them too: conch uninstall --models");
      }
    }
  } catch (caught) {
    const message = `Speech models: removal failed — ${caught instanceof Error ? caught.message : String(caught)}`;
    failures.push(message);
    error(message);
  }

  return {
    ok: failures.length === 0,
    claudeHooks,
    codexHooks,
    claudeInstructionBlocks,
    codexInstructionBlocks,
    serviceRemoved,
    tmux,
    pluginOk,
    modelsRemovedBytes,
    failures,
  };
}
