import { basename } from "node:path";

/**
 * What a Codex process is, from its command line alone: the ChatGPT app's or a shared app-server, a headless run, or
 * the interactive CLI. Shared by the hook (codex-hook.ts), which drops what a desktop or headless ancestor reports, and
 * the thread reader (codex-threads.ts), which lists a session from the moment its own process holds its thread.
 */

export function isCodexDesktopProcess(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  const executable = basename(argv[0] ?? "").toLowerCase();
  return /Codex\.app(?:\/|$)/i.test(argv[0] ?? "")
    || executable === "app-server"
    || (executable === "codex" && argv[1]?.toLowerCase() === "app-server");
}

const CODEX_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "--config",
  "-C",
  "--cd",
  "--disable",
  "--enable",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
]);

export function codexCliArgumentOffset(argv: string[]): number | null {
  const executable = basename(argv[0] ?? "").toLowerCase();
  if (executable === "codex") return 1;
  if (
    (executable === "node" || executable === "bun")
    && basename(argv[1] ?? "").toLowerCase() === "codex.js"
  ) {
    return 2;
  }
  return null;
}

/**
 * Headless Codex commands must never announce or open conch's microphone.
 * Only inspect the command-position argument: option values, paths, and prompt
 * text containing "exec" or "review" are not subcommands.
 */
export function isCodexHeadlessProcess(command: string): boolean {
  const argv = command.trim().split(/\s+/);
  const offset = codexCliArgumentOffset(argv);
  if (offset == null) return false;

  for (let index = offset; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    const optionName = argument.split("=", 1)[0] ?? argument;
    if (argument === "--") return false;
    if (CODEX_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
      if (!argument.includes("=")) index++;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument.toLowerCase() === "exec"
      || argument.toLowerCase() === "review";
  }
  return false;
}
