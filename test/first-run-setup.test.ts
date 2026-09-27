import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import type { AgentBinary } from "../src/doctor-checks.ts";
import { codexHooksAreWiredAt, isConchHookCommand, runCodexInstall, runInstall } from "../src/install.ts";
import { pluginInstalledFor } from "../src/plugin-install.ts";
import {
  agentSource,
  agentVersion,
  claudeHooksWiredAt,
  createSetup,
  decodeSetupRequest,
  defaultInstallVia,
  installerLine,
  micRefusal,
  MIC_SILENT_PEAK,
  MIC_SPEECH_LEVEL,
  pcmLevel,
  readSetupMemory,
  tilde,
  voiceName,
  wavDataOffset,
  type SetupDependencies,
  type SetupLine,
  type SetupReply,
} from "../src/setup.ts";

// First-run setup's daemon half (setup.ts). Every home here is a temp folder under the run's own TMPDIR (preload.ts):
// nothing reads or writes the real ~/.claude, ~/.codex or conch's config, and no agent, installer, speaker or
// microphone runs. The Mac window's wiring is pinned in setup-window-source.test.ts.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function homes() {
  const root = mkdtempSync(join(tmpdir(), "conch-setup-"));
  roots.push(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const codexDir = join(home, ".codex");
  const configDir = join(home, ".config", "conch");
  for (const dir of [claudeDir, codexDir, configDir]) mkdirSync(dir, { recursive: true });
  return { root, home, claudeDir, codexDir, configDir };
}

const claudeFound: AgentBinary = { agent: "claude", used: "/opt/homebrew/bin/claude", version: "2.1.280 (Claude Code)", shell: "/opt/homebrew/bin/claude", shellVersion: "" };
const codexFound: AgentBinary = { agent: "codex", used: "/opt/homebrew/bin/codex", version: "codex-cli 0.156.0", shell: "/opt/homebrew/bin/codex", shellVersion: "" };
const codexMissing: AgentBinary = { agent: "codex", used: "", version: "", shell: "", shellVersion: "" };

type Fixture = ReturnType<typeof homes> & {
  deps: SetupDependencies;
  calls: { connect: string[]; plugin: string[]; speak: Array<[string, string]>; installs: string[]; stops: number; releases: number; transcribed: number };
};

function fixture(over: Partial<SetupDependencies> = {}, binaries: AgentBinary[] = [claudeFound, codexFound]): Fixture {
  const h = homes();
  const calls = { connect: [] as string[], plugin: [] as string[], speak: [] as Array<[string, string]>, installs: [] as string[], stops: 0, releases: 0, transcribed: 0 };
  const deps: SetupDependencies = {
    claudeDir: h.claudeDir,
    codexDir: h.codexDir,
    configDir: h.configDir,
    home: h.home,
    tmpDir: h.root,
    now: Date.now,
    log: () => {},
    resolveAgents: async () => binaries,
    isConchHook: isConchHookCommand,
    codexHooksWired: codexHooksAreWiredAt,
    pluginInstalled: (agent) => pluginInstalledFor(agent, { claudeDir: h.claudeDir, codexDir: h.codexDir }),
    backendOf: () => undefined,
    liveSessions: () => [],
    connectHooks: async (agent) => {
      calls.connect.push(agent);
      return { changed: true, file: join(agent === "claude" ? h.claudeDir : h.codexDir, "settings.json"), backup: null };
    },
    installPlugin: async (agent) => {
      calls.plugin.push(agent);
      return true;
    },
    shellHas: async () => true,
    runInstaller: (command) => {
      calls.installs.push(command);
      return { exited: Promise.resolve(0), kill: () => {} };
    },
    voices: () => ["af_heart", "am_michael", "bf_emma", "am_adam", "af_nova", "bm_george", "af_bella", "af_sky"],
    speak: async (voice, text) => {
      calls.speak.push([voice, text]);
      return true;
    },
    mic: {
      hold: async () => ({ release: () => { calls.releases++; } }),
      record: () => ({ exited: Promise.resolve(0), stop: () => { calls.stops++; } }),
      transcribe: async () => {
        calls.transcribed++;
        return "Testing, one, two, three.";
      },
      recognitionReady: () => true,
    },
    retry: () => true,
    ...over,
  };
  return { ...h, deps, calls };
}

