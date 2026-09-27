import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSetup,
  installerSandboxRefusal,
  INSTALL_TIMEOUT_MS,
  loginShellHas,
  MIC_CHECK_STALE_MS,
  runInstallerInLoginShell,
  spawnInstaller,
  sweepStaleMicChecks,
  voiceSampleRefusal,
  type InstallerRun,
  type SetupDependencies,
  type SetupLine,
} from "../src/setup.ts";

// Setup's installers, its microphone check's recording and its voice sample (review 2026-09-28, D2, D3, D5, D6).
//
// No real installer and no login shell runs here, ever: an e2e once ran a real `brew install --cask codex` on Tyler's
// Mac, because a login shell reads /etc/zprofile and /etc/paths.d puts the real Homebrew first whatever PATH says. The
// installers below are /bin/sh scripts that start `sleep`s in a temp folder; the real runner and probe are only ever
// handed fakes, and the suite's own environment is checked to refuse them.

const roots: string[] = [];
const groups: number[] = [];
afterEach(() => {
  // Whatever a failed test left running: its whole group.
  for (const group of groups.splice(0)) {
    try { process.kill(-group, "SIGKILL"); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-installer-"));
  roots.push(root);
  return root;
}

async function until(what: string, condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Something is still in the process group. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in installer, shaped like `curl … | bash` stalled on the network: a line of output, a child that ignores
 * SIGTERM (as a stubborn `brew` can), and a pipeline that never ends, holding the pipes open.
 */
function stalledInstaller(dir: string): string[] {
  const script = join(dir, "install.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    'echo "==> Downloading"',
    `( trap '' TERM; exec /bin/sleep 600 ) &`,
    `echo $! > "${dir}/stubborn.pid"`,
    "/bin/sleep 600 | /bin/cat",
  ].join("\n") + "\n");
  chmodSync(script, 0o755);
  return ["/bin/sh", script];
}

/** Runs the stand-in, never the command it is handed, and remembers the group so a failure can't leave it running. */
function fakeRunner(argv: string[], graceMs = 200): SetupDependencies["runInstaller"] {
  return (_command, onOutput) => {
    const run = spawnInstaller(argv, onOutput, { graceMs });
    groups.push(run.pid);
    return run;
  };
}

function deps(over: Partial<SetupDependencies> = {}): SetupDependencies {
  const root = scratch();
  return {
    claudeDir: join(root, ".claude"),
    codexDir: join(root, ".codex"),
    configDir: join(root, "config"),
    home: root,
    tmpDir: root,
    now: Date.now,
    log: () => {},
    resolveAgents: async () => [],
    isConchHook: () => false,
    codexHooksWired: async () => false,
    pluginInstalled: () => false,
    backendOf: () => undefined,
    liveSessions: () => [],
    connectHooks: async () => ({ changed: false, file: "", backup: null }),
    installPlugin: async () => true,
    shellHas: async () => true,
    runInstaller: () => { throw new Error("no installer in this test"); },
    voices: () => ["af_heart", "bf_emma"],
    speak: async () => true,
    audioElsewhere: () => null,
    mic: {
      hold: async () => ({ release: () => {} }),
      record: () => ({ exited: Promise.resolve(0), stop: () => {} }),
      transcribe: async () => null,
      recognitionReady: () => true,
    },
    retry: () => false,
    ...over,
  };
}

const never = new Promise<void>(() => {});
const install = (setup: ReturnType<typeof createSetup>, closed: Promise<void> = never, lines: SetupLine[] = []) =>
  setup.handle({ kind: "setup-install", agent: "codex", via: "npm" }, (line) => lines.push(line), closed);

describe("never a real installer, or a login shell, from a conch with a stand-in home", () => {
  test("this suite runs with one, so the real runner and probe refuse here", () => {
    expect(installerSandboxRefusal()).not.toBeNull();
  });

  test("a stand-in home, or conch's tests: refused; the account's own home: allowed", () => {
    const home = scratch();
    const accountHome = () => home;
    expect(installerSandboxRefusal({ HOME: home }, accountHome)).toBeNull();
    expect(installerSandboxRefusal({ HOME: `${home}/` }, accountHome)).toBeNull();
    expect(installerSandboxRefusal({ HOME: home, CONCH_HOME: home }, accountHome)).toBeNull();
    expect(installerSandboxRefusal({ HOME: home, CONCH_HOME: join(home, "sandbox") }, accountHome)).toContain("CONCH_HOME");
    expect(installerSandboxRefusal({ HOME: join(home, "e2e-home") }, accountHome)).toContain("HOME");
    expect(installerSandboxRefusal({ HOME: home, CONCH_TEST_ROOT: home }, accountHome)).toBe("conch is running its tests");
  });

  test("the runner refuses before anything is spawned; given the account's home, it runs the command in a login shell", () => {
    const spawned: Array<{ argv: string[]; env?: Record<string, string | undefined> }> = [];
    const spy = ((argv: string[], _onOutput: unknown, options: { env?: Record<string, string | undefined> } = {}) => {
      spawned.push({ argv, env: options.env });
      return { pid: 0, exited: Promise.resolve(0), kill: () => {} };
    }) as typeof spawnInstaller;
    // The suite's own environment.
    expect(() => runInstallerInLoginShell("brew install --cask codex", () => {}, { spawn: spy })).toThrow("won't run a real installer");
    const home = scratch();
    expect(() => runInstallerInLoginShell("brew install --cask codex", () => {}, { spawn: spy, env: { HOME: join(home, "x") }, accountHome: () => home }))
      .toThrow("stand-in home");
    expect(spawned).toEqual([]);
    runInstallerInLoginShell("brew install --cask codex", () => {}, { spawn: spy, env: { HOME: home, PATH: "/usr/bin" }, accountHome: () => home });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.argv).toEqual(["/bin/zsh", "-lc", "brew install --cask codex"]);
    expect(spawned[0]!.env).toMatchObject({ HOME: home, NONINTERACTIVE: "1", HOMEBREW_NO_ENV_HINTS: "1" });
  });

  test("the login-shell probe answers no without a shell; given the account's home, it asks one", async () => {
    const asked: string[][] = [];
    const run = async (argv: string[]) => { asked.push(argv); return { code: 0, out: "/opt/homebrew/bin/brew\n" }; };
    expect(await loginShellHas("brew", { run })).toBe(false);
    expect(asked).toEqual([]);
    const home = scratch();
    expect(await loginShellHas("brew", { run, env: { HOME: home }, accountHome: () => home })).toBe(true);
    expect(asked).toEqual([["/bin/zsh", "-lc", "command -v brew"]]);
  });

  test("setup, handed the real runner here, says it couldn't start, and nothing ran", async () => {
    const logs: string[] = [];
    // The runner's own spawn is a spy even here: were the refusal ever broken, a spy is what would run, never a shell.
    const spawned: string[][] = [];
    const spy = ((argv: string[]) => { spawned.push(argv); return { pid: 0, exited: Promise.resolve(0), kill: () => {} }; }) as typeof spawnInstaller;
    const setup = createSetup(deps({
      runInstaller: (command, onOutput) => runInstallerInLoginShell(command, onOutput, { spawn: spy }),
      log: (line) => logs.push(line),
    }));
    expect(await install(setup)).toEqual({
      kind: "setup-error", agent: "codex", error: "The installer couldn't start.", command: "npm i -g @openai/codex",
    });
    expect(logs.join("\n")).toContain("won't run a real installer");
    expect(spawned).toEqual([]);
  });

  test("the daemon runs the real ones; no e2e script asks for an install", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    const wiring = daemon.slice(daemon.indexOf("const setup = createSetup({"), daemon.indexOf("practice = createPractice({"));
    expect(wiring).toContain("shellHas: loginShellHas,");
    expect(wiring).toContain("runInstaller: runInstallerInLoginShell,");
    for (const name of readdirSync(join(import.meta.dir, "..", "scripts")).filter((file) => file.endsWith(".ts"))) {
      const script = readFileSync(join(import.meta.dir, "..", "scripts", name), "utf8");
      expect(script, name).not.toMatch(/kind:\s*"setup-install"/);
    }
  });
});

describe("an installer is stopped whole, and answers on its own exit (D3)", () => {
  test("a stalled pipeline with a child that ignores SIGTERM: kill ends the whole group, SIGKILL after the grace", async () => {
    const dir = scratch();
    let output = "";
    const run = spawnInstaller(stalledInstaller(dir), (text) => { output += text; }, { graceMs: 200 });
    groups.push(run.pid);
    await until("the installer's first line", () => output.includes("==> Downloading") && existsSync(join(dir, "stubborn.pid")));
    const stubborn = Number(readFileSync(join(dir, "stubborn.pid"), "utf8"));
    expect(alive(stubborn)).toBe(true);
    const started = Date.now();
    run.kill();
    expect(await run.exited).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The SIGTERM-proof child goes at the grace's end, with the rest of its group.
    await until("the whole group gone", () => !groupAlive(run.pid), 5_000);
    expect(alive(stubborn)).toBe(false);
  });

  test("closing: the group goes at once, without the grace", async () => {
    const dir = scratch();
    const run = spawnInstaller(stalledInstaller(dir), () => {}, { graceMs: 60_000 });
    groups.push(run.pid);
    await until("the stubborn child", () => existsSync(join(dir, "stubborn.pid")));
    run.kill({ immediate: true });
    await run.exited;
    await until("the whole group gone", () => !groupAlive(run.pid), 2_000);
  });

  test("an installer that exits leaving a child holding its output answers at once", async () => {
    const dir = scratch();
    const script = join(dir, "install.sh");
    writeFileSync(script, "#!/bin/sh\n/bin/sleep 600 &\necho installed\nexit 0\n");
    let output = "";
    const run = spawnInstaller(["/bin/sh", script], (text) => { output += text; });
    groups.push(run.pid);
    const started = Date.now();
    expect(await run.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(output).toContain("installed");
  });

  test("the timeout stops it, says so with the command, and the next install can run", async () => {
    const dir = scratch();
    const setup = createSetup(deps({ runInstaller: fakeRunner(stalledInstaller(dir)), installTimeoutMs: 300 }));
    const lines: SetupLine[] = [];
    const reply = await install(setup, never, lines);
    expect(reply).toMatchObject({ kind: "setup-error", agent: "codex", reason: "timeout", command: "npm i -g @openai/codex" });
    expect((reply as { error: string }).error).toContain(`${INSTALL_TIMEOUT_MS / 60_000} minutes`);
    expect(lines).toContainEqual({ kind: "setup-install-line", agent: "codex", line: "==> Downloading" });
    await until("the whole group gone", () => groups.every((group) => !groupAlive(group)), 5_000);
    // Not "already installing": the flag went with it, and the next install runs (and is stopped in its turn).
    expect(await install(setup, never)).toMatchObject({ reason: "timeout" });
  });

  test("the app that asked goes away: the installer is stopped, whole", async () => {
    const dir = scratch();
    const setup = createSetup(deps({ runInstaller: fakeRunner(stalledInstaller(dir)) }));
    let leave!: () => void;
    const closed = new Promise<void>((resolve) => { leave = resolve; });
    const pending = install(setup, closed);
    await until("the stubborn child", () => existsSync(join(dir, "stubborn.pid")));
    leave();
    expect(await pending).toMatchObject({ kind: "setup-error", reason: "cancelled", error: "The install was stopped." });
    await until("the whole group gone", () => groups.every((group) => !groupAlive(group)), 5_000);
  });

  test("conch closing: every installer is stopped at once, and a new install is refused", async () => {
    const dir = scratch();
    const setup = createSetup(deps({ runInstaller: fakeRunner(stalledInstaller(dir), 60_000) }));
    const pending = install(setup);
    await until("the stubborn child", () => existsSync(join(dir, "stubborn.pid")));
    setup.close();
    expect(await pending).toMatchObject({ kind: "setup-error", reason: "closing" });
    await until("the whole group gone", () => groups.every((group) => !groupAlive(group)), 2_000);
    expect(await install(setup)).toEqual({ kind: "setup-error", agent: "codex", error: "conch is closing." });
  });

  test("an installer that won't exit even once stopped is let go of: \"already installing\" can't stick", async () => {
    const kills: Array<{ immediate?: boolean } | undefined> = [];
    const stuck: InstallerRun = { exited: new Promise(() => {}), kill: (options) => void kills.push(options) };
    let runs = 0;
    const setup = createSetup(deps({
      runInstaller: () => { runs++; return stuck; },
      installTimeoutMs: 50,
      installerStopWaitMs: 50,
    }));
    expect(await install(setup)).toMatchObject({ reason: "timeout" });
    expect(kills).toEqual([{ immediate: false }]);
    expect(await install(setup)).toMatchObject({ reason: "timeout" });
    expect(runs).toBe(2);
  });

  test("once answered, the request's socket closing (as it does after every reply) signals nothing", async () => {
    const kills: unknown[] = [];
    let leave!: () => void;
    const closed = new Promise<void>((resolve) => { leave = resolve; });
    const setup = createSetup(deps({ runInstaller: () => ({ exited: Promise.resolve(0), kill: (options) => void kills.push(options) }) }));
    expect(await install(setup, closed)).toEqual({ kind: "setup-installed", agent: "codex" });
    leave();
    await Bun.sleep(10);
    setup.close();
    expect(kills).toEqual([]);
  });

  test("a stop that crosses a finished install doesn't undo it", async () => {
    let leave!: () => void;
    const closed = new Promise<void>((resolve) => { leave = resolve; });
    let finish!: (code: number) => void;
    const setup = createSetup(deps({
      runInstaller: () => ({ exited: new Promise((resolve) => { finish = resolve; }), kill: () => {} }),
    }));
    const pending = install(setup, closed);
    await until("the installer", () => finish !== undefined);
    finish(0);
    leave();
    expect(await pending).toEqual({ kind: "setup-installed", agent: "codex" });
  });
});

describe("one install at a time, claimed before anything is awaited (D2)", () => {
  test("a double click: the second is refused while the first's login shells are still answering", async () => {
    let installers = 0;
    let finish!: (code: number) => void;
    const setup = createSetup(deps({
      // A login shell takes a moment to answer, as a real one does.
      shellHas: async () => { await Bun.sleep(30); return true; },
      runInstaller: () => {
        installers++;
        return { exited: new Promise((resolve) => { finish = resolve; }), kill: () => {} };
      },
    }));
    const first = install(setup);
    const second = install(setup);
    expect(await second).toEqual({ kind: "setup-error", agent: "codex", error: "Codex is already installing." });
    await until("the first installer", () => installers === 1);
    finish(0);
    expect(await first).toEqual({ kind: "setup-installed", agent: "codex" });
    expect(installers).toBe(1);
    // Done: the next one runs.
    const third = install(setup);
    await until("the next installer", () => installers === 2);
    finish(0);
    expect(await third).toEqual({ kind: "setup-installed", agent: "codex" });
  });

  test("a login shell that never answers: the app going away still ends the request, and lets go of the claim", async () => {
    let leave!: () => void;
    const closed = new Promise<void>((resolve) => { leave = resolve; });
    let installers = 0;
    const setup = createSetup(deps({
      shellHas: () => new Promise(() => {}),
      runInstaller: () => { installers++; return { exited: Promise.resolve(0), kill: () => {} }; },
    }));
    const pending = install(setup, closed);
    await Bun.sleep(20);
    expect(await install(setup)).toMatchObject({ error: "Codex is already installing." });
    leave();
    expect(await pending).toMatchObject({ kind: "setup-error", reason: "cancelled" });
    expect(installers).toBe(0);
  });

  test("each agent has its own claim", async () => {
    const finishes: Array<(code: number) => void> = [];
    const setup = createSetup(deps({ runInstaller: () => ({ exited: new Promise((resolve) => void finishes.push(resolve)), kill: () => {} }) }));
    const codex = install(setup);
    const claude = setup.handle({ kind: "setup-install", agent: "claude" }, () => {}, never);
    await until("both installers", () => finishes.length === 2);
    for (const finish of finishes) finish(0);
    expect(await codex).toEqual({ kind: "setup-installed", agent: "codex" });
    expect(await claude).toEqual({ kind: "setup-installed", agent: "claude" });
  });
});

describe("the microphone check's recording never outlives it (D5)", () => {
  test("a throw part way through the check: the recording is removed and the microphone let go", async () => {
    let released = 0;
    let wav = "";
    const d = deps();
    d.mic.hold = async () => ({ release: () => { released++; } });
    d.mic.record = (path) => {
      wav = path;
      // A header and a second of sound: the check reads levels from it as sox writes.
      const pcm = new Uint8Array(44 + 32_000);
      pcm.set(new TextEncoder().encode("RIFF"), 0);
      pcm.set(new TextEncoder().encode("data"), 36);
      writeFileSync(path, pcm);
      return { exited: new Promise(() => {}), stop: () => {} };
    };
    const setup = createSetup(d);
    // The socket the levels stream to breaks mid-check.
    const emit = () => { throw new Error("socket gone"); };
    await expect(setup.handle({ kind: "mic-check", seconds: 1 }, emit, never)).rejects.toThrow("socket gone");
    expect(wav).toContain("conch-mic-check-");
    expect(existsSync(wav)).toBe(false);
    expect(released).toBe(1);
  });

  test("an earlier daemon's recordings are swept at start: only the check's own name, only stale, only a gone daemon's", async () => {
    const dir = scratch();
    const old = (Date.now() - MIC_CHECK_STALE_MS - 5_000) / 1000;
    // A pid that was, and is no more.
    const gone = Bun.spawn(["/usr/bin/true"]);
    await gone.exited;
    const stale = `conch-mic-check-${gone.pid}-1700000000000.wav`;
    const young = `conch-mic-check-${gone.pid}-1700000000001.wav`;
    const running = `conch-mic-check-${process.ppid}-1700000000002.wav`;
    const mine = `conch-mic-check-${process.pid}-1700000000003.wav`;
    // Near misses, from the same gone daemon and just as old: not the check's name, so never touched.
    const others = ["conch-mic-check-x.wav", `conch-mic-check-${gone.pid}-2.wav.part`, "notes.wav", `conch-mic-check-${gone.pid}-2.WAV`,
      `x-conch-mic-check-${gone.pid}-2.wav`];
    for (const name of [stale, young, running, mine, ...others]) writeFileSync(join(dir, name), "RIFF");
    for (const name of [stale, running, mine, ...others]) utimesSync(join(dir, name), old, old);
    // A link named like one, pointing out of the folder: never followed, never removed.
    const elsewhere = join(scratch(), "keep.wav");
    writeFileSync(elsewhere, "keep");
    utimesSync(elsewhere, old, old);
    const link = `conch-mic-check-${gone.pid}-1700000000004.wav`;
    symlinkSync(elsewhere, join(dir, link));
    const folder = join(dir, `conch-mic-check-${gone.pid}-1700000000005.wav`);
    mkdirSync(folder);
    utimesSync(folder, old, old);
    const logs: string[] = [];
    createSetup(deps({ tmpDir: dir, log: (line) => logs.push(line) }));
    const left = readdirSync(dir).sort();
    expect(left).not.toContain(stale);
    expect(left).not.toContain(mine);
    expect(left).toEqual([young, running, ...others, link, folder.slice(dir.length + 1)].sort());
    expect(readFileSync(elsewhere, "utf8")).toBe("keep");
    expect(logs).toContain("setup: removed 2 microphone check recordings an earlier conch left");
    // A minute on, the young one is stale too; the live daemon's is still its own.
    expect(sweepStaleMicChecks(dir, Date.now() + MIC_CHECK_STALE_MS * 10, (pid) => pid !== gone.pid)).toEqual([young]);
    expect(readdirSync(dir)).toContain(running);
  });
});

describe("a voice sample where this Mac doesn't have the audio (D6)", () => {
  test("the phone, or another Mac: refused in the check's and the practice's words, and nothing is spoken", async () => {
    for (const where of ["phone", "another-mac"] as const) {
      const spoken: string[] = [];
      const setup = createSetup(deps({ audioElsewhere: () => where, speak: async (voice) => { spoken.push(voice); return true; } }));
      const reply = await setup.handle({ kind: "voice-sample", voice: "Emma" }, () => {}, never);
      expect(reply).toEqual({ kind: "setup-error", ...voiceSampleRefusal(where) });
      expect((reply as { reason: string }).reason).toBe("elsewhere");
      expect(spoken).toEqual([]);
    }
    expect(voiceSampleRefusal("phone").error).toStartWith("Your iPhone has conch's audio right now. Hand it back to this Mac");
    expect(voiceSampleRefusal("another-mac").error).toStartWith("Another Mac has conch's audio right now. Hand it back");
  });

  test("the audio moving away while the sample waited its turn: not done, it's where the audio went", async () => {
    let where: "phone" | null = null;
    const setup = createSetup(deps({
      audioElsewhere: () => where,
      speak: async () => { where = "phone"; return true; },
    }));
    expect(await setup.handle({ kind: "voice-sample", voice: "Emma" }, () => {}, never))
      .toEqual({ kind: "setup-error", ...voiceSampleRefusal("phone") });
  });

  test("here: spoken, and done", async () => {
    const setup = createSetup(deps());
    expect(await setup.handle({ kind: "voice-sample", voice: "Emma" }, () => {}, never)).toEqual({ kind: "voice-sample-done", voice: "Emma" });
  });

  test("the daemon's sample sends nothing to the phone or another Mac, and says where the audio is", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    const wiring = daemon.slice(daemon.indexOf("const setup = createSetup({"), daemon.indexOf("practice = createPractice({"));
    const speak = wiring.slice(wiring.indexOf("speak: (voiceId, text) => eventQueue.exclusive(() => (audioLease.isPhone() || !audioHolder.isLocal()"), wiring.indexOf("audioElsewhere:"));
    expect(speak).toContain("? Promise.resolve()");
    expect(speak.indexOf("? Promise.resolve()")).toBeLessThan(speak.indexOf(': voice.speak({ ...cfg, ttsVoices: [voiceId] }, text, "", true)'));
    expect(wiring).toContain('audioElsewhere: () => (audioLease.isPhone() ? "phone" : audioHolder.isLocal() ? null : "another-mac"),');
  });
});

describe("conch closing stops setup's installers", () => {
  test("the daemon's shutdown closes setup", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    const shutdown = daemon.slice(daemon.indexOf("const shutdown = async (): Promise<void> => {"), daemon.indexOf("process.exit(0);"));
    expect(shutdown).toContain("setup.close();");
  });
});

