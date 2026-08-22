import { expect, test } from "bun:test";
import { checkAgentBinaries } from "../src/doctor-checks.ts";

/** A fake `run` so the check is testable without this machine's installs. */
function runner(map: Record<string, string>) {
  return async (argv: string[]) => {
    const key = argv[0] === "/bin/zsh" || argv[0] === "/bin/sh"
      ? `shell:${argv[2]?.split(" ").pop()}`
      : `version:${argv[0]}`;
    return { stdout: map[key] ?? "", ok: key in map };
  };
}

test("it warns when conch and the shell resolve different installs", async () => {
  // The daemon runs under the Mac app, which inherits a GUI environment rather
  // than a login shell, so PATH order is not the one you see. Measured on this
  // machine: five minor versions apart for Codex, sixty-nine patch versions for
  // Claude Code. A session started from conch was not the same program as one
  // started by hand, and nothing said so.
  const used = Bun.which("claude") ?? "/unused";
  const result = await checkAgentBinaries(runner({
    "shell:claude": "/opt/homebrew/bin/claude",
    "shell:codex": "/opt/homebrew/bin/codex",
    [`version:${used}`]: "2.1.239",
    "version:/opt/homebrew/bin/claude": "2.1.170",
  }));
  expect(result.ok).toBe(false);
  expect(result.label).toBe("agents");
  expect(result.action).toContain("different installs");
});

test("it stays quiet when they agree", async () => {
  // conch does not get to decide which install someone meant to use, so this
  // is advisory — and it must not nag when there is nothing to say.
  const claude = Bun.which("claude") ?? "/unused-claude";
  const codex = Bun.which("codex") ?? "/unused-codex";
  const result = await checkAgentBinaries(runner({
    "shell:claude": claude,
    "shell:codex": codex,
    [`version:${claude}`]: "2.1.239",
    [`version:${codex}`]: "codex-cli 0.149.0",
  }));
  expect(result.ok).toBe(true);
  expect(result.action).toBeUndefined();
});

test("an unknowable shell choice stays quiet rather than guessing", async () => {
  // If the login shell cannot be asked, conch does not know whether there is a
  // divergence — and warning without evidence is the same small lie the trust
  // readers refuse to tell. My first version of this test asserted the
  // opposite, which would have made the check nag on every machine where
  // probing the shell fails.
  const result = await checkAgentBinaries(runner({}));
  expect(result.action).toBeUndefined();
});
