import { describe, expect, test } from "bun:test";
import {
  describeInstallLocation,
  extractVersion,
  installUpdateCommand,
  isAgentInstall,
  resolveAgentInstall,
  type AgentInstall,
} from "../src/agent-install.ts";

describe("where a binary lives, from its path alone", () => {
  test("Homebrew cask — the measured Mac's cask install", () => {
    expect(describeInstallLocation("/opt/homebrew/Caskroom/claude-code@latest/2.1.266/claude")).toEqual({
      kind: "homebrew-cask",
      packageId: "claude-code@latest",
    });
  });

  test("the Claude desktop app's bundled copy — the measured Mac's other install", () => {
    expect(describeInstallLocation(
      "/Users/x/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude",
    )).toEqual({ kind: "claude-desktop-app" });
  });

  test("npm global, including a scoped package name", () => {
    expect(describeInstallLocation("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toEqual({
      kind: "npm-global",
      packageId: "@anthropic-ai/claude-code",
    });
    expect(describeInstallLocation("/usr/local/lib/node_modules/codex-cli/bin/codex")).toEqual({
      kind: "npm-global",
      packageId: "codex-cli",
    });
  });

  test("anything else is 'other' — never guessed into one of the known kinds", () => {
    expect(describeInstallLocation("/usr/local/bin/claude")).toEqual({ kind: "other" });
    expect(describeInstallLocation("/Users/x/dev/conch/.worktrees/foo/bin/claude")).toEqual({ kind: "other" });
  });

  test("a Caskroom path wins over an .app pattern it happens to contain", () => {
    // A cask can itself install a .app bundle; the more specific, more
    // actionable signal (what `brew` would name) must not lose to the vaguer one.
    expect(describeInstallLocation("/opt/homebrew/Caskroom/some-app/1.0/SomeApp.app/Contents/MacOS/some-app")).toEqual({
      kind: "homebrew-cask",
      packageId: "some-app",
    });
  });
});

describe("the command that would update THAT install", () => {
  test("Caskroom → brew upgrade --cask --greedy <cask>", () => {
    expect(installUpdateCommand({ kind: "homebrew-cask", packageId: "claude-code@latest" }))
      .toBe("brew upgrade --cask --greedy claude-code@latest");
  });

  test("npm → npm i -g <pkg>", () => {
    expect(installUpdateCommand({ kind: "npm-global", packageId: "@anthropic-ai/claude-code" }))
      .toBe("npm i -g @anthropic-ai/claude-code");
  });

  test("the desktop app bundle and 'other' get no command — wrong advice is worse than none", () => {
    expect(installUpdateCommand({ kind: "claude-desktop-app" })).toBeNull();
    expect(installUpdateCommand({ kind: "other" })).toBeNull();
  });
});

describe("pulling a version out of --version output", () => {
  test("free-form CLI banners", () => {
    expect(extractVersion("2.1.266 (Claude Code)")).toBe("2.1.266");
    expect(extractVersion("codex-cli 0.5.2\n")).toBe("0.5.2");
    expect(extractVersion("no version here")).toBeNull();
    expect(extractVersion("")).toBeNull();
  });
});

