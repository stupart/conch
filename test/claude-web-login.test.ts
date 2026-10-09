import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRequestError } from "../src/claude-accounts.ts";
import { claudeWebLoginEnvironment, isClaudeSignInURL, signInURLFrom, startClaudeWebLogin } from "../src/claude-web-login.ts";
import { validateControlMessage } from "../src/settings.ts";

// 2026-10-09: Claude's sign-in in the app, with no cookies of its own, after Default ended up signed in as the other account.
const AUTHORIZE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback";

function fakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("the sign-in page conch shows", () => {
  test("only Anthropic's own pages, over https", () => {
    expect(isClaudeSignInURL(AUTHORIZE)).toBe(true);
    expect(isClaudeSignInURL("https://claude.ai/oauth/authorize")).toBe(true);
    expect(isClaudeSignInURL("http://claude.com/cai/oauth/authorize")).toBe(false);
    expect(isClaudeSignInURL("https://evil.example/claude.com")).toBe(false);
    expect(signInURLFrom(`-a Safari ${AUTHORIZE}\n`)).toBe(AUTHORIZE);
    expect(signInURLFrom("https://evil.example/x")).toBeUndefined();
  });

  test("the login runs as the account: Default unset, any other profile named and isolated, and `open` is conch's", () => {
    const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", HOME: "/Users/alex" };
    const fallback = claudeWebLoginEnvironment({ id: "default", configDir: "/Users/alex/.claude" }, "/tmp/shim", base);
    expect(fallback.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(fallback.PATH).toBe("/tmp/shim:/usr/bin");
    expect(fallback.BROWSER).toBe("/tmp/shim/open");
    const work = claudeWebLoginEnvironment({ id: "work", configDir: "/Users/alex/.config/conch/claude/work" }, "/tmp/shim", base);
    expect(work.CLAUDE_CONFIG_DIR).toBe("/Users/alex/.config/conch/claude/work");
    expect(work.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("the authorize URL `claude auth login` opens comes back to conch, and nothing opens a browser", async () => {
    const claude = fakeClaude(`open "${AUTHORIZE}"\nsleep 30`);
    const dir = mkdtempSync(join(tmpdir(), "acct-"));
    const login = await startClaudeWebLogin({ id: "work", label: "Work", configDir: dir }, { executable: claude, urlWithinMs: 5_000 });
    expect(login?.url).toBe(AUTHORIZE);
    login!.cancel();
    expect(await login!.done).not.toBe(0);
  });

  test("a login that never opens a page gives up, so conch falls back to Terminal", async () => {
    const claude = fakeClaude("sleep 30");
    const dir = mkdtempSync(join(tmpdir(), "acct-"));
    expect(await startClaudeWebLogin({ id: "work", label: "Work", configDir: dir }, { executable: claude, urlWithinMs: 300 })).toBeNull();
  });

  test("the app asks for it, and can call it off", () => {
    expect(accountRequestError({ kind: "claude-accounts", action: "login", id: "work", inApp: true })).toBeUndefined();
    expect(accountRequestError({ kind: "claude-accounts", action: "login", id: "work", inApp: "yes" })).toBe("inApp must be true when present");
    expect(accountRequestError({ kind: "claude-accounts", action: "cancel-login", id: "work" })).toBeUndefined();
    expect(accountRequestError({ kind: "codex-accounts", action: "cancel-login", id: "work" })).toBe("Unknown account action");
    expect(validateControlMessage({ kind: "claude-accounts", action: "login", id: "work", inApp: true }))
      .toEqual({ ok: true, value: { kind: "claude-accounts", action: "login", id: "work", inApp: true } });
  });
});

test("the Mac shows it in the app, and says when two accounts are one", async () => {
  const view = await Bun.file(new URL("../mac-app/conch-mac/ClaudeAccountsView.swift", import.meta.url)).text();
  expect(view).toContain('inApp: providerId == "claude" && action == "login" ? true : nil');
  expect(view).toContain("configuration.websiteDataStore = .nonPersistent()");
  expect(view).toContain(".sheet(item: $store.signIn) { request in");
  expect(view).toContain('Text("Same account as \\(twin.label). Sign in again to use a different one.")');
});
