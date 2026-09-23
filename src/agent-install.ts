import { readdirSync } from "node:fs";
import { isNewer } from "./version-check.ts";

/**
 * Surface which Claude Code / Codex binary a session is actually running,
 * where it came from, and whether another copy on this Mac is newer.
 *
 * SURFACE and ADVISE only (see the mac 2026-09-23 measurement: 6 sessions on
 * a Caskroom `claude` 14 versions behind the 2 running the desktop app's
 * bundled copy — `brew outdated` sees neither, since both casks self-update).
 * conch never runs an upgrade itself: swapping the binary underneath a
 * running voice loop mid-session is not something to do to someone
 * automatically (see version-check.ts's own reasoning). It only tells you,
 * once asked, and hands you the exact command for THIS install.
 */

export type InstallLocationKind = "homebrew-cask" | "npm-global" | "claude-desktop-app" | "other";

export interface InstallLocation {
  kind: InstallLocationKind;
  /** Homebrew cask token or npm package name; absent for desktop-app/other. */
  packageId?: string;
}

export interface AgentInstall {
  backend: "claude" | "codex";
  /** The exact binary this session's process is running (proc_pidpath, not a guess). */
  executable: string;
  /** From `<executable> --version`; null when it could not be read. */
  version: string | null;
  location: InstallLocationKind;
  packageId?: string;
  /** What would update THIS install, derived from where it lives; null when conch has no safe command to give. */
  updateCommand: string | null;
  /** An older version than another copy of the SAME agent running on this Mac right now. Local comparison only, never guessed when either version is unknown. */
  behind: boolean;
  /** The newer version found among this Mac's other live copies, when behind. */
  newerVersion?: string;
  /** The newer version is already installed where this one came from: restarting the session is the whole update. */
  restartToUpdate?: boolean;
}

const CASKROOM_RE = /\/Caskroom\/([^/]+)\//;
/**
 * A cask's version directory, with the `.upgrading` suffix brew gives the old
 * one while it installs the new one and then deletes it. A session started
 * before a `brew upgrade` keeps running from that deleted path, so
 * `--version` on it fails. Measured 2026-09-23: both live Codex sessions ran
 * `Caskroom/codex/0.155.1.upgrading/bin/codex` and `0.154.0.upgrading`, gone
 * from disk, with 0.156.0 installed.
 */
const CASKROOM_VERSION_RE = /\/Caskroom\/[^/]+\/(\d+\.\d+\.\d+)(?:\.upgrading)?\//;

/** The newest version of this binary's cask installed right now, from its Caskroom directory names. */
function installedCaskVersion(executable: string): string | null {
  const root = /^(.*\/Caskroom\/[^/]+)\//.exec(executable)?.[1];
  if (!root) return null;
  try {
    return readdirSync(root)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .reduce<string | null>((newest, name) => (!newest || isNewer(name, newest) ? name : newest), null);
  } catch {
    return null;
  }
}
const APP_BUNDLE_RE = /\.app\/Contents\/MacOS\//;
const NPM_MODULE_RE = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/**
 * Where a binary came from, from its path alone. Order matters: a Caskroom
 * path is the most specific signal (it names exactly what `brew` would
 * upgrade), so it is checked before the more general `.app` bundle pattern —
 * a cask that happens to install a `.app` must still read as the cask.
 */
export function describeInstallLocation(executable: string): InstallLocation {
  const cask = CASKROOM_RE.exec(executable);
  if (cask) return { kind: "homebrew-cask", packageId: cask[1] };
  if (APP_BUNDLE_RE.test(executable)) return { kind: "claude-desktop-app" };
  const npm = NPM_MODULE_RE.exec(executable);
  if (npm) return { kind: "npm-global", packageId: npm[1] };
  return { kind: "other" };
}

/**
 * The command that would update THIS install — never run, only shown.
 *
 * `null` for a desktop app bundle (it updates with the app, no command to
 * give) and for "other": guessing wrong here is worse than saying nothing,
 * the same call version-check.ts makes about a source checkout.
 */
export function installUpdateCommand(location: InstallLocation): string | null {
  if (location.kind === "homebrew-cask" && location.packageId) {
    return `brew upgrade --cask --greedy ${location.packageId}`;
  }
  if (location.kind === "npm-global" && location.packageId) {
    return `npm i -g ${location.packageId}`;
  }
  return null;
}