const claudeHooks = (command = '"/opt/homebrew/bin/conch" hook', events = ["Stop", "UserPromptSubmit", "Notification"]) => ({
  hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])),
});

describe("what a request is", () => {
  test("setup's six kinds decode; anything else isn't setup's, and a malformed one is refused with why", () => {
    expect(decodeSetupRequest({ kind: "setup-status" })).toEqual({ kind: "setup-status" });
    expect(decodeSetupRequest({ kind: "setup-connect", agent: "codex" })).toEqual({ kind: "setup-connect", agent: "codex" });
    expect(decodeSetupRequest({ kind: "setup-connect", agent: "gemini" })).toEqual({ error: "agent must be claude or codex" });
    expect(decodeSetupRequest({ kind: "setup-install", agent: "claude" })).toEqual({ kind: "setup-install", agent: "claude" });
    expect(decodeSetupRequest({ kind: "setup-install", agent: "codex", via: "npm" })).toEqual({ kind: "setup-install", agent: "codex", via: "npm" });
    // Claude Code has no npm installer here: its own and its cask.
    expect(decodeSetupRequest({ kind: "setup-install", agent: "claude", via: "npm" })).toEqual({ error: "Claude Code has no npm installer" });
    expect(decodeSetupRequest({ kind: "setup-install", agent: "claude", via: "curl | sh" })).toEqual({ error: "via must be native, brew or npm" });
    expect(decodeSetupRequest({ kind: "voice-sample", voice: " Emma " })).toEqual({ kind: "voice-sample", voice: "Emma" });
    expect(decodeSetupRequest({ kind: "voice-sample", voice: "" })).toEqual({ error: "voice must name a voice" });
    expect(decodeSetupRequest({ kind: "mic-check", seconds: 60 })).toEqual({ kind: "mic-check", seconds: 10 });
    expect(decodeSetupRequest({ kind: "mic-check", seconds: -1 })).toEqual({ error: "seconds must be a positive number" });
    expect(decodeSetupRequest({ kind: "setup-retry", what: "voices" })).toEqual({ kind: "setup-retry", what: "voices" });
    expect(decodeSetupRequest({ kind: "setup-retry", what: "everything" })).toEqual({ error: "what must be speech or voices" });
    for (const other of [{ kind: "open-pairing" }, { type: "turn-end" }, null, "setup-status", []]) expect(decodeSetupRequest(other)).toBeNull();
  });
});

