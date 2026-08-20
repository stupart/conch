import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFolderTrusted } from "../src/codex-threads.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";

function configWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conch-codextrust-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

test("a folder Codex has never been told about will stop and ask", () => {
  // The prompt Tyler hit: "Do you trust the contents of this directory?" with
  // "1. Yes, continue / 2. No, quit". A session held there never starts and
  // never registers, so from outside it is indistinguishable from a failure.
  const path = configWith('[projects."/work/known"]\ntrust_level = "trusted"\n');
  expect(codexFolderTrusted("/work/new", path)).toBe(false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("a trusted folder will not", () => {
  const path = configWith('[projects."/work/known"]\ntrust_level = "trusted"\n');
  expect(codexFolderTrusted("/work/known", path)).toBe(true);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("a recorded folder that is not trusted still will", () => {
  const path = configWith('[projects."/work/half"]\ntrust_level = "untrusted"\n');
  expect(codexFolderTrusted("/work/half", path)).toBe(false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("an unreadable config says nothing rather than guessing", () => {
  // Warning about a folder that is actually trusted is its own small lie.
  expect(codexFolderTrusted("/work/x", "/nope/missing.toml")).toBeNull();
});

test("the section must match the whole path, not a prefix", () => {
  // `/work/known-other` must not inherit `/work/known`'s answer.
  const path = configWith('[projects."/work/known"]\ntrust_level = "trusted"\n');
  expect(codexFolderTrusted("/work/known-other", path)).toBe(false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("trust is passed at launch, never written to the user's config", () => {
  // The person answered about ONE session. Editing config.toml to make a
  // launch succeed would answer for every future one on their behalf.
  const command = terminalSessionCommand({
    backend: "codex", cwd: "/work/new", trustFolder: true,
  } as never);
  expect(command).toContain('-c \'projects."/work/new".trust_level="trusted"\'');
  // Verified against the real binary: the override parses before a subcommand.
  expect(command.indexOf("-c ")).toBeLessThan(command.length);
});

test("Claude gets no such flag, because it has none", () => {
  // Claude Code's trust decision cannot be supplied on the command line, which
  // is why conch checks it beforehand and explains instead.
  const command = terminalSessionCommand({
    backend: "claude", cwd: "/work/new", trustFolder: true,
  } as never);
  expect(command).not.toContain("trust_level");
});
