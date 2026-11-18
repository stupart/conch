import { describe, expect, test } from "bun:test";
import { dispatchRuntimeControlMessage } from "../src/daemon.ts";
import { readAgentCapabilities } from "../src/agent-capabilities.ts";
import { validateControlResponse } from "../src/settings.ts";
import type { AgentInstall } from "../src/agent-install.ts";

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

// Read once: it stamps `readAt: Date.now()`, so two reads a millisecond apart
// never compare equal (a 1-in-8 flake before this).
const INVENTORY = readAgentCapabilities({
  backend: "claude" as const,
  cwd: "/tmp/conch",
  configDir: "/tmp/isolated-conch-config",
});
function inventory() {
  return INVENTORY;
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
