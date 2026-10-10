import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addingDirectory, cancelAddingAccount, describeSwapEvent, finishAddingAccount, profileKeychainService, removeFromRotation,
  RotationSupervisor, rotationEnvironment, startAddingAccount, swapExecutable, switchRotation,
} from "../src/claude-rotation.ts";
import type { ClaudeWebLogin } from "../src/claude-web-login.ts";
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
    for (const action of ["rotation-status", "rotation-install", "rotation-add", "rotation-add-account"]) {
      expect(accountRequestError({ kind: "claude-accounts", action })).toBeUndefined();
      expect(accountRequestError({ kind: "codex-accounts", action })).toBe("Unknown account action");
    }
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-switch", slot: 2 })).toBeUndefined();
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-remove" })).toBe("Choose an account");
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-switch", slot: "2" })).toBe("Invalid account number");
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-switch", slot: 0 })).toBe("Invalid account number");
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-finish-add" })).toBe("Choose an account");
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-finish-add", id: "add-1" })).toBeUndefined();
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-add-account", email: "sam@acme.dev" })).toBeUndefined();
    expect(accountRequestError({ kind: "claude-accounts", action: "rotation-add-account", email: "not an email" })).toBe("Invalid email");
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

test("the Mac shows claude-swap's list as your Claude accounts, adds to it in the app, and switches", async () => {
  const view = await Bun.file(new URL("../mac-app/conch-mac/ClaudeAccountsView.swift", import.meta.url)).text();
  // One list, and the one way to add to it: a sign-in here that never changes the login your sessions use.
  expect(view).toContain("let list = store.rotation?.dashboard?.accounts ?? []");
  expect(view).toContain('Label("Add a Claude account", systemImage: "plus")');
  expect(view).toContain('await send("rotation-add-account", email: email, timeout: 240)');
  expect(view).toContain('struct Request: Encodable { let kind = "claude-accounts"; let action = "rotation-finish-add"; let id: String }');
  // Per account: use it now, sign it in again, remove it.
  expect(view).toContain('await send("rotation-switch", slot: account.number, timeout: 60)');
  expect(view).toContain('await send("rotation-remove", slot: account.number, timeout: 60)');
  expect(view).toContain('Button("Sign in again") { Task { await store.addAccount(email: account.email) } }');
  // The sign-in that signed Default in as someone else is gone.
  expect(view).not.toContain("addToRotationAfterSignIn");
  expect(view).not.toContain("Sign in another account");
  // Switching on and off, and conch's own sign-ins tucked under the list.
  expect(view).toContain('struct SetConfig: Encodable { let kind = "set-config"; let key = "claude-rotation"; let value: Bool }');
  expect(view).toContain('Text("Switch accounts automatically")');
  expect(view).toContain('Text("Separate sign-ins (\\(store.accounts.count))")');
  expect(view).toContain('if providerId == "claude" { await store.send("rotation-status") }');
});

test("Continue with Google and Apple open as real popups in the sign-in, with Chrome to fall back on", async () => {
  const view = await Bun.file(new URL("../mac-app/conch-mac/ClaudeAccountsView.swift", import.meta.url)).text();
  expect(view).toContain("let popup = WKWebView(frame: webView.bounds, configuration: configuration)");
  expect(view).toContain("func webViewDidClose(_ webView: WKWebView)");
  expect(view).not.toContain("webView.load(URLRequest(url: url)) }\n            return nil");
  expect(view).toContain('configuration.arguments = ["--incognito", request.url.absoluteString]');
});