describe("agents, as setup finds them", () => {
  test("a version is its number, and where it came from is said in words", () => {
    expect(agentVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
    expect(agentVersion("codex-cli 0.156.0")).toBe("0.156.0");
    expect(agentVersion("codex-cli 0.157.0-alpha.2")).toBe("0.157.0-alpha.2");
    expect(agentVersion("")).toBeNull();
    const home = "/Users/t";
    expect(agentSource("/opt/homebrew/bin/claude", home)).toBe("Homebrew");
    expect(agentSource("/usr/local/bin/codex", home, "/usr/local/Caskroom/codex/0.156.0/codex")).toBe("Homebrew");
    expect(agentSource("/Users/t/.nvm/versions/node/v22/bin/codex", home)).toBe("npm");
    expect(agentSource("/usr/local/bin/codex", home, "/usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBe("npm");
    expect(agentSource("/Users/t/.local/bin/claude", home, "/Users/t/.local/share/claude/versions/2.1.280")).toBe("its own installer");
    expect(agentSource("/usr/local/bin/claude", home)).toBeNull();
    expect(tilde("/Users/t/.local/bin/claude", home)).toBe("~/.local/bin/claude");
    expect(tilde("/Users/tim/claude", home)).toBe("/Users/tim/claude");
  });

  test("Claude Code counts as wired when a turn finishing and a prompt starting both reach conch, by the hook's shape", () => {
    const h = homes();
    const wired = (settings: unknown) => {
      writeFileSync(join(h.claudeDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
      return claudeHooksWiredAt(h.claudeDir, isConchHookCommand);
    };
    expect(claudeHooksWiredAt(h.claudeDir, isConchHookCommand)).toBe(false);
    expect(wired(claudeHooks())).toBe(true);
    // The Mac app's own daemon is conch too: setup wires that one from the app.
    expect(wired(claudeHooks('"/Applications/conch.app/Contents/Helpers/conch-daemon" hook'))).toBe(true);
    expect(wired(claudeHooks('"/opt/homebrew/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook'))).toBe(true);
    expect(wired(claudeHooks('"/opt/homebrew/bin/conch" hook', ["Stop"]))).toBe(false);
    expect(wired(claudeHooks("node my-hooks.js"))).toBe(false);
    expect(wired("{ not json")).toBe(false);
  });

  test("status: each agent's version, source, hooks, plugin and sign-in, from its own files", async () => {
    const f = fixture({}, [claudeFound, { ...codexFound, used: join("/tmp", "nowhere", "codex") }]);
    writeFileSync(join(f.claudeDir, "settings.json"), JSON.stringify(claudeHooks()));
    mkdirSync(join(f.claudeDir, "plugins"), { recursive: true });
    writeFileSync(join(f.claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "conch@conch": [{ scope: "user" }] } }));
    const setup = createSetup(f.deps);
    let [claude, codex] = await setup.status();
    expect(claude).toEqual({
      agent: "claude", found: true, path: "/opt/homebrew/bin/claude", version: "2.1.280", source: "Homebrew",
      hooksWired: true, pluginInstalled: true, signedIn: null, heard: false, openBeforeHooks: 0, copies: null,
    });
    expect(codex).toMatchObject({ agent: "codex", found: true, version: "0.156.0", hooksWired: false, pluginInstalled: false, signedIn: false });
    // Codex's own records: its hooks file, its plugin table, its sign-in.
    writeFileSync(join(f.codexDir, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(["Stop", "UserPromptSubmit", "SessionStart"]
      .map((event) => [event, [{ hooks: [{ type: "command", command: '"/usr/local/bin/conch" codex-hook' }] }]])) }));
    writeFileSync(join(f.codexDir, "config.toml"), '[marketplaces.conch-local]\nsource = "/x"\n\n[plugins."conch@conch-local"]\nenabled = true\n');
    writeFileSync(join(f.codexDir, "auth.json"), "{}");
    [claude, codex] = await setup.status();
    expect(codex).toMatchObject({ hooksWired: true, pluginInstalled: true, signedIn: true });
  });

  test("an agent on neither PATH is not found; one only the shell has is found at the shell's", async () => {
    const setup = createSetup(fixture({}, [{ ...claudeFound, used: "", version: "", shell: "/Users/x/.local/bin/claude", shellVersion: "2.1.281 (Claude Code)" }, codexMissing]).deps);
    const [claude, codex] = await setup.status();
    expect(claude).toMatchObject({ found: true, version: "2.1.281", copies: null });
    expect(codex).toMatchObject({ found: false, path: null, version: null, source: null });
  });

  test("two copies are named only when both answered with different versions", async () => {
    const two = (shellVersion: string) => createSetup(fixture({}, [
      { agent: "claude", used: "/opt/homebrew/Caskroom/claude-code/2.1.266/claude", version: "2.1.266", shell: "/Users/x/.local/bin/claude", shellVersion },
      codexMissing,
    ]).deps).status();
    const [disagree] = await two("2.1.280 (Claude Code)");
    expect(disagree!.copies).toEqual({ conch: "2.1.266  /opt/homebrew/Caskroom/claude-code/2.1.266/claude", shell: "2.1.280  /Users/x/.local/bin/claude" });
    expect((await two("2.1.266 (Claude Code)"))[0]!.copies).toBeNull();
    expect((await two(""))[0]!.copies).toBeNull();
  });
});

describe("green on the first real hook event, not on the file write", () => {
  test("a hook's event from a known session marks its agent heard, for good; conch's own events never do", async () => {
    const f = fixture({ backendOf: (id) => (id === "s-codex" ? "codex" : id === "s-claude" ? "claude" : undefined) });
    const setup = createSetup(f.deps);
    for (const type of ["wake", "inject", "recite", "speak", "review-published"] as const) setup.noteTurn({ type, sessionId: "s-claude" });
    expect((await setup.status()).map((agent) => agent.heard)).toEqual([false, false]);
    setup.noteTurn({ type: "working", sessionId: "s-codex" });
    expect((await setup.status()).map((agent) => agent.heard)).toEqual([false, true]);
    setup.noteTurn({ type: "turn-end", sessionId: "s-claude" });
    expect((await setup.status()).map((agent) => agent.heard)).toEqual([true, true]);
    // Remembered across a restart.
    expect(Object.keys(readSetupMemory(join(f.configDir, "setup.json")).heard).sort()).toEqual(["claude", "codex"]);
    expect((await createSetup(f.deps).status()).map((agent) => agent.heard)).toEqual([true, true]);
  });

  test("a hook's event from a session conch learns about later counts once it does", async () => {
    let known = false;
    const setup = createSetup(fixture({ backendOf: () => (known ? "claude" : undefined) }).deps);
    setup.noteTurn({ type: "session-start", sessionId: "new-window" });
    expect((await setup.status())[0]!.heard).toBe(false);
    known = true;
    expect((await setup.status())[0]!.heard).toBe(true);
  });

  test("sessions open before conch wired an agent need /hooks, until each is heard from", async () => {
    let now = 1_000;
    const f = fixture({
      now: () => now,
      liveSessions: () => [
        { sessionId: "old-1", backend: "claude", startedAt: 100 },
        { sessionId: "old-2", startedAt: 200 },
        { sessionId: "codex-old", backend: "codex", startedAt: 100 },
        { sessionId: "unknown-start", backend: "claude" },
      ],
      backendOf: () => "claude",
    });
    const setup = createSetup(f.deps);
    expect((await setup.status())[0]!.openBeforeHooks).toBe(0);
    expect(await setup.handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {}))).toMatchObject({ kind: "setup-connected" });
    now = 5_000;
    expect((await setup.status())[0]!.openBeforeHooks).toBe(2);
    setup.noteTurn({ type: "working", sessionId: "old-1" });
    expect((await setup.status())[0]!.openBeforeHooks).toBe(1);
    expect((await setup.status())[1]!.openBeforeHooks).toBe(0);
  });
});

