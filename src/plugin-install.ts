import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface PluginCommands {
  claude: string[][];
  codex: string[][];
}

export interface MaterializePluginOptions {
  templateDir: string;
  prosePath: string;
  distDir: string;
  absBun: string;
  absCli: string;
}

type CommandMode = "install" | "uninstall";
type CommandStatus =
  | "registered"
  | "already-present"
  | "removed"
  | "already-absent"
  | "not-found"
  | "failed";

interface CommandOutcome {
  status: CommandStatus;
  command: string[];
  detail?: string;
}

interface SequenceOutcome {
  ok: boolean;
}

interface SmokeResult {
  ok: boolean;
  error?: string;
}

const SKILL_FRONTMATTER = `---
name: conch-control
description: Control conch — see and steer your other sessions by voice.
---

`;

const ALREADY_PRESENT =
  /\balready(?:[\s_-]+been)?[\s_-]+(?:exists?|installed|added|present|configured|registered)\b|\bduplicate(?:[\s_-]+(?:plugin|marketplace|entry|registration))?\b/i;
const ALREADY_ABSENT =
  /\bnot[\s_-]+(?:found|installed|present|configured|registered)\b|\bdoes[\s_-]+not[\s_-]+exist\b|\bunknown[\s_-]+(?:plugin|marketplace)\b|\bno[\s_-]+(?:installed[\s_-]+)?(?:plugin|marketplace)\b|\balready(?:[\s_-]+been)?[\s_-]+(?:removed|uninstalled|absent)\b/i;

export function buildMcpJson(absBun: string, absCli: string) {
  return {
    mcpServers: {
      conch: {
        command: absBun,
        args: ["run", absCli, "mcp"],
      },
    },
  };
}

export function buildInstallCommands(dist: string): PluginCommands {
  return {
    claude: [
      ["claude", "plugin", "marketplace", "add", dist],
      ["claude", "plugin", "install", "conch@conch"],
    ],
    codex: [
      ["codex", "plugin", "marketplace", "add", dist],
      ["codex", "plugin", "add", "conch@conch-local"],
    ],
  };
}

export function buildUninstallCommands(): PluginCommands {
  return {
    claude: [
      ["claude", "plugin", "uninstall", "conch@conch"],
      ["claude", "plugin", "marketplace", "remove", "conch"],
    ],
    codex: [
      ["codex", "plugin", "remove", "conch@conch-local"],
      ["codex", "plugin", "marketplace", "remove", "conch-local"],
    ],
  };
}

export function pluginDistDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configDir = env.CONCH_CONFIG_DIR ?? join(homedir(), ".config", "conch");
  return resolve(configDir, "plugin-dist");
}

/**
 * Copy the checked-in template through a staging directory so every rerun
 * replaces stale plugin files as one managed unit.
 */
