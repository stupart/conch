/**
 * First-run setup's daemon half: what the Mac app's setup window asks the daemon, over the control socket.
 *
 *   setup-status               each agent: found, its version and where it came from, hooks and plugin, signed in, and
 *                              whether conch has heard from it yet
 *   setup-connect {agent}      conch's hooks and plugin into the agent's own settings, backed up first
 *   setup-install {agent, via} the agent's own official installer, its last line streamed as it runs
 *   voice-sample {voice}       one line in a ring voice, through the speech path every turn takes
 *   mic-check                  the microphone's level streamed, then what the warm whisper-server heard
 *   setup-retry {what}         a download that gave up, tried again
 *
 * Nothing here is new machinery. Agents are found as `conch doctor` finds them (`resolveAgentBinaries`), wired as
 * `conch install` and `conch install-plugin` wire them (`runInstall`, `runCodexInstall`, `runInstallPlugin`), and read
 * back with the same shapes (`isConchHookCommand`, `codexHooksAreWiredAt`, `pluginInstalledFor`). The microphone is held
 * through the voice loop's one gate, as Show's narration holds it (`VoiceLoop.holdNarration`), recorded with seashell's
 * sox recipe (`spawnNarrationRecorder`) and transcribed by whisper (`transcribeWavSegments`): never Apple's speech APIs,
 * and never while conch is speaking.
 *
 * A row in setup goes green on the first real hook event from that agent, not on the file write: `noteTurn` hears every
 * hook-shaped event, and the agent it came from is remembered in `setup.json`, beside the time conch wired it.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentBinary } from "./doctor-checks.ts";
import type { TurnEvent } from "./hook.ts";
import type { HooksInstallResult } from "./install.ts";

export type SetupAgent = "claude" | "codex";
export const SETUP_AGENTS: readonly SetupAgent[] = ["claude", "codex"];
export type InstallVia = "native" | "brew" | "npm";

/** What `setup-status` says about one agent. */
export interface AgentSetupReport {
  agent: SetupAgent;
  found: boolean;
  /** The copy conch runs, else the one the person's shell runs, with the home folder as `~`. */
  path: string | null;
  /** Its version number alone ("2.1.280"), read from `--version`. */
  version: string | null;
  /** Where it came from, in words: "Homebrew", "npm", "its own installer"; null when conch can't tell. */
  source: string | null;
  /** conch's hooks are in the agent's own settings. */
  hooksWired: boolean;
  /** conch's plugin is in the agent's own record of its plugins. */
  pluginInstalled: boolean;
  /** Codex's sign-in (`auth.json`); null for Claude Code, which says so on its first hook event instead. */
  signedIn: boolean | null;
  /** conch has had a real hook event from it: the row's green. */
  heard: boolean;
  /** Sessions that were open before conch wired it, and have not been heard from: each needs `/hooks` once. */
  openBeforeHooks: number;
  /** Two installs that disagree: what conch runs and what the shell runs, each "version  path". */
  copies: { conch: string; shell: string } | null;
}

export type SetupRequest =
  | { kind: "setup-status" }
  | { kind: "setup-connect"; agent: SetupAgent }
  | { kind: "setup-install"; agent: SetupAgent; via?: InstallVia }
  | { kind: "voice-sample"; voice: string }
  | { kind: "mic-check"; seconds?: number }
  | { kind: "setup-retry"; what: "speech" | "voices" };

export type SetupReply =
  | { kind: "setup-status"; agents: AgentSetupReport[] }
  | { kind: "setup-connected"; agent: SetupAgent; changed: string[]; file: string; backup: string | null }
  | { kind: "setup-installed"; agent: SetupAgent }
  | { kind: "voice-sample-done"; voice: string }
  | { kind: "mic-check-done"; heard: string | null; silent: boolean; recognition: "ready" | "waiting"; peak: number }
  | { kind: "setup-ack"; retried: boolean }
  | { kind: "setup-error"; error: string; agent?: SetupAgent; command?: string; reason?: string };

/** A line streamed before the reply: an installer's last words, or the microphone's level. */
export type SetupLine =
  | { kind: "setup-install-line"; agent: SetupAgent; line: string }
  | { kind: "mic-level"; level: number };