describe("connecting an agent", () => {
  test("writes the hooks, then the plugin, and says what changed and where the backup went", async () => {
    const f = fixture({ connectHooks: async () => ({ changed: true, file: "/h/.claude/settings.json", backup: "/h/.claude/settings.json.conch-backup-1" }) });
    const reply = await createSetup(f.deps).handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {}));
    expect(reply).toEqual({ kind: "setup-connected", agent: "claude", changed: ["hooks", "plugin"], file: "/h/.claude/settings.json", backup: "/h/.claude/settings.json.conch-backup-1" });
    expect(f.calls.plugin).toEqual(["claude"]);
    expect(readSetupMemory(join(f.configDir, "setup.json")).wiredAt.claude).toBeNumber();
  });

  test("with the real installers: hooks and a backup in a temp Claude Code, the same shapes status reads back", async () => {
    const f = fixture();
    writeFileSync(join(f.claudeDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    const log = console.log;
    console.log = () => {};
    try {
      const result = await runInstall({ claudeDir: f.claudeDir });
      expect(result.changed).toBe(true);
      expect(result.backup).toStartWith(join(f.claudeDir, "settings.json.conch-backup-"));
      expect(JSON.parse(readFileSync(result.backup!, "utf8"))).toEqual({ theme: "dark" });
      expect(claudeHooksWiredAt(f.claudeDir, isConchHookCommand)).toBe(true);
      expect(await runInstall({ claudeDir: f.claudeDir })).toMatchObject({ changed: false, backup: null });
      const codex = await runCodexInstall(f.codexDir);
      expect(codex).toMatchObject({ changed: true, file: join(f.codexDir, "hooks.json"), backup: null });
      expect(await codexHooksAreWiredAt(f.codexDir)).toBe(true);
    } finally {
      console.log = log;
    }
  });

  test("every failure is said in plain words, and nothing is half-claimed", async () => {
    const missing = await createSetup(fixture({}, [claudeFound, codexMissing]).deps)
      .handle({ kind: "setup-connect", agent: "codex" }, () => {}, new Promise(() => {}));
    expect(missing).toEqual({ kind: "setup-error", agent: "codex", error: "Codex isn't on this Mac yet. Install it first." });
    const unreadable = await createSetup(fixture({ connectHooks: async () => { throw new SyntaxError("JSON Parse error: Unexpected identifier"); } }).deps)
      .handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {}));
    expect(unreadable).toEqual({ kind: "setup-error", agent: "claude", error: "conch couldn't read Claude Code's settings file, so it changed nothing. It may have a mistake in it." });
    const f = fixture({ installPlugin: async () => false });
    const noPlugin = await createSetup(f.deps).handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {}));
    expect(noPlugin).toEqual({ kind: "setup-error", agent: "claude", error: "conch added its hooks to Claude Code, but couldn't add its plugin. Try again." });
    expect(JSON.stringify(noPlugin)).not.toContain("/");
  });

  /** Finding agents runs login shells: kept briefly while the window polls, and asked again when it may have changed. */
  test("the agents found are kept a few seconds, never trusted by a connect, and dropped after an install", async () => {
    let asked = 0;
    let now = 1_000;
    let codexHere = false;
    const f = fixture({ now: () => now, resolveAgents: async () => { asked++; return [claudeFound, codexHere ? codexFound : codexMissing]; } });
    const setup = createSetup(f.deps);
    await setup.status();
    await setup.status();
    expect(asked).toBe(1);
    now += 16_000;
    expect((await setup.status())[1]!.found).toBe(false);
    expect(asked).toBe(2);
    // Installed in Terminal a moment ago: Connect looks again rather than saying it isn't here.
    codexHere = true;
    expect(await setup.handle({ kind: "setup-connect", agent: "codex" }, () => {}, new Promise(() => {}))).toMatchObject({ kind: "setup-connected" });
    // An install changes what's there: the next status asks the shells again.
    const beforeInstall = asked;
    await setup.handle({ kind: "setup-install", agent: "codex", via: "npm" }, () => {}, new Promise(() => {}));
    await setup.status();
    expect(asked).toBeGreaterThan(beforeInstall);
  });

  test("one connect at a time per agent", async () => {
    let finish!: () => void;
    const f = fixture({ connectHooks: () => new Promise((resolve) => { finish = () => resolve({ changed: false, file: "x", backup: null }); }) });
    const setup = createSetup(f.deps);
    const first = setup.handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {}));
    await Bun.sleep(5);
    expect(await setup.handle({ kind: "setup-connect", agent: "claude" }, () => {}, new Promise(() => {})))
      .toEqual({ kind: "setup-error", agent: "claude", error: "conch is already connecting Claude Code." });
    finish();
    expect(await first).toMatchObject({ kind: "setup-connected", changed: ["plugin"] });
  });
});

