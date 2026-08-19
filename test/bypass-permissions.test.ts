import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";

const command = (over: Record<string, unknown>) =>
  terminalSessionCommand({ backend: "claude", cwd: "/w", ...over } as never);

test("off by default, for conch and for everyone who installs it", () => {
  // The important half. conch starts sessions on someone else's machine from a
  // list they can scroll; a tool that quietly removes every confirmation from
  // those sessions is not a default anyone should inherit.
  expect(command({})).not.toContain("dangerously");
  expect(command({ backend: "codex" })).not.toContain("dangerously");
});

test("each agent gets the flag it actually accepts", () => {
  // Read from --help on the installed binaries, not from memory: Codex has
  // renamed this more than once and has no `--yolo` alias despite the name.
  expect(command({ bypassPermissions: true }))
    .toContain("claude --dangerously-skip-permissions");
  expect(command({ backend: "codex", bypassPermissions: true }))
    .toContain("codex --dangerously-bypass-approvals-and-sandbox");
});

test("resumed sessions get it too", () => {
  // Tyler: "i want all sessions including resume sessions started with
  // dangerously-skip-permissions". A resumed session is the one you are about
  // to work in, so it is exactly where the prompts would interrupt.
  expect(command({ bypassPermissions: true, resumeSessionId: "abc" }))
    .toBe("cd -- '/w' && exec claude --dangerously-skip-permissions --resume 'abc'");
});

test("the flag precedes a Codex subcommand, not its positional id", () => {
  // `codex resume <id>` takes the id as a positional, so a global flag placed
  // after it reads as a second positional. Verified against the real binary:
  // `codex --dangerously-bypass-approvals-and-sandbox resume --help` parses.
  expect(command({ backend: "codex", bypassPermissions: true, resumeSessionId: "abc" }))
    .toBe("cd -- '/w' && exec codex --dangerously-bypass-approvals-and-sandbox resume 'abc'");
});

test("the daemon hands its setting to the launcher", () => {
  // The seam. The flag is unit-tested above and the setting is unit-tested in
  // settings.test.ts, but neither says the daemon actually connects them —
  // which is the one line where a start would silently launch without it.
  const source = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  // Bounded by the next handler rather than a character count, which cut a
  // word in half the first time and failed for the wrong reason.
  const from = source.indexOf("start: (message) =>");
  const start = source.slice(from, source.indexOf("folderTrusted:", from));
  expect(from).toBeGreaterThan(-1);
  expect(start).toContain("bypassPermissions: cfg.bypassPermissions");
});