/** Pulls `x.y.z` out of free-form `--version` output ("2.1.266 (Claude Code)", "codex-cli 0.5.2"). */
export function extractVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Runs `<executable> --version`, bounded, and never throws. */
export async function readInstalledVersion(executable: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const proc = Bun.spawn([executable, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const timedOut = Symbol("timeout");
    const result = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => timedOut)]);
    if (result === timedOut) {
      controller.abort();
      return null;
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return extractVersion(stdout) ?? extractVersion(stderr);
  } catch {
    return null;
  }
}

export type AgentInstallVersionReader = (executable: string) => Promise<string | null>;

/**
 * Resolve one session's install, and whether it is behind any other live
 * copy of the SAME agent on this Mac right now.
 *
 * Local and synchronous-in-spirit: every candidate is a session already
 * running on this Mac, read from conch's own process identities. No registry
 * or network lookup.
 *
 * ponytail: purely local comparison, no "latest published version" check —
 * add a registry lookup only if two sessions of the same agent never
 * disagreeing turns out to hide real staleness (the way it did for conch
 * itself, which is why version-check.ts exists).
 *
 * `cache` is shared across calls (the daemon holds one for its lifetime) so
 * the same executable is never re-spawned for `--version` on every poll —
 * only once, ever, per distinct binary path.
 */
export async function resolveAgentInstall(
  target: { backend: "claude" | "codex"; executable: string },
  peers: readonly { backend: "claude" | "codex"; executable: string }[],
  cache: Map<string, string | null>,
  readVersion: AgentInstallVersionReader = readInstalledVersion,
): Promise<AgentInstall> {
  const sameAgentExecutables = new Set(
    peers.filter((peer) => peer.backend === target.backend).map((peer) => peer.executable),
  );
  sameAgentExecutables.add(target.executable);
  await Promise.all(
    [...sameAgentExecutables]
      .filter((executable) => !cache.has(executable))
      .map(async (executable) => cache.set(
        executable,
        (await readVersion(executable)) ?? CASKROOM_VERSION_RE.exec(executable)?.[1] ?? null,
      )),
  );

  const location = describeInstallLocation(target.executable);
  const version = cache.get(target.executable) ?? null;
  let newerVersion: string | undefined;
  if (version) {
    for (const executable of sameAgentExecutables) {
      if (executable === target.executable) continue;
      const peerVersion = cache.get(executable);
      if (peerVersion && isNewer(peerVersion, version) && (!newerVersion || isNewer(peerVersion, newerVersion))) {
        newerVersion = peerVersion;
      }
    }
  }
  // Newer on disk than what this session runs: `brew upgrade` already happened.
  const installed = version ? installedCaskVersion(target.executable) : null;
  const restartToUpdate = installed !== null && isNewer(installed, version!);
  if (restartToUpdate && (!newerVersion || isNewer(installed, newerVersion))) newerVersion = installed;

  return {
    backend: target.backend,
    executable: target.executable,
    version,
    location: location.kind,
    ...(location.packageId ? { packageId: location.packageId } : {}),
    updateCommand: installUpdateCommand(location),
    behind: newerVersion !== undefined,
    ...(newerVersion ? { newerVersion } : {}),
    ...(restartToUpdate ? { restartToUpdate } : {}),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const INSTALL_LOCATION_KINDS = new Set<InstallLocationKind>([
  "homebrew-cask", "npm-global", "claude-desktop-app", "other",
]);

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Strict-enough wire guard, the same shape as `isAgentCapabilitiesRead`. */
export function isAgentInstall(value: unknown): value is AgentInstall {
  return record(value)
    && (value.backend === "claude" || value.backend === "codex")
    && boundedString(value.executable, 8_192)
    && (value.version === null || boundedString(value.version, 64))
    && typeof value.location === "string"
    && INSTALL_LOCATION_KINDS.has(value.location as InstallLocationKind)
    && (value.packageId === undefined || boundedString(value.packageId, 512))
    && (value.updateCommand === null || boundedString(value.updateCommand, 1_024))
    && typeof value.behind === "boolean"
    && (value.newerVersion === undefined || boundedString(value.newerVersion, 64))
    && (value.restartToUpdate === undefined || typeof value.restartToUpdate === "boolean");
}