describe("installing an agent with its own installer", () => {
  test("the default installer: Claude Code's own; Codex's cask, else npm, else its script", () => {
    expect(defaultInstallVia("claude", () => true)).toBe("native");
    expect(defaultInstallVia("codex", (tool) => tool === "brew")).toBe("brew");
    expect(defaultInstallVia("codex", (tool) => tool === "npm")).toBe("npm");
    expect(defaultInstallVia("codex", () => false)).toBe("native");
  });

  test("streams the installer's last line, clean, and says it's done", async () => {
    const f = fixture({
      runInstaller: (command, onOutput) => {
        f.calls.installs.push(command);
        onOutput("\x1b[34m==>\x1b[0m Downloading https://example/codex-0.156.0-aarch64-apple-darwin.tar.gz\n");
        onOutput("######\r############ 62.0%\r");
        onOutput("#################### 100.0%\n==> Installing Cask codex\n");
        onOutput(`codex was successfully installed to ${f.home}/bin!`);
        return { exited: Promise.resolve(0), kill: () => {} };
      },
    });
    const lines: SetupLine[] = [];
    const reply = await createSetup(f.deps).handle({ kind: "setup-install", agent: "codex" }, (line) => lines.push(line), new Promise(() => {}));
    expect(reply).toEqual({ kind: "setup-installed", agent: "codex" });
    expect(f.calls.installs).toEqual(["brew install --cask codex"]);
    expect(lines.at(-1)).toEqual({ kind: "setup-install-line", agent: "codex", line: "codex was successfully installed to ~/bin!" });
    expect(lines[0]).toEqual({ kind: "setup-install-line", agent: "codex", line: "==> Downloading https://example/codex-0.156.0-aarch64-apple-darwin.tar.gz" });
    for (const line of lines) expect((line as { line: string }).line).not.toContain("\x1b");
  });

  test("a failed install says its last words and keeps the command to run by hand", async () => {
    const f = fixture({
      runInstaller: (_command, onOutput) => {
        onOutput("Error: Cask 'codex' is already being installed.\n");
        return { exited: Promise.resolve(1), kill: () => {} };
      },
    });
    expect(await createSetup(f.deps).handle({ kind: "setup-install", agent: "codex", via: "brew" }, () => {}, new Promise(() => {}))).toEqual({
      kind: "setup-error", agent: "codex", error: "The install stopped: Error: Cask 'codex' is already being installed.", command: "brew install --cask codex",
    });
    const noBrew = fixture({ shellHas: async (tool) => tool !== "brew" });
    expect(await createSetup(noBrew.deps).handle({ kind: "setup-install", agent: "codex", via: "brew" }, () => {}, new Promise(() => {}))).toEqual({
      kind: "setup-error", agent: "codex", error: "Homebrew isn't on this Mac, so this installer can't run.", command: "brew install --cask codex",
    });
    expect(noBrew.calls.installs).toEqual([]);
    expect(installerLine("\x1b[1m##########\x1b[0m", "/h")).toBe("");
    expect(installerLine("x".repeat(200), "/h")).toHaveLength(158);
  });
});