describe("resolveAgentInstall: behind, decided locally, never guessed", () => {
  const cask = { backend: "claude" as const, executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.266/claude" };
  const desktop = {
    backend: "claude" as const,
    executable: "/Users/x/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude",
  };

  function fakeReader(versions: Record<string, string | null>) {
    const calls: string[] = [];
    const read = async (executable: string) => {
      calls.push(executable);
      return versions[executable] ?? null;
    };
    return { read, calls };
  }

  test("behind when a peer of the SAME agent is newer", async () => {
    const { read } = fakeReader({ [cask.executable]: "2.1.266", [desktop.executable]: "2.1.280" });
    const install = await resolveAgentInstall(cask, [desktop], new Map(), read);
    expect(install).toEqual({
      backend: "claude",
      executable: cask.executable,
      version: "2.1.266",
      location: "homebrew-cask",
      packageId: "claude-code@latest",
      updateCommand: "brew upgrade --cask --greedy claude-code@latest",
      behind: true,
      newerVersion: "2.1.280",
    });
  });

  test("the newer install is not behind its own older peer", async () => {
    const { read } = fakeReader({ [cask.executable]: "2.1.266", [desktop.executable]: "2.1.280" });
    const install = await resolveAgentInstall(desktop, [cask], new Map(), read);
    expect(install.behind).toBe(false);
    expect(install.newerVersion).toBeUndefined();
    expect(install.updateCommand).toBeNull(); // desktop app: updates with the app
  });

  test("a different agent's version never counts as a peer", async () => {
    const codexPeer = { backend: "codex" as const, executable: "/opt/homebrew/Caskroom/codex@latest/9.9.9/codex" };
    const { read, calls } = fakeReader({ [cask.executable]: "2.1.266", [codexPeer.executable]: "9.9.9" });
    const install = await resolveAgentInstall(cask, [codexPeer], new Map(), read);
    expect(install.behind).toBe(false);
    // The codex peer's version was never even worth resolving.
    expect(calls).toEqual([cask.executable]);
  });

  test("never claims behind when either side's version is unknown", async () => {
    const { read: unknownSelf } = fakeReader({ [desktop.executable]: "2.1.280" });
    expect((await resolveAgentInstall(cask, [desktop], new Map(), unknownSelf)).behind).toBe(false);

    const { read: unknownPeer } = fakeReader({ [cask.executable]: "2.1.266" });
    expect((await resolveAgentInstall(cask, [desktop], new Map(), unknownPeer)).behind).toBe(false);
  });

  test("equal versions across installs are never 'behind' each other", async () => {
    const otherCask = { backend: "claude" as const, executable: "/opt/homebrew/Caskroom/claude-code/2.1.266/claude" };
    const { read } = fakeReader({ [cask.executable]: "2.1.266", [otherCask.executable]: "2.1.266" });
    expect((await resolveAgentInstall(cask, [otherCask], new Map(), read)).behind).toBe(false);
  });

  test("a shared cache is spent once per distinct executable, never once per call", async () => {
    const { read, calls } = fakeReader({ [cask.executable]: "2.1.266", [desktop.executable]: "2.1.280" });
    const cache = new Map<string, string | null>();
    await resolveAgentInstall(cask, [desktop], cache, read);
    await resolveAgentInstall(cask, [desktop], cache, read);
    await resolveAgentInstall(desktop, [cask], cache, read);
    expect(calls.sort()).toEqual([cask.executable, desktop.executable].sort());
  });
});

describe("isAgentInstall: the wire guard", () => {
  const valid: AgentInstall = {
    backend: "claude",
    executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.266/claude",
    version: "2.1.266",
    location: "homebrew-cask",
    packageId: "claude-code@latest",
    updateCommand: "brew upgrade --cask --greedy claude-code@latest",
    behind: true,
    newerVersion: "2.1.280",
  };

  test("accepts a well-formed install, with or without the optional fields", () => {
    expect(isAgentInstall(valid)).toBe(true);
    expect(isAgentInstall({
      backend: "codex",
      executable: "/usr/local/bin/codex",
      version: null,
      location: "other",
      updateCommand: null,
      behind: false,
    })).toBe(true);
  });

  test("rejects a bad backend, an unknown location kind, and a wrong-typed field", () => {
    expect(isAgentInstall({ ...valid, backend: "gpt" })).toBe(false);
    expect(isAgentInstall({ ...valid, location: "app-store" })).toBe(false);
    expect(isAgentInstall({ ...valid, behind: "yes" })).toBe(false);
    expect(isAgentInstall({ ...valid, version: 2.1266 })).toBe(false);
    expect(isAgentInstall(null)).toBe(false);
    expect(isAgentInstall("nope")).toBe(false);
  });
});
