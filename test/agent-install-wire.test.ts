import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchRuntimeControlMessage } from "../src/daemon.ts";
import { readAgentCapabilities } from "../src/agent-capabilities.ts";
import { validateControlResponse } from "../src/settings.ts";
import type { AgentInstall } from "../src/agent-install.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const install: AgentInstall = {
  backend: "claude",
  executable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.266/claude",
  version: "2.1.266",
  location: "homebrew-cask",
  packageId: "claude-code@latest",
  updateCommand: "brew upgrade --cask --greedy claude-code@latest",
  behind: true,
  newerVersion: "2.1.280",
};

function inventory() {
  return readAgentCapabilities({
    backend: "claude" as const,
    cwd: "/tmp/conch",
    configDir: "/tmp/isolated-conch-config",
  });
}

describe("agent-capabilities carries an optional install alongside the inventory", () => {
  test("dispatch merges what readInstall answers", async () => {
    const result = await dispatchRuntimeControlMessage(
      { kind: "agent-capabilities", backend: "claude", cwd: "/tmp/conch", sessionId: "s1" },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        readCapabilities: () => inventory(),
        readInstall: (message) => {
          expect(message.sessionId).toBe("s1");
          return install;
        },
        start: () => {},
        close: () => {},
        report: () => {},
      },
    );
    expect(result).toEqual({
      handled: true,
      response: { kind: "agent-capabilities", inventory: inventory(), install },
    });
  });

  test("no readInstall, or an undefined answer, leaves the field off entirely — never a fabricated one", async () => {
    const withoutHandler = await dispatchRuntimeControlMessage(
      { kind: "agent-capabilities", backend: "claude", cwd: "/tmp/conch" },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        readCapabilities: () => inventory(),
        start: () => {},
        close: () => {},
        report: () => {},
      },
    );
    expect(withoutHandler).toEqual({ handled: true, response: { kind: "agent-capabilities", inventory: inventory() } });
    expect("install" in (withoutHandler as { response: object }).response).toBe(false);

    const undefinedAnswer = await dispatchRuntimeControlMessage(
      { kind: "agent-capabilities", backend: "claude", cwd: "/tmp/conch" },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        readCapabilities: () => inventory(),
        readInstall: () => undefined, // no processIdentity for this session — say nothing, not "unknown"
        start: () => {},
        close: () => {},
        report: () => {},
      },
    );
    expect("install" in (undefinedAnswer as { response: object }).response).toBe(false);
  });

  test("the wire validator accepts a well-formed install and rejects a malformed one", () => {
    expect(validateControlResponse({ kind: "agent-capabilities", inventory: inventory(), install }).ok).toBe(true);
    expect(validateControlResponse({
      kind: "agent-capabilities",
      inventory: inventory(),
      install: { ...install, location: "app-store" },
    }).ok).toBe(false);
    expect(validateControlResponse({
      kind: "agent-capabilities",
      inventory: inventory(),
      install: { ...install, behind: "yes" },
    }).ok).toBe(false);
    // Still fine with no install at all — most existing daemons will not send one.
    expect(validateControlResponse({ kind: "agent-capabilities", inventory: inventory() }).ok).toBe(true);
  });
});

describe("the daemon reads the LIVE session's own process identity, never a claimed one", () => {
  test("readInstall is wired beside readCapabilities, keyed off panelSessions' captured executable", () => {
    const daemon = read("src/daemon.ts");
    const at = daemon.indexOf("readInstall: async (message) => {");
    expect(at).toBeGreaterThan(-1);
    const body = daemon.slice(at, daemon.indexOf("start: (message) => startTerminalSession({", at));
    expect(body.length).toBeGreaterThan(200);
    // The executable comes from THIS session's own captured process identity —
    // never the requested backend alone, which a hostile or stale request could lie about.
    expect(body).toContain("panelSessions.get(message.sessionId)?.processIdentity?.executable");
    expect(body).toContain("if (!executable) return undefined;");
    // Peers are every OTHER live session's own captured identity, not a config file or a network call.
    expect(body).toContain("[...panelSessions.values()]");
    expect(body).toContain("candidate.processIdentity?.executable");
    expect(body).toContain("resolveAgentInstall({ backend: message.backend, executable }, peers, installVersionCache)");
    // The cache lives for the daemon's process lifetime, shared across every request.
    expect(daemon).toContain("const installVersionCache = new Map<string, string | null>();");
  });

  test("control-server merges readInstall's answer onto the capability response, never overriding readCapabilities", () => {
    const server = read("src/control-server.ts");
    const at = server.indexOf('if (message.kind === "agent-capabilities") {');
    expect(at).toBeGreaterThan(-1);
    const body = server.slice(at, server.indexOf("if (message.kind ===", at + 10));
    expect(body).toContain("const inventory = await options.readCapabilities(message);");
    expect(body).toContain("const install = await options.readInstall?.(message);");
    expect(body).toContain("...(install ? { install } : {}),");
  });
});