const SETUP_KINDS = new Set(["setup-status", "setup-connect", "setup-install", "voice-sample", "mic-check", "setup-retry"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A setup request, a refusal of a malformed one, or null for anything that isn't setup's. */
export function decodeSetupRequest(body: unknown): SetupRequest | { error: string } | null {
  if (!record(body) || typeof body.kind !== "string" || !SETUP_KINDS.has(body.kind)) return null;
  const agent = body.agent === "claude" || body.agent === "codex" ? body.agent : null;
  switch (body.kind) {
    case "setup-status":
      return { kind: "setup-status" };
    case "setup-connect":
      return agent ? { kind: "setup-connect", agent } : { error: "agent must be claude or codex" };
    case "setup-install": {
      if (!agent) return { error: "agent must be claude or codex" };
      if (body.via === undefined) return { kind: "setup-install", agent };
      if (body.via !== "native" && body.via !== "brew" && body.via !== "npm") return { error: "via must be native, brew or npm" };
      if (!INSTALLERS[agent][body.via]) return { error: `${AGENT_NAMES[agent]} has no ${body.via} installer` };
      return { kind: "setup-install", agent, via: body.via };
    }
    case "voice-sample":
      return typeof body.voice === "string" && body.voice.trim() && body.voice.length <= 60
        ? { kind: "voice-sample", voice: body.voice.trim() }
        : { error: "voice must name a voice" };
    case "mic-check": {
      if (body.seconds === undefined) return { kind: "mic-check" };
      return typeof body.seconds === "number" && Number.isFinite(body.seconds) && body.seconds > 0
        ? { kind: "mic-check", seconds: Math.min(body.seconds, MIC_CHECK_MAX_SECONDS) }
        : { error: "seconds must be a positive number" };
    }
    case "setup-retry":
      return body.what === "speech" || body.what === "voices" ? { kind: "setup-retry", what: body.what } : { error: "what must be speech or voices" };
  }
  return null;
}

// MARK: - Agents, as found

export const AGENT_NAMES: Record<SetupAgent, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * Each agent's official installer (checked 27 Sep 2026): Claude Code's native installer or its cask; Codex's cask, npm
 * package or install script. Run in a login shell, so Homebrew and npm are on PATH as they are in Terminal.
 */
export const INSTALLERS: Record<SetupAgent, Partial<Record<InstallVia, string>>> = {
  claude: {
    native: "curl -fsSL https://claude.ai/install.sh | bash",
    brew: "brew install --cask claude-code",
  },
  codex: {
    brew: "brew install --cask codex",
    npm: "npm i -g @openai/codex",
    native: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
};

/** The installer setup runs when none is asked for: Claude Code's own, self-updating; Codex's cask, else npm, else its script. */
export function defaultInstallVia(agent: SetupAgent, has: (tool: "brew" | "npm") => boolean): InstallVia {
  if (agent === "claude") return "native";
  if (has("brew")) return "brew";
  if (has("npm")) return "npm";
  return "native";
}

/** "2.1.280" from "2.1.280 (Claude Code)" or "codex-cli 0.156.0". */
export function agentVersion(line: string): string | null {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(line)?.[0] ?? null;
}

/** Where an install came from, by where it lives (followed through its symlink): the words setup's row shows. */
export function agentSource(path: string, home: string, real = path): string | null {
  const places = [real, path];
  if (places.some((p) => /\/(?:Caskroom|Cellar)\//.test(p) || p.startsWith("/opt/homebrew/"))) return "Homebrew";
  if (places.some((p) => /\/node_modules\/|\/\.npm|\/\.nvm\/|\/mise\/|\/\.volta\/|\/\.bun\/|\/\.local\/share\/fnm\//.test(p))) return "npm";
  if (places.some((p) => [".local/bin", ".local/share/claude", ".claude", ".codex"].some((dir) => p.startsWith(join(home, dir) + "/")))) {
    return "its own installer";
  }
  return null;
}

/** A path with the home folder as `~`, as setup shows paths. */
export function tilde(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + "/")) ? `~${path.slice(home.length)}` : path;
}

/** The Claude Code events whose conch hooks make it conch's: a turn finishing, and a prompt starting one. */
export const CLAUDE_CORE_HOOK_EVENTS = ["Stop", "UserPromptSubmit"] as const;

/** conch's hooks in Claude Code's settings, by shape (`isConchHookCommand`), on every core event. Never throws. */
export function claudeHooksWiredAt(claudeDir: string, isConchHook: (command: string | undefined) => boolean): boolean {
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { hooks?: Record<string, unknown> };
    return CLAUDE_CORE_HOOK_EVENTS.every((event) => {
      const entries = settings.hooks?.[event];
      return Array.isArray(entries) && entries.some((entry) =>
        record(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => record(hook) && isConchHook(typeof hook.command === "string" ? hook.command : undefined)));
    });
  } catch {
    return false;
  }
}

// MARK: - What setup remembers

/** `setup.json`: when conch first heard from each agent, and when it wired each (epoch ms). */
export interface SetupMemory {
  heard: Partial<Record<SetupAgent, number>>;
  wiredAt: Partial<Record<SetupAgent, number>>;
}

export function readSetupMemory(path: string): SetupMemory {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SetupMemory>;
    const clean = (value: unknown): Partial<Record<SetupAgent, number>> => {
      const out: Partial<Record<SetupAgent, number>> = {};
      if (!record(value)) return out;
      for (const agent of SETUP_AGENTS) if (typeof value[agent] === "number") out[agent] = value[agent] as number;
      return out;
    };
    return { heard: clean(raw.heard), wiredAt: clean(raw.wiredAt) };
  } catch {
    return { heard: {}, wiredAt: {} };
  }
}

/** Written whole, through a temporary file renamed over the old: a crash leaves the old memory or the new, never half. */
export function writeSetupMemory(path: string, memory: SetupMemory): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(memory) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } catch {}
}

/** The hook events: what Claude Code's and Codex's hooks send. Everything else on the socket comes from conch itself. */
const HOOK_EVENT_TYPES = new Set<TurnEvent["type"]>(["turn-end", "needs-you", "working", "session-start"]);

// MARK: - The microphone check

export const MIC_CHECK_SECONDS = 6;
export const MIC_CHECK_MAX_SECONDS = 10;
/** How long the check waits for conch to finish a line before it gives up and says so. */
export const MIC_CHECK_QUIET_WITHIN_MS = 2_500;
/** A level this high is someone speaking: about -38 dBFS. */
export const MIC_SPEECH_LEVEL = 0.3;
/** Below this at its loudest, the check heard nothing at all: about -44 dBFS. */
export const MIC_SILENT_PEAK = 0.15;
/** Once someone has spoken, this much quiet ends the check early. */
export const MIC_TRAILING_QUIET_MS = 1_000;
/** One level per this much audio: 60 ms, at 16 kHz mono 16-bit. */
const LEVEL_BYTES = 16_000 * 2 * 0.06;

/**
 * A stretch of 16-bit little-endian PCM as a level from 0 to 1: its RMS in dBFS, from -50 (0, a quiet room) to -10
 * (1, speech close to the microphone). What the meter draws and the check decides with.
 */
export function pcmLevel(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 50) / 40));
}