describe("a voice sample", () => {
  test("names a ring voice, and speaks one line in exactly that voice", async () => {
    const f = fixture();
    const setup = createSetup(f.deps);
    expect(await setup.handle({ kind: "voice-sample", voice: "Emma" }, () => {}, new Promise(() => {}))).toEqual({ kind: "voice-sample-done", voice: "Emma" });
    expect(await setup.handle({ kind: "voice-sample", voice: "am_michael" }, () => {}, new Promise(() => {}))).toEqual({ kind: "voice-sample-done", voice: "Michael" });
    expect(f.calls.speak).toEqual([
      ["bf_emma", "Hi, I'm Emma. Each session keeps the voice it's given."],
      ["am_michael", "Hi, I'm Michael. Each session keeps the voice it's given."],
    ]);
    expect(await setup.handle({ kind: "voice-sample", voice: "Siri" }, () => {}, new Promise(() => {}))).toEqual({ kind: "setup-error", error: "conch doesn't have that voice." });
    expect(voiceName("af_sky")).toBe("Sky");
  });

  test("a busy conch says so rather than talking over itself", async () => {
    const f = fixture({ speak: async () => false });
    expect(await createSetup(f.deps).handle({ kind: "voice-sample", voice: "Nova" }, () => {}, new Promise(() => {})))
      .toEqual({ kind: "setup-error", error: "conch is reading something aloud. Try again when it's done.", reason: "busy" });
  });
});

/** A WAV as sox writes it: a 44-byte header, then 16 kHz mono 16-bit PCM. */
function wav(parts: Array<{ seconds: number; amplitude: number }>): Uint8Array {
  const samples = parts.flatMap(({ seconds, amplitude }) =>
    Array.from({ length: Math.round(seconds * 16_000) }, (_, i) => Math.round(Math.sin(i * 0.12) * amplitude * 32767)));
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return out;
}