export async function materializePlugin(
  options: MaterializePluginOptions,
): Promise<void> {
  const { templateDir, prosePath, distDir, absBun, absCli } = options;
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    throw new Error(`plugin template not found at ${templateDir}`);
  }
  if (!existsSync(prosePath)) {
    throw new Error(`conch control prose not found at ${prosePath}`);
  }

  const parentDir = dirname(distDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(join(parentDir, ".plugin-dist-"));
  let committed = false;
  try {
    cpSync(templateDir, stagingDir, { recursive: true });
    const prose = await Bun.file(prosePath).text();
    const pluginRoot = join(stagingDir, "plugins", "conch");

    await Bun.write(
      join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(buildMcpJson(absBun, absCli), null, 2)}\n`,
    );
    await Bun.write(join(pluginRoot, "AGENTS.md"), prose);
    await Bun.write(
      join(pluginRoot, "skills", "conch-control", "SKILL.md"),
      `${SKILL_FRONTMATTER}${prose}`,
    );

    rmSync(distDir, { recursive: true, force: true });
    renameSync(stagingDir, distDir);
    committed = true;
  } finally {
    if (!committed) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function conciseOutput(stdout: string, stderr: string): string {
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return combined.at(-1) ?? "";
}

async function runCommand(
  command: string[],
  mode: CommandMode,
): Promise<CommandOutcome> {
  let proc: Bun.ReadableSubprocess;
  try {
    proc = Bun.spawn(command, {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "not-found", command };
    }
    return {
      status: "failed",
      command,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  const already = mode === "install"
    ? ALREADY_PRESENT.test(output)
    : ALREADY_ABSENT.test(output);

  if (exitCode === 0 || already) {
    return {
      status: already
        ? mode === "install" ? "already-present" : "already-absent"
        : mode === "install" ? "registered" : "removed",
      command,
    };
  }

  return {
    status: "failed",
    command,
    detail: `exit ${exitCode}${conciseOutput(stdout, stderr)
      ? `: ${conciseOutput(stdout, stderr)}`
      : ""}`,
  };
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command: string[]): string {
  return command.map(quoteArg).join(" ");
}

function printOutcome(label: string, outcome: CommandOutcome): void {
  const command = formatCommand(outcome.command);
  if (outcome.status === "not-found") {
    console.log(
      `${label}: not-found — ${outcome.command[0]} not found, skipped (${command})`,
    );
    return;
  }
  if (outcome.status === "failed") {
    console.error(
      `${label}: failed — ${command}${outcome.detail ? ` (${outcome.detail})` : ""}`,
    );
    return;
  }
  console.log(`${label}: ${outcome.status} — ${command}`);
}

async function runSequence(
  label: string,
  commands: string[][],
  mode: CommandMode,
): Promise<SequenceOutcome> {
  for (const command of commands) {
    const outcome = await runCommand(command, mode);
    printOutcome(label, outcome);
    if (outcome.status === "not-found") {
      return { ok: true };
    }
    if (outcome.status === "failed") {
      return { ok: false };
    }
  }
  return { ok: true };
}

function refreshFailed(label: string, outcome: CommandOutcome): void {
  console.error(
    `${label}: failed — ${formatCommand(outcome.command)} (still already-present after refresh)`,
  );
}

/**
 * Local marketplaces and installed plugins can both be cached. If either add
 * reports an existing registration, remove the stale cache and replay the
 * requested add/install commands against the freshly materialized dist.
 */
async function runInstallSequence(
  label: string,
  installCommands: string[][],
  uninstallCommands: string[][],
): Promise<SequenceOutcome> {
  const [marketplaceAdd, pluginAdd] = installCommands;
  const [pluginRemove, marketplaceRemove] = uninstallCommands;
  if (!marketplaceAdd || !pluginAdd || !pluginRemove || !marketplaceRemove) {
    throw new Error(`incomplete plugin command sequence for ${label}`);
  }

  let marketplace = await runCommand(marketplaceAdd, "install");
  printOutcome(label, marketplace);
  if (marketplace.status === "not-found") return { ok: true };
  if (marketplace.status === "failed") return { ok: false };

  if (marketplace.status === "already-present") {
    for (const command of [pluginRemove, marketplaceRemove]) {
      const removal = await runCommand(command, "uninstall");
      printOutcome(label, removal);
      if (removal.status === "not-found") return { ok: true };
      if (removal.status === "failed") return { ok: false };
    }

    marketplace = await runCommand(marketplaceAdd, "install");
    printOutcome(label, marketplace);
    if (marketplace.status === "not-found") return { ok: true };
    if (marketplace.status === "failed") return { ok: false };
    if (marketplace.status === "already-present") {
      refreshFailed(label, marketplace);
      return { ok: false };
    }
  }

  let plugin = await runCommand(pluginAdd, "install");
  printOutcome(label, plugin);
  if (plugin.status === "not-found") return { ok: true };
  if (plugin.status === "failed") return { ok: false };

  if (plugin.status === "already-present") {
    const removal = await runCommand(pluginRemove, "uninstall");
    printOutcome(label, removal);
    if (removal.status === "not-found") return { ok: true };
    if (removal.status === "failed") return { ok: false };

    plugin = await runCommand(pluginAdd, "install");
    printOutcome(label, plugin);
    if (plugin.status === "not-found") return { ok: true };
    if (plugin.status === "failed") return { ok: false };
    if (plugin.status === "already-present") {
      refreshFailed(label, plugin);
      return { ok: false };
    }
  }

  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResultLine(line: string, id: number): Record<string, unknown> {
  const message: unknown = JSON.parse(line);
  if (
    !isRecord(message)
    || message.jsonrpc !== "2.0"
    || message.id !== id
    || !isRecord(message.result)
  ) {
    throw new Error(`invalid JSON-RPC result for request ${id}`);
  }
  return message.result;
}

function responseLineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readLine = async (timeoutMs: number): Promise<string> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        return line;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer) {
          const line = buffer.replace(/\r$/, "");
          buffer = "";
          return line;
        }
        throw new Error("MCP server closed stdout before replying");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  return {
    readLine,
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

async function stopProcess(proc: Bun.PipedSubprocess): Promise<void> {
  try {
    proc.stdin.end();
  } catch {}
  try {
    proc.kill();
  } catch {}

  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!exited) {
    try {
      proc.kill(9);
    } catch {}
    await proc.exited.catch(() => undefined);
  }
}

async function smokeTest(absBun: string, absCli: string): Promise<SmokeResult> {
  let proc: Bun.PipedSubprocess;
  try {
    proc = Bun.spawn([absBun, "run", absCli, "mcp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = responseLineReader(proc.stdout);
  const stderrPromise = new Response(proc.stderr).text();
  let error: string | undefined;
  try {
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "conch-install", version: "0" },
        },
      })}\n`,
    );
    await proc.stdin.flush();
    parseResultLine(await lines.readLine(5_000), 1);

    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })}\n`,
    );
    await proc.stdin.flush();
    const result = parseResultLine(await lines.readLine(5_000), 2);
    if (!Array.isArray(result.tools) || result.tools.length !== 8) {
      throw new Error(
        `tools/list returned ${Array.isArray(result.tools) ? result.tools.length : "no"} tools; expected 8`,
      );
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await stopProcess(proc);
    await lines.cancel();
  }

  const stderr = (await stderrPromise).trim();
  if (error) {
    return { ok: false, error: stderr ? `${error}; ${stderr}` : error };
  }
  return { ok: true };
}

export async function runInstallPlugin(
  absBun: string,
  absCli: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const repoRoot = dirname(dirname(absCli));
  const distDir = pluginDistDir(env);
  await materializePlugin({
    templateDir: join(repoRoot, "plugin"),
    prosePath: join(repoRoot, "docs", "conch-control-skill.md"),
    distDir,
    absBun,
    absCli,
  });
  console.log(`Plugin dist: materialized — ${distDir}`);

  const commands = buildInstallCommands(distDir);
  const uninstallCommands = buildUninstallCommands();
  const claude = await runInstallSequence(
    "Claude Code",
    commands.claude,
    uninstallCommands.claude,
  );
  const codex = await runInstallSequence(
    "Codex",
    commands.codex,
    uninstallCommands.codex,
  );

  const smoke = await smokeTest(absBun, absCli);
  if (smoke.ok) {
    console.log("MCP smoke test: passed — 8 tools");
  } else {
    console.error(
      `⚠️  WARNING: MCP smoke test failed — ${smoke.error ?? "unknown error"}`,
    );
    console.error(
      `Check: ${formatCommand([absBun, "run", absCli, "mcp"])}`,
    );
  }

  console.log(
    "Start a NEW Claude Code / Codex session — the conch-control skill and conch_* tools are now available.",
  );
  return claude.ok && codex.ok;
}

export async function runUninstallPlugin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const commands = buildUninstallCommands();
  const claude = await runSequence("Claude Code", commands.claude, "uninstall");
  const codex = await runSequence("Codex", commands.codex, "uninstall");
  const distDir = pluginDistDir(env);

  if (claude.ok && codex.ok) {
    if (existsSync(distDir)) {
      rmSync(distDir, { recursive: true, force: true });
      console.log(`Plugin dist: removed — ${distDir}`);
    } else {
      console.log(`Plugin dist: already-absent — ${distDir}`);
    }
  } else if (existsSync(distDir)) {
    console.log(`Plugin dist: kept — ${distDir}`);
  }

  return claude.ok && codex.ok;
}