/** Where a WAV's samples start: after its `data` chunk header. Null until the header has been written. */
export function wavDataOffset(head: Uint8Array): number | null {
  for (let i = 12; i + 8 <= head.length; i++) {
    if (head[i] === 0x64 && head[i + 1] === 0x61 && head[i + 2] === 0x74 && head[i + 3] === 0x61) return i + 8;
  }
  return null;
}

/** The microphone check's words for a refused hold (`VoiceLoop.holdNarration`), which a person can act on. */
export function micRefusal(refused: string): { error: string; reason: string } {
  if (/phone/.test(refused)) return { reason: "elsewhere", error: "Your iPhone has conch's audio right now. Hand it back to this Mac to check the microphone." };
  if (/another Mac/.test(refused)) return { reason: "elsewhere", error: "Another Mac has conch's audio right now. Hand it back to check the microphone here." };
  if (/already open/.test(refused)) return { reason: "busy", error: "The microphone is already open for something else. conch tries again in a moment." };
  if (/shutting down/.test(refused)) return { reason: "closing", error: "conch is closing." };
  return { reason: "speaking", error: "conch is still speaking. It checks the microphone once it's done." };
}

// MARK: - The service

export interface SetupDependencies {
  claudeDir: string;
  codexDir: string;
  /** Where `setup.json` lives: conch's config folder. */
  configDir: string;
  home: string;
  /** Scratch for the microphone check's recording. */
  tmpDir: string;
  now(): number;
  log(line: string): void;
  resolveAgents(): Promise<AgentBinary[]>;
  isConchHook(command: string | undefined): boolean;
  codexHooksWired(codexDir: string): Promise<boolean>;
  pluginInstalled(agent: SetupAgent): boolean;
  /** The session a hook event names, by the agent it runs; undefined while conch doesn't know it yet. */
  backendOf(sessionId: string): SetupAgent | undefined;
  liveSessions(): ReadonlyArray<{ sessionId: string; backend?: SetupAgent; startedAt?: number }>;
  connectHooks(agent: SetupAgent): Promise<HooksInstallResult>;
  installPlugin(agent: SetupAgent): Promise<boolean>;
  /** Whether the person's login shell has `brew` or `npm`, for the default installer. */
  shellHas(tool: "brew" | "npm"): Promise<boolean>;
  /** Run an installer's command line in a login shell: its output, line by line, and its exit code. */
  runInstaller(command: string, onOutput: (text: string) => void): { exited: Promise<number>; kill(): void };
  /** Kokoro voice ids in the ring, in order (`CONCH_TTS_VOICES`). */
  voices(): readonly string[];
  /** One line in one voice through the speech path, once the queue is free: false when conch was busy. */
  speak(voice: string, text: string): Promise<boolean>;
  mic: {
    hold(stop: () => void): Promise<{ release(): void } | { refused: string }>;
    record(wav: string, seconds: number): { exited: Promise<number>; stop(): void };
    transcribe(wav: string): Promise<string | null>;
    /** Speech recognition is downloaded and loadable. */
    recognitionReady(): boolean;
  };
  retry(what: "speech" | "voices"): boolean;
}