describe("the microphone check", () => {
  test("levels: silence is nothing, a quiet room below the speech line, a voice well above it", () => {
    const body = (amplitude: number) => wav([{ seconds: 0.06, amplitude }]).subarray(44);
    expect(pcmLevel(body(0))).toBe(0);
    expect(pcmLevel(body(0.002))).toBeLessThan(MIC_SILENT_PEAK);
    expect(pcmLevel(body(0.3))).toBeGreaterThan(MIC_SPEECH_LEVEL);
    expect(pcmLevel(body(1))).toBeLessThanOrEqual(1);
    expect(wavDataOffset(wav([{ seconds: 0.01, amplitude: 0 }]))).toBe(44);
    expect(wavDataOffset(new Uint8Array(20))).toBeNull();
  });

  test("holds the mic through the loop's gate, streams levels, and returns what whisper heard", async () => {
    const f = fixture();
    const order: string[] = [];
    f.deps.mic.hold = async () => { order.push("hold"); return { release: () => { order.push("release"); f.calls.releases++; } }; };
    f.deps.mic.record = (path) => {
      order.push("record");
      writeFileSync(path, wav([{ seconds: 0.3, amplitude: 0.001 }, { seconds: 0.6, amplitude: 0.3 }, { seconds: 0.3, amplitude: 0.001 }]));
      return { exited: Promise.resolve(0), stop: () => { f.calls.stops++; } };
    };
    f.deps.mic.transcribe = async (path) => { order.push("transcribe"); expect(existsSync(path)).toBe(true); return "  Testing, one, two, three.  "; };
    const lines: SetupLine[] = [];
    const reply = await createSetup(f.deps).handle({ kind: "mic-check" }, (line) => lines.push(line), new Promise(() => {}));
    expect(reply).toMatchObject({ kind: "mic-check-done", heard: "Testing, one, two, three.", silent: false, recognition: "ready" });
    expect((reply as { peak: number }).peak).toBeGreaterThan(MIC_SPEECH_LEVEL);
    // The mic is let go before whisper runs, and the recording never outlives the check.
    expect(order).toEqual(["hold", "record", "release", "transcribe"]);
    expect(readdirSync(f.root).filter((name) => name.startsWith("conch-mic-check-"))).toEqual([]);
    const levels = lines.map((line) => (line as { level: number }).level);
    expect(levels.length).toBe(20);
    expect(Math.max(...levels.slice(5, 15))).toBeGreaterThan(MIC_SPEECH_LEVEL);
    expect(Math.max(...levels.slice(0, 4))).toBeLessThan(MIC_SILENT_PEAK);
  });

  test("silence is said, and never sent to whisper: a quiet room is silence too", async () => {
    // Nothing at all, and a room's hum: the second moves the meter a little and is still nobody speaking.
    expect(pcmLevel(wav([{ seconds: 0.06, amplitude: 0.006 }]).subarray(44))).toBeGreaterThan(0.03);
    for (const amplitude of [0.001, 0.006]) {
      const f = fixture();
      f.deps.mic.record = (path) => {
        writeFileSync(path, wav([{ seconds: 1, amplitude }]));
        return { exited: Promise.resolve(0), stop: () => {} };
      };
      const reply = await createSetup(f.deps).handle({ kind: "mic-check" }, () => {}, new Promise(() => {}));
      expect(reply, `amplitude ${amplitude}`).toMatchObject({ kind: "mic-check-done", heard: null, silent: true });
      expect(f.calls.transcribed).toBe(0);
      expect(f.calls.releases).toBe(1);
    }
  });

  test("while speech recognition downloads, the level is the proof and whisper isn't asked", async () => {
    const f = fixture();
    f.deps.mic.recognitionReady = () => false;
    f.deps.mic.record = (path) => {
      writeFileSync(path, wav([{ seconds: 0.5, amplitude: 0.3 }]));
      return { exited: Promise.resolve(0), stop: () => {} };
    };
    expect(await createSetup(f.deps).handle({ kind: "mic-check" }, () => {}, new Promise(() => {})))
      .toMatchObject({ kind: "mic-check-done", heard: null, silent: false, recognition: "waiting" });
    expect(f.calls.transcribed).toBe(0);
  });

  test("refused by the gate (conch speaking, the phone holding the audio), it opens nothing and says why", async () => {
    for (const [refused, reason] of [["conch is speaking", "speaking"], ["the phone has the audio", "elsewhere"], ["the mic is already open", "busy"]] as const) {
      let recorded = false;
      const f = fixture();
      f.deps.mic.hold = async () => ({ refused });
      f.deps.mic.record = () => { recorded = true; return { exited: Promise.resolve(0), stop: () => {} }; };
      const reply = await createSetup(f.deps).handle({ kind: "mic-check" }, () => {}, new Promise(() => {}));
      expect(reply).toEqual({ kind: "setup-error", ...micRefusal(refused) });
      expect((reply as { reason: string }).reason).toBe(reason);
      expect(recorded).toBe(false);
    }
  });

  test("speaking then a pause ends it early; the app going away stops the recorder and lets go of the mic", async () => {
    // Real time: sox writes as it hears, a voice then a second of quiet, and the check stops it rather than waiting out six.
    const f = fixture();
    let stopped = 0;
    f.deps.mic.record = (path) => {
      let done!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { done = resolve; });
      writeFileSync(path, wav([]).subarray(0, 44));
      const speech = wav([{ seconds: 0.5, amplitude: 0.3 }]).subarray(44);
      const quiet = wav([{ seconds: 0.1, amplitude: 0.001 }]).subarray(44);
      let written = 0;
      const timer = setInterval(() => {
        const chunk = written < 5 ? speech.subarray(written * 3200, (written + 1) * 3200) : quiet;
        written++;
        const bytes = new Uint8Array([...readFileSync(path), ...chunk]);
        writeFileSync(path, bytes);
      }, 100);
      return { exited, stop: () => { stopped++; clearInterval(timer); done(0); } };
    };
    const started = Date.now();
    const reply = await createSetup(f.deps).handle({ kind: "mic-check", seconds: 6 }, () => {}, new Promise(() => {}));
    expect(reply).toMatchObject({ kind: "mic-check-done", heard: "Testing, one, two, three." });
    expect(stopped).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(4_000);

    const g = fixture();
    let recorderStops = 0;
    g.deps.mic.record = () => ({ exited: new Promise(() => {}), stop: () => { recorderStops++; } });
    let leave!: () => void;
    const closed = new Promise<void>((resolve) => { leave = resolve; });
    const pending = createSetup(g.deps).handle({ kind: "mic-check" }, () => {}, closed);
    await Bun.sleep(80);
    leave();
    expect(await pending).toEqual({ kind: "setup-error", error: "The microphone check stopped.", reason: "cancelled" });
    expect(recorderStops).toBeGreaterThan(0);
    expect(g.calls.releases).toBe(1);
    expect(g.calls.transcribed).toBe(0);
  });
});

