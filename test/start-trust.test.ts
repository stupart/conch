import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuntimeControlMessage, sessionStartLine, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { acceptBackgroundTrust, backgroundTrustReport, startBackgroundProcess } from "../src/background-sessions.ts";
import { acceptClaudeTrust, sessionFolder, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";
import { helpSessionDir } from "../src/help-session.ts";
import { conchHome } from "../src/home.ts";
import { shellQuote } from "../src/agent-adapter.ts";
import { probeCommand } from "../src/probe.ts";
import { paneTarget, resolveTmux } from "../src/tmux-binary.ts";

/**
 * 2026-10-05, Tyler: "trying to start a new session (background session with claude account) and it didn't start …
 * and the modal didn't close". A background Claude session from the phone, folder field blank, sat on Claude's
 * "Quick safety check … Yes, I trust this folder" in the home folder: the daemon asked about a folder only when the
 * start named one, so it asked nothing and had no yes to type.
 */
type Start = Extract<Parameters<typeof applyRuntimeControlMessage>[0], { kind: "session-start" }>;

function gate(trusted: (cwd: string) => boolean | null) {
  const started: Start[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const options = {
    listResumable: () => ({ sessions: [], complete: true }),
    close: () => {},
    report: () => {},
    folderTrusted: (_backend: string, cwd: string) => { asked.push(cwd); return trusted(cwd); },
    start: (message: Start) => { started.push(message); return message.host === "background" ? { backgroundId: "conch-00000000-0000-4000-8000-000000000000" } : undefined; },
    log: (line: string) => lines.push(line),
  } as unknown as RuntimeControlDispatchOptions;
  return { options, started, asked, lines };
}

describe("the trust question is about the folder the session will run in", () => {
  test("a start naming no folder is asked about the Mac's home, which is where it runs", async () => {
    for (const host of ["background", "terminal"] as const) {
      const g = gate(() => false);
      const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", host, claudeAccountId: "work" }, g.options);
      expect(reply).toEqual({ kind: "session-needs-trust", backend: "claude", cwd: conchHome() });
      expect(g.asked).toEqual([conchHome()]);
      expect(g.started).toEqual([]);
    }
    // A non-default account's trust can't be read beforehand (null): a background start asks anyway, as with a folder.
    const unknown = gate(() => null);
    expect(await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", host: "background", claudeAccountId: "work" }, unknown.options))
      .toEqual({ kind: "session-needs-trust", backend: "claude", cwd: conchHome() });
  });

  test("the launch runs in that same folder", () => {
    expect(sessionFolder({})).toBe(conchHome());
    expect(sessionFolder({ cwd: "   " })).toBe(conchHome());
    expect(sessionFolder({ cwd: " /tmp/p " })).toBe("/tmp/p");
    expect(terminalSessionCommand({ backend: "claude", host: "background" })).toStartWith(`cd -- ${shellQuote(conchHome())} && `);
  });

  test("a yes with no folder named is a yes for the default folder: it starts, and the launch carries it there", async () => {
    const g = gate(() => false);
    const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", host: "background", claudeAccountId: "work", trustFolder: true }, g.options);
    expect(reply).toMatchObject({ kind: "session-started", backend: "claude", backgroundId: expect.any(String) });
    expect(g.started).toEqual([{ kind: "session-start", backend: "claude", host: "background", claudeAccountId: "work", trustFolder: true }]);
    // Codex takes its answer at launch, as a flag naming the folder: the default one, though none was sent.
    expect(terminalSessionCommand({ backend: "codex", trustFolder: true }))
      .toContain(shellQuote(`projects."${conchHome()}".trust_level="trusted"`));
  });

  test("a trusted default folder starts without asking", async () => {
    const g = gate(() => true);
    expect(await applyRuntimeControlMessage({ kind: "session-start", backend: "claude" }, g.options)).toMatchObject({ kind: "session-started" });
    expect(g.started).toHaveLength(1);
  });

  test("Help with conch from the phone names no folder: it is asked about conch's own, and its yes is taken", async () => {
    const wire = { kind: "session-start", backend: "claude", host: "background", help: true };
    const first = validateRuntimeControlMessage(wire);
    if (!first.ok) throw new Error(first.err);
    const g = gate(() => false);
    expect(await applyRuntimeControlMessage(first.value as Start, g.options))
      .toEqual({ kind: "session-needs-trust", backend: "claude", cwd: helpSessionDir() });
    expect(g.started).toEqual([]);
    // The phone's yes: the same request plus trustFolder, still naming no folder (help can't name one).
    const again = validateRuntimeControlMessage({ ...wire, trustFolder: true });
    if (!again.ok) throw new Error(again.err);
    expect(await applyRuntimeControlMessage(again.value as Start, g.options)).toMatchObject({ kind: "session-started" });
    expect(g.started).toEqual([{ kind: "session-start", host: "background", backend: "claude", trustFolder: true, cwd: helpSessionDir() }]);
  });

  test("every start is one log line: agent, host, account id, the yes, and only the folder's last part", async () => {
    const g = gate(() => false);
    await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", host: "background", claudeAccountId: "work", cwd: "/Users/t/secret/project" }, g.options);
    await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", host: "background", claudeAccountId: "work", cwd: "/Users/t/secret/project", trustFolder: true }, g.options);
    expect(g.lines).toEqual([
      "session-start: claude background account=work trustFolder=no folder=project — asking whether to trust it first",
      "session-start: claude background account=work trustFolder=yes folder=project",
    ]);
    expect(sessionStartLine({ kind: "session-start", backend: "codex", resumeSessionId: "t-1" }, "/", false))
      .toBe("session-start: codex terminal resume account=default trustFolder=no folder=/");
  });

  test("only a yes never typed into a session still there is filed as an error", () => {
    const name = "conch-00000000-0000-4000-8000-000000000000";
    expect(backgroundTrustReport(name, "answered")).toEqual({ line: `trust prompt in ${name}: answered` });
    expect(backgroundTrustReport(name, "not asked").error).toBeUndefined();
    expect(backgroundTrustReport(name, "the session ended").error).toBeUndefined();
    expect(backgroundTrustReport(name, "never appeared").error).toContain("open its startup terminal");
  });
});

describe("the Terminal path's typed yes", () => {
  test("a tab it couldn't read is looked at again, and the prompt behind it is answered", async () => {
    const trust = " ❯ No, exit\n   Yes, I trust this folder\n";
    const reads: (string | null)[] = [null, null, trust];
    let pressed = 0;
    const outcome = await acceptClaudeTrust("ttys012", {
      read: async () => (pressed ? "─────\n❯ \n─────" : reads.length > 1 ? reads.shift()! : reads[0]!),
      press: async () => { pressed += 1; return true; },
      sleep: async () => {},
      waitMs: 4_000,
    });
    expect(outcome).toBe("accepted");
    expect(pressed).toBe(1);
  });

  test("waits a minute by default, as a background session does", () => {
    const source = readFileSync(join(import.meta.dir, "../src/session-lifecycle.ts"), "utf8");
    expect(source).toContain("waited < (dependencies.waitMs ?? 60_000)");
  });
});

// For real, on the suite's own tmux server (`CONCH_TMUX_SOCKET`, test/preload.ts), against a stand-in for Claude's
// trust prompt (fixtures/fake-claude-trust.ts) that takes Down/Up/Enter as Claude does and writes what it was told.
const tmux = resolveTmux().found;
const fixture = join(import.meta.dir, "fixtures", "fake-claude-trust.ts");

async function fakeClaude(delayMs: number): Promise<{ pane: string; out: string }> {
  const out = join(mkdtempSync(join(tmpdir(), "trust-")), "answer");
  const { pane } = await startBackgroundProcess(`exec ${shellQuote(process.execPath)} ${shellQuote(fixture)} ${shellQuote(out)} ${delayMs}`, tmpdir());
  return { pane, out };
}

async function answerIn(out: string): Promise<string> {
  for (let tries = 0; tries < 40; tries++) {
    try {
      const text = readFileSync(out, "utf8").trim();
      if (text) return text;
    } catch {}
    await Bun.sleep(100);
  }
  return "";
}

async function screenOf(pane: string): Promise<string> {
  const target = paneTarget(pane)!;
  return (await probeCommand([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0])) ?? "";
}

describe.skipIf(!tmux)("typing the yes into a background session's trust prompt", () => {
  test("answered when the prompt is already showing", async () => {
    const { pane, out } = await fakeClaude(0);
    for (let tries = 0; tries < 50 && !(await screenOf(pane)).includes("Yes, I trust this folder"); tries++) await Bun.sleep(100);
    expect(await acceptBackgroundTrust(pane)).toBe("answered");
    expect(await answerIn(out)).toBe("trusted");
  }, 15_000);

  test("answered when the prompt is drawn late", async () => {
    const { pane, out } = await fakeClaude(1_500);
    const began = Date.now();
    expect(await acceptBackgroundTrust(pane)).toBe("answered");
    expect(Date.now() - began).toBeGreaterThan(1_000);
    expect(await answerIn(out)).toBe("trusted");
  }, 15_000);

  test("a capture that fails is looked at again, not taken as the end", async () => {
    const { pane, out } = await fakeClaude(300);
    let failed = 0;
    const flaky: typeof probeCommand = async (argv, ok, timeoutMs) => {
      if (argv.includes("capture-pane") && failed === 0) { failed += 1; return null; }
      return probeCommand(argv, ok, timeoutMs);
    };
    expect(await acceptBackgroundTrust(pane, flaky)).toBe("answered");
    expect(failed).toBe(1);
    expect(await answerIn(out)).toBe("trusted");
  }, 15_000);

  test("a prompt that never comes is reported as never appeared, the session still there", async () => {
    const { pane, out } = await fakeClaude(60_000);
    expect(await acceptBackgroundTrust(pane, probeCommand, { waitMs: 800 })).toBe("never appeared");
    expect(existsSync(out)).toBe(false);
  }, 15_000);

  test("a session whose process exits is reported as ended", async () => {
    const { pane } = await startBackgroundProcess("sleep 0.8", tmpdir());
    expect(await acceptBackgroundTrust(pane, probeCommand, { waitMs: 10_000 })).toBe("the session ended");
  }, 15_000);

  test("a session at its input box without asking is left alone", async () => {
    const { pane } = await startBackgroundProcess(`printf '%s\\n' '──────────' '❯ ' '──────────'; exec /bin/cat`, tmpdir());
    expect(await acceptBackgroundTrust(pane, probeCommand, { waitMs: 5_000 })).toBe("not asked");
  }, 15_000);
});

describe("the start sheets, as source (the apps have no XCTest target; the rules are tested in ConchDesign)", () => {
  const ledger = readFileSync(join(import.meta.dir, "../mobile/conch-ios/conch-ios/LedgerView.swift"), "utf8");
  const mac = readFileSync(join(import.meta.dir, "../mac-app/conch-mac/ContentView.swift"), "utf8");

  test("both say the same thing when a session hasn't checked in, and offer its startup terminal", () => {
    expect(ledger).toContain("StartedSessionWatch.notCheckedIn(backend: effectiveBackend.rawValue, background: background != nil, onPhone: true)");
    expect(mac).toContain("StartedSessionWatch.notCheckedIn(backend: effectiveBackend.rawValue, background: backgroundId != nil, onPhone: false)");
    expect(ledger).toContain('Button("Open startup terminal on Mac", systemImage: "terminal")');
    expect(mac).toContain('Button("Open startup terminal", systemImage: "terminal") { store.openStartupTerminal(backgroundId) }');
  });

  test("the phone's startup-terminal button keeps its result off the notice, so the sheet still closes onto the session", () => {
    expect(ledger).toContain("Task { terminalFailure = await bridge.openAgentTerminal(sessionId: backgroundId) }");
    expect(ledger).not.toContain("error = await bridge.openAgentTerminal");
    expect(ledger).toContain("if let id = await waitForSession(watch, rounds: 360), error == notice { open(id) }");
  });
});
