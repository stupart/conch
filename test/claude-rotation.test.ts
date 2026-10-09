import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSwapEvent, RotationSupervisor, rotationEnvironment, swapExecutable } from "../src/claude-rotation.ts";
import { accountRequestError } from "../src/claude-accounts.ts";

// 2026-10-09, Tyler: "ideally its like one account that just rotates to the next max account via logout and login when
// one hits its limit". claude-swap switches; conch installs it, adds accounts, runs its switcher and reports it.
const SWITCH = JSON.stringify({ schemaVersion: 1, event: "switch", ts: "2026-10-09T10:00:00Z", trigger: "proactive",
  from: { number: 1, email: "alex@acme.dev" }, to: { number: 2, email: "sam@acme.dev" }, warnings: [], dryRun: false });

describe("finding and running claude-swap", () => {
  test("on PATH, or where `uv tool install` puts it", () => {
    expect(swapExecutable(() => "/opt/bin/cswap", "/Users/alex")).toBe("/opt/bin/cswap");
    const home = mkdtempSync(join(tmpdir(), "home-"));
    expect(swapExecutable(() => null, home)).toBeUndefined();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "cswap"), "");
    expect(swapExecutable(() => null, home)).toBe(join(home, ".local", "bin", "cswap"));
  });

  test("it works on the Default profile alone, never one named by CLAUDE_CONFIG_DIR or an API key", () => {
    const env = rotationEnvironment({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/x", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("the account actions the app sends", () => {
    for (const action of ["rotation-status", "rotation-install", "rotation-add"]) {
      expect(accountRequestError({ kind: "claude-accounts", action })).toBeUndefined();
      expect(accountRequestError({ kind: "codex-accounts", action })).toBe("Unknown account action");
    }
  });
});

describe("what conch says about the switcher", () => {
  test("a switch, by who it left and who it went to", () => {
    expect(describeSwapEvent(SWITCH)).toBe("switched Claude from alex@acme.dev (near its limit) to sam@acme.dev");
    expect(describeSwapEvent(SWITCH.replace('"proactive"', '"at-limit"'))).toContain("(at its limit)");
    expect(describeSwapEvent(SWITCH.replace('"dryRun":false', '"dryRun":true'))).toBeUndefined();
  });

  test("everything exhausted and a dead sign-in are said; polls, sleeps and passing errors aren't", () => {
    expect(describeSwapEvent(JSON.stringify({ event: "all-exhausted" }))).toContain("every Claude account in the rotation is at its limit");
    expect(describeSwapEvent(JSON.stringify({ event: "account-quarantined", number: 2, email: "sam@acme.dev" }))).toContain("sam@acme.dev left the rotation");
    for (const quiet of [{ event: "poll" }, { event: "sleep" }, { event: "no-switch" }, { event: "error", transient: true, message: "x" }]) {
      expect(describeSwapEvent(JSON.stringify(quiet))).toBeUndefined();
    }
    expect(describeSwapEvent("not json")).toBeUndefined();
  });

  test("the supervisor runs `cswap auto --json` while on, reports its switches, and stops when off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cswap-"));
    const cswap = join(dir, "cswap");
    writeFileSync(cswap, `#!/bin/sh\n[ "$1 $2" = "auto --json" ] || exit 9\necho '${SWITCH}'\nsleep 30\n`);
    chmodSync(cswap, 0o755);
    const said: string[] = [];
    const supervisor = new RotationSupervisor((line) => said.push(line), () => cswap);
    supervisor.set(true);
    // A shell started under a loaded gate can take seconds to print.
    for (let i = 0; i < 300 && !said.length; i++) await Bun.sleep(50);
    expect(supervisor.running).toBe(true);
    expect(said).toEqual(["switched Claude from alex@acme.dev (near its limit) to sam@acme.dev"]);
    supervisor.set(false);
    expect(supervisor.running).toBe(false);
  }, 20_000);

  test("on, with claude-swap missing, says so rather than failing quietly", () => {
    const said: string[] = [];
    new RotationSupervisor((line) => said.push(line), () => undefined).set(true);
    expect(said).toEqual(["account rotation is on, but claude-swap isn't installed"]);
  });
});

test("the Mac sets it up, adds accounts after an in-app sign-in, and turns it on and off", async () => {
  const view = await Bun.file(new URL("../mac-app/conch-mac/ClaudeAccountsView.swift", import.meta.url)).text();
  expect(view).toContain('Button("Set up rotation") { Task { await store.send("rotation-install") } }');
  expect(view).toContain('struct SetConfig: Encodable { let kind = "set-config"; let key = "claude-rotation"; let value: Bool }');
  expect(view).toContain("store.addToRotationAfterSignIn = true");
  expect(view).toContain('await store.send("rotation-add")');
  expect(view).toContain('if providerId == "claude" { await store.send("rotation-status") }');
});