export interface Setup {
  handle(request: SetupRequest, emit: (line: SetupLine) => void, closed: Promise<void>): Promise<SetupReply>;
  /** Every event the socket takes: a hook's is how conch hears from an agent. */
  noteTurn(event: Pick<TurnEvent, "type" | "sessionId">): void;
  status(): Promise<AgentSetupReport[]>;
}

export function createSetup(deps: SetupDependencies): Setup {
  const memoryPath = join(deps.configDir, "setup.json");
  let memory = readSetupMemory(memoryPath);
  /** Sessions a hook event came from whose agent conch didn't know yet; resolved at the next status. */
  const pending = new Set<string>();
  /** Every session heard from this run: it has its hooks, whenever it started. */
  const heardSessions = new Set<string>();
  const connecting = new Set<SetupAgent>();
  const installing = new Set<SetupAgent>();
  // Finding the agents runs login shells; the window asks every few seconds while it waits to hear from one, so the
  // answer is kept briefly, and dropped whenever an install or a connect may have changed it.
  let found: { at: number; binaries: Promise<AgentBinary[]> } | null = null;
  const resolveAgents = (): Promise<AgentBinary[]> => {
    if (!found || deps.now() - found.at > AGENTS_FRESH_MS) {
      const binaries = deps.resolveAgents();
      found = { at: deps.now(), binaries };
      binaries.catch(() => { found = null; });
    }
    return found.binaries;
  };

  const heardFrom = (agent: SetupAgent): void => {
    if (memory.heard[agent]) return;
    memory = { ...memory, heard: { ...memory.heard, [agent]: deps.now() } };
    writeSetupMemory(memoryPath, memory);
    deps.log(`setup: heard from ${AGENT_NAMES[agent]} for the first time`);
  };

  const noteTurn = (event: Pick<TurnEvent, "type" | "sessionId">): void => {
    if (!HOOK_EVENT_TYPES.has(event.type) || !event.sessionId) return;
    heardSessions.add(event.sessionId);
    const agent = deps.backendOf(event.sessionId);
    if (agent) return heardFrom(agent);
    pending.add(event.sessionId);
    // Bounded: a flood of sessions conch never learns about must not grow this forever.
    if (pending.size > 64) pending.delete(pending.values().next().value!);
  };

  const status = async (): Promise<AgentSetupReport[]> => {
    for (const sessionId of [...pending]) {
      const agent = deps.backendOf(sessionId);
      if (!agent) continue;
      pending.delete(sessionId);
      heardFrom(agent);
    }
    const binaries = await resolveAgents();
    const reports: AgentSetupReport[] = [];
    for (const agent of SETUP_AGENTS) {
      const binary = binaries.find((candidate) => candidate.agent === agent);
      const path = binary?.used || binary?.shell || "";
      const versionLine = binary?.used ? binary.version : binary?.shellVersion ?? "";
      let real = path;
      try { if (path) real = realpathSync(path); } catch {}
      // Two copies only when both answered and they are different versions: a second path to the same one is no news.
      const conchVersion = binary?.used ? agentVersion(binary.version) : null;
      const shellVersion = binary?.shell && binary.shell !== binary.used ? agentVersion(binary.shellVersion) : null;
      const disagree = Boolean(conchVersion && shellVersion && conchVersion !== shellVersion);
      const wiredAt = memory.wiredAt[agent];
      reports.push({
        agent,
        found: Boolean(path),
        path: path ? tilde(path, deps.home) : null,
        version: agentVersion(versionLine),
        source: path ? agentSource(path, deps.home, real) : null,
        hooksWired: agent === "claude"
          ? claudeHooksWiredAt(deps.claudeDir, deps.isConchHook)
          : await deps.codexHooksWired(deps.codexDir),
        pluginInstalled: deps.pluginInstalled(agent),
        signedIn: agent === "codex" ? existsSync(join(deps.codexDir, "auth.json")) : null,
        heard: Boolean(memory.heard[agent]),
        openBeforeHooks: wiredAt
          ? deps.liveSessions().filter((session) => (session.backend ?? "claude") === agent
            && session.startedAt !== undefined && session.startedAt < wiredAt && !heardSessions.has(session.sessionId)).length
          : 0,
        copies: disagree && binary
          ? { conch: `${conchVersion}  ${tilde(binary.used, deps.home)}`, shell: `${shellVersion}  ${tilde(binary.shell, deps.home)}` }
          : null,
      });
    }
    return reports;
  };

  const connect = async (agent: SetupAgent): Promise<SetupReply> => {
    const name = AGENT_NAMES[agent];
    if (connecting.has(agent)) return { kind: "setup-error", agent, error: `conch is already connecting ${name}.` };
    connecting.add(agent);
    found = null;
    try {
      const binary = (await resolveAgents()).find((candidate) => candidate.agent === agent);
      if (!binary?.used && !binary?.shell) return { kind: "setup-error", agent, error: `${name} isn't on this Mac yet. Install it first.` };
      let hooks: HooksInstallResult;
      try {
        hooks = await deps.connectHooks(agent);
      } catch (error) {
        deps.log(`setup: connecting ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        // `runInstall` never writes over a file it couldn't read, so nothing changed.
        return { kind: "setup-error", agent, error: `conch couldn't read ${name}'s settings file, so it changed nothing. It may have a mistake in it.` };
      }
      if (hooks.changed) {
        memory = { ...memory, wiredAt: { ...memory.wiredAt, [agent]: deps.now() } };
        writeSetupMemory(memoryPath, memory);
      }
      let plugin = false;
      try {
        plugin = await deps.installPlugin(agent);
      } catch (error) {
        deps.log(`setup: ${name}'s plugin failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!plugin) {
        return {
          kind: "setup-error",
          agent,
          error: hooks.changed
            ? `conch added its hooks to ${name}, but couldn't add its plugin. Try again.`
            : `conch couldn't add its plugin to ${name}. Try again.`,
        };
      }
      deps.log(`setup: connected ${name}${hooks.changed ? `, hooks written${hooks.backup ? ` (backup ${hooks.backup})` : ""}` : ", hooks already in"}`);
      return {
        kind: "setup-connected",
        agent,
        changed: [...(hooks.changed ? ["hooks"] : []), "plugin"],
        file: hooks.file,
        backup: hooks.backup,
      };
    } finally {
      connecting.delete(agent);
    }
  };

  const install = async (agent: SetupAgent, requested: InstallVia | undefined, emit: (line: SetupLine) => void): Promise<SetupReply> => {
    const name = AGENT_NAMES[agent];
    if (installing.has(agent)) return { kind: "setup-error", agent, error: `${name} is already installing.` };
    const tools = { brew: await deps.shellHas("brew"), npm: await deps.shellHas("npm") };
    const via = requested ?? defaultInstallVia(agent, (tool) => tools[tool]);
    const command = INSTALLERS[agent][via]!;
    if ((via === "brew" || via === "npm") && !tools[via]) {
      return { kind: "setup-error", agent, error: `${via === "brew" ? "Homebrew" : "npm"} isn't on this Mac, so this installer can't run.`, command };
    }
    installing.add(agent);
    deps.log(`setup: installing ${name} with ${command}`);
    let last = "";
    let buffer = "";
    let lastEmit = 0;
    const say = (line: string, force = false): void => {
      last = line;
      const at = deps.now();
      if (!force && at - lastEmit < 150) return;
      lastEmit = at;
      emit({ kind: "setup-install-line", agent, line });
    };
    try {
      const run = deps.runInstaller(command, (text) => {
        buffer += text;
        const parts = buffer.split(/\r\n|\r|\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = installerLine(part, deps.home);
          if (line) say(line);
        }
      });
      const timer = setTimeout(() => run.kill(), INSTALL_TIMEOUT_MS);
      const code = await run.exited.finally(() => clearTimeout(timer));
      const tail = installerLine(buffer, deps.home);
      if (tail) say(tail, true);
      else if (last) emit({ kind: "setup-install-line", agent, line: last });
      if (code !== 0) {
        deps.log(`setup: installing ${name} exited ${code}: ${last}`);
        return { kind: "setup-error", agent, error: last ? `The install stopped: ${last}` : "The install stopped without saying why.", command };
      }
      deps.log(`setup: ${name} installed`);
      return { kind: "setup-installed", agent };
    } catch (error) {
      deps.log(`setup: installing ${name} couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: "setup-error", agent, error: "The installer couldn't start.", command };
    } finally {
      installing.delete(agent);
      found = null;
    }
  };

  const voiceSample = async (asked: string): Promise<SetupReply> => {
    const ring = deps.voices();
    const wanted = asked.toLowerCase();
    const id = ring.find((voice) => voice.toLowerCase() === wanted || voice.toLowerCase().split("_").pop() === wanted);
    if (!id) return { kind: "setup-error", error: "conch doesn't have that voice." };
    const name = voiceName(id);
    const spoken = await deps.speak(id, `Hi, I'm ${name}. Each session keeps the voice it's given.`);
    return spoken
      ? { kind: "voice-sample-done", voice: name }
      : { kind: "setup-error", error: "conch is reading something aloud. Try again when it's done.", reason: "busy" };
  };

  const micCheck = async (seconds: number, emit: (line: SetupLine) => void, closed: Promise<void>): Promise<SetupReply> => {
    let stopRecorder: () => void = () => {};
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      stopRecorder();
    };
    const held = await deps.mic.hold(() => stop());
    if ("refused" in held) return { kind: "setup-error", ...micRefusal(held.refused) };
    let gone = false;
    void closed.then(() => {
      gone = true;
      stop();
    });
    const wav = join(deps.tmpDir, `conch-mic-check-${process.pid}-${deps.now()}.wav`);
    let peak = 0;
    try {
      let recorder: { exited: Promise<number>; stop(): void };
      try {
        recorder = deps.mic.record(wav, seconds);
      } catch (error) {
        deps.log(`setup: the microphone check couldn't start its recorder: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: "setup-error", error: "conch couldn't open the microphone.", reason: "no-recorder" };
      }
      stopRecorder = () => recorder.stop();
      if (stopped) recorder.stop();
      let exited = false;
      void recorder.exited.finally(() => { exited = true; });

      // Read the WAV as sox writes it: a level for each 60 ms, and an early end once someone has spoken and paused.
      let fd: number | null = null;
      let position = 0;
      let dataStart: number | null = null;
      let carry: Uint8Array = new Uint8Array(0);
      let spokeAt: number | null = null;
      let quietSince: number | null = null;
      const deadline = deps.now() + (seconds + 2) * 1000;
      const drain = (): void => {
        if (fd === null) {
          if (!existsSync(wav)) return;
          try { fd = openSync(wav, "r"); } catch { return; }
        }
        let size = 0;
        try { size = statSync(wav).size; } catch { return; }
        if (size <= position) return;
        const chunk = new Uint8Array(size - position);
        const read = readSync(fd, chunk, 0, chunk.length, position);
        position += read;
        let bytes = concat(carry, chunk.subarray(0, read));
        if (dataStart === null) {
          const offset = wavDataOffset(bytes);
          if (offset === null) {
            carry = bytes;
            return;
          }
          dataStart = offset;
          bytes = bytes.subarray(offset);
        }
        let at = 0;
        while (bytes.length - at >= LEVEL_BYTES) {
          const level = pcmLevel(bytes.subarray(at, at + LEVEL_BYTES));
          at += LEVEL_BYTES;
          peak = Math.max(peak, level);
          emit({ kind: "mic-level", level: Math.round(level * 1000) / 1000 });
          const now = deps.now();
          if (level >= MIC_SPEECH_LEVEL) {
            spokeAt ??= now;
            quietSince = null;
          } else if (spokeAt !== null) {
            quietSince ??= now;
          }
        }
        carry = bytes.slice(at);
      };
      while (!exited && !gone && deps.now() < deadline) {
        drain();
        if (quietSince !== null && deps.now() - quietSince >= MIC_TRAILING_QUIET_MS) stop();
        await Bun.sleep(50);
      }
      if (!exited) {
        stop();
        await Promise.race([recorder.exited, Bun.sleep(2_000)]);
      }
      drain();
      if (fd !== null) closeSync(fd);
    } finally {
      held.release();
    }
    try {
      if (gone) return { kind: "setup-error", error: "The microphone check stopped.", reason: "cancelled" };
      const silent = peak < MIC_SILENT_PEAK;
      const rounded = Math.round(peak * 1000) / 1000;
      if (silent) return { kind: "mic-check-done", heard: null, silent: true, recognition: deps.mic.recognitionReady() ? "ready" : "waiting", peak: rounded };
      if (!deps.mic.recognitionReady()) return { kind: "mic-check-done", heard: null, silent: false, recognition: "waiting", peak: rounded };
      const heard = await deps.mic.transcribe(wav).catch((error: unknown) => {
        deps.log(`setup: the microphone check's transcription failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      return { kind: "mic-check-done", heard: heard?.trim() || null, silent: false, recognition: "ready", peak: rounded };
    } finally {
      rmSync(wav, { force: true });
    }
  };

  return {
    noteTurn,
    status,
    async handle(request, emit, closed) {
      switch (request.kind) {
        case "setup-status":
          return { kind: "setup-status", agents: await status() };
        case "setup-connect":
          return connect(request.agent);
        case "setup-install":
          return install(request.agent, request.via, emit);
        case "voice-sample":
          return voiceSample(request.voice);
        case "mic-check":
          return micCheck(request.seconds ?? MIC_CHECK_SECONDS, emit, closed);
        case "setup-retry":
          return { kind: "setup-ack", retried: deps.retry(request.what) };
      }
    },
  };
}

/** How long a found agent is taken as found before the shells are asked again. */
export const AGENTS_FRESH_MS = 15_000;

/** How long an installer may run before setup stops it: a cask on a slow connection, with room to spare. */
export const INSTALL_TIMEOUT_MS = 20 * 60_000;

/** One line of an installer's output, as setup shows it: no colour codes, no progress-bar clutter, the home folder as `~`. */
export function installerLine(raw: string, home: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  if (!plain || /^[#=\-.\s>*]+$/.test(plain)) return "";
  const line = home ? plain.split(home).join("~") : plain;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** "Emma" from "bf_emma". */
export function voiceName(id: string): string {
  const bare = id.split("_").pop() ?? id;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The default installer runner: a login shell, so Homebrew and npm are found as they are in Terminal. */
export function runInstallerInLoginShell(command: string, onOutput: (text: string) => void): { exited: Promise<number>; kill(): void } {
  const proc = Bun.spawn(["/bin/zsh", "-lc", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // No prompts it can't answer: Homebrew's own switch for unattended installs.
    env: { ...process.env, NONINTERACTIVE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
  });
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) onOutput(decoder.decode(chunk, { stream: true }));
  };
  const exited = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => proc.exited);
  return { exited, kill: () => proc.kill() };
}

/** Whether the person's login shell has `tool`. */
export async function loginShellHas(tool: "brew" | "npm"): Promise<boolean> {
  try {
    const proc = Bun.spawn(["/bin/zsh", "-lc", `command -v ${tool}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out.length > 0;
  } catch {
    return false;
  }
}