describe("over the control socket", () => {
  const servers: ControlServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  test("a streamed request's lines arrive before its reply, and a hook's event reaches setup", async () => {
    const root = mkdtempSync("/tmp/conch-setup-sock-");
    roots.push(root);
    const socketPath = join(root, "c.sock");
    const noted: string[] = [];
    const setup = {
      noteTurn: (event: { type: string }) => noted.push(event.type),
      status: async () => [],
      handle: async (_request: unknown, emit: (line: SetupLine) => void): Promise<SetupReply> => {
        emit({ kind: "mic-level", level: 0.1 });
        emit({ kind: "mic-level", level: 0.6 });
        return { kind: "mic-check-done", heard: "hello", silent: false, recognition: "ready", peak: 0.6 };
      },
    };
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: true, label: "a" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      setup,
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    const ask = (value: unknown) => new Promise<string[]>((resolve, reject) => {
      const socket = connect(socketPath);
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => { resolve(data.trim().split("\n")); socket.end(); });
      socket.on("error", reject);
      socket.write(JSON.stringify(value) + "\n");
    });
    expect((await ask({ kind: "mic-check" })).map((line) => JSON.parse(line))).toEqual([
      { kind: "mic-level", level: 0.1 },
      { kind: "mic-level", level: 0.6 },
      { kind: "mic-check-done", heard: "hello", silent: false, recognition: "ready", peak: 0.6 },
    ]);
    expect((await ask({ kind: "setup-connect", agent: "gemini" })).map((line) => JSON.parse(line))).toEqual([{ kind: "setup-error", error: "agent must be claude or codex" }]);
    await ask({ type: "turn-end", sessionId: "s1", label: "a", announce: "done" });
    expect(noted).toEqual(["turn-end"]);
  });
});
