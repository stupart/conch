import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyRuntimeControlMessage, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { acceptClaudeTrust } from "../src/session-lifecycle.ts";
import { adapterFor } from "../src/agent-adapter.ts";
import { validateControlResponse } from "../src/settings.ts";

/**
 * Tyler (2026-09-24): a session started from the app sat on Claude Code's "trust this
 * folder?" in Terminal, and once he answered it there the app was still on its start sheet.
 * Claude's trust screen as 2.1.280 shows it (measured in tmux on a fresh folder): "❯ No, exit"
 * first and highlighted, then "Yes, I trust this folder"; Down, then Return, trusts it.
 */
const trustScreen = (highlighted: "no" | "yes" = "no") => [
  " Accessing workspace:", " /Users/t/new-project",
  " Quick safety check: Is this a project you created or one you trust?",
  highlighted === "no" ? " ❯ No, exit" : "   No, exit",
  highlighted === "no" ? "   Yes, I trust this folder" : " ❯ Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
].join("\n");
const started = [
  " ▐▛███▛█   Claude Code v2.1.280",
  "──────────────────────────────────────────────── new-project ─",
  "❯ Try \"create a util logging.py that...\"",
  "────────────────────────────────────────────────────────────",
].join("\n");

function run(screens: (string | null)[]) {
  const reads = [...screens];
  let pressed = 0;
  const outcome = acceptClaudeTrust("ttys012", {
    read: async () => (reads.length > 1 ? reads.shift()! : reads[0]!),
    press: async () => { pressed += 1; reads.splice(0, reads.length, started); return true; },
    sleep: async () => {},
    waitMs: 4_000,
  });
  return { outcome, pressed: () => pressed };
}

describe("answering Claude Code's trust screen in the tab conch opened", () => {
  test("waits out the shell, then presses once, and sees the session start", async () => {
    const r = run(["Last login: Thu", "Last login: Thu", trustScreen()]);
    expect(await r.outcome).toBe("accepted");
    expect(r.pressed()).toBe(1);
  });

  test("a session that starts without asking is left alone", async () => {
    const r = run(["Last login: Thu", started]);
    expect(await r.outcome).toBe("not-asked");
    expect(r.pressed()).toBe(0);
  });

  test("any highlight but No is not the screen measured, so nothing is pressed", async () => {
    const r = run([trustScreen("yes")]);
    expect(await r.outcome).toBe("failed");
    expect(r.pressed()).toBe(0);
  });

  test("keys that leave the trust screen up are not called accepted", async () => {
    let pressed = 0;
    const outcome = await acceptClaudeTrust("ttys012", {
      read: async () => trustScreen(),
      press: async () => { pressed += 1; return true; },
      sleep: async () => {},
      waitMs: 4_000,
    });
    expect(outcome).toBe("failed");
    expect(pressed).toBe(1);
  });

  test("a tab it can never read gives up rather than pressing blind", async () => {
    const r = run([null]);
    expect(await r.outcome).toBe("failed");
    expect(r.pressed()).toBe(0);
  });
});

describe("asking before a Claude session starts in a folder it doesn't trust", () => {
  const options = (trusted: boolean | null, started: unknown[]): RuntimeControlDispatchOptions => ({
    listResumable: () => ({ available: true, sessions: [] }) as never,
    start: (message: unknown) => void started.push(message),
    folderTrusted: () => trusted,
    close: () => {},
    report: () => {},
  } as unknown as RuntimeControlDispatchOptions);

  test("the app is asked first, and nothing is launched", async () => {
    const launched: unknown[] = [];
    const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", cwd: "/Users/t/new-project" }, options(false, launched));
    expect(reply).toEqual({ kind: "session-needs-trust", backend: "claude", cwd: "/Users/t/new-project" });
    expect(launched).toEqual([]);
  });

  test("with the yes it launches, and the reply is a plain start", async () => {
    const launched: unknown[] = [];
    const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", cwd: "/Users/t/new-project", trustFolder: true }, options(false, launched));
    expect(reply).toEqual({ kind: "session-started", backend: "claude", resumed: false });
    expect(launched).toHaveLength(1);
  });

  test("an unknown answer launches as before", async () => {
    const launched: unknown[] = [];
    const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", cwd: "/Users/t/p" }, options(null, launched));
    expect(reply).toMatchObject({ kind: "session-started" });
  });

  test("the reply parses for Claude as well as Codex", () => {
    for (const backend of ["claude", "codex"] as const) {
      expect(validateControlResponse({ kind: "session-needs-trust", backend, cwd: "/p" } as unknown))
        .toEqual({ ok: true, value: { kind: "session-needs-trust", backend, cwd: "/p" } });
    }
  });

  test("only an agent that asks on screen gets its answer typed; Codex takes a flag", () => {
    expect(adapterFor("claude").trustTypedAtLaunch).toBe(true);
    expect(adapterFor("codex").trustTypedAtLaunch).toBe(false);
    const daemon = readFileSync(`${import.meta.dir}/../src/daemon.ts`, "utf8");
    expect(daemon).toContain("if (request.trustFolder === true && adapterFor(request.backend).trustTypedAtLaunch && tty) {");
    expect(daemon.match(/await launchSession\(|=> launchSession\(/g)?.length).toBe(3);
    // Every launch goes through launchSession: its own call is the only direct one.
    expect(daemon.match(/await startTerminalSession\(/g)?.length).toBe(1);
  });
});

describe("the start sheet, as source (conch-mac has no XCTest target)", () => {
  const view = readFileSync(`${import.meta.dir}/../mac-app/conch-mac/ContentView.swift`, "utf8");

  test("keeps watching after its notice, and closes itself when the session checks in", () => {
    expect(view).toContain("if await waitForSession(rounds: 225), error == notice { dismiss() }");
    // A session's agents are rows too; one appearing elsewhere is not this session.
    expect(view).toContain("rows.filter { $0.parentSessionId == nil }");
  });

  test("asks in Claude's words for Claude, and Codex's for Codex", () => {
    expect(view).toContain('Button(effectiveBackend == .codex ? "Yes, continue" : "Yes, I trust this folder")');
    expect(view).toContain("Claude Code'll be able to read, edit, and execute files");
  });
});
