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

/**
 * BOTH sides are injected now. The first version stubbed the shell and read the
 * host for what conch resolves, so the expected answer depended on where
 * `claude` happened to be installed. Three machines, three different failures:
 * passed by accident where claude lived under nvm, failed where it lives in
 * /opt/homebrew (the two sides "agreed"), and failed the opposite way on CI,
 * which has no claude at all. CI had never been green.
 */
const which = (map: Record<string, string | null>) => (agent: string) => map[agent] ?? null;

test("it warns when conch and the shell resolve different installs", async () => {
  // The daemon runs under the Mac app, which inherits a GUI environment rather
  // than a login shell, so PATH order is not the one you see. Measured once:
  // five minor versions apart for Codex, sixty-nine patch versions for Claude
  // Code. A session started from conch was not the same program as one started
  // by hand, and nothing said so.
  const result = await checkAgentBinaries(
    runner({
      "shell:claude": "/opt/homebrew/bin/claude",
      "shell:codex": "/opt/homebrew/bin/codex",
      "version:/Users/me/.nvm/bin/claude": "2.1.239",
      "version:/opt/homebrew/bin/claude": "2.1.170",
      "version:/opt/homebrew/bin/codex": "codex-cli 0.149.0",
    }),
    which({ claude: "/Users/me/.nvm/bin/claude", codex: "/opt/homebrew/bin/codex" }),
  );
  expect(result.ok).toBe(false);
  expect(result.label).toBe("agents");
  expect(result.action).toContain("different installs");
  expect(result.message).toContain("conch runs 2.1.239");
  expect(result.message).toContain("your shell runs 2.1.170");
});

test("it stays quiet when they agree", async () => {
  // conch does not get to decide which install someone meant to use, so this
  // is advisory — and it must not nag when there is nothing to say.
  const result = await checkAgentBinaries(
    runner({
      "shell:claude": "/opt/homebrew/bin/claude",
      "shell:codex": "/opt/homebrew/bin/codex",
      "version:/opt/homebrew/bin/claude": "2.1.239",
      "version:/opt/homebrew/bin/codex": "codex-cli 0.149.0",
    }),
    which({ claude: "/opt/homebrew/bin/claude", codex: "/opt/homebrew/bin/codex" }),
  );
  expect(result.ok).toBe(true);
  expect(result.action).toBeUndefined();
});

test("an unknowable shell choice stays quiet rather than guessing", async () => {
  // If the login shell cannot be asked, conch does not know whether there is a
  // divergence — and warning without evidence is the same small lie the trust
  // readers refuse to tell.
  const result = await checkAgentBinaries(
    runner({}),
    which({ claude: "/opt/homebrew/bin/claude", codex: "/opt/homebrew/bin/codex" }),
  );
  expect(result.action).toBeUndefined();
});

test("an agent conch cannot find at all is reported, not hidden", async () => {
  // The CI case — no claude on the runner — and the branch the old tests never
  // reached, which is why "stays quiet" failed there. Not finding the agent is
  // not "unknowable"; it is the one thing conch knows for certain.
  const result = await checkAgentBinaries(
    runner({
      "shell:codex": "/opt/homebrew/bin/codex",
      "version:/opt/homebrew/bin/codex": "codex-cli 0.149.0",
    }),
    which({ claude: null, codex: "/opt/homebrew/bin/codex" }),
  );
  expect(result.ok).toBe(false);
  expect(result.message).toContain("claude: not on conch's PATH");
});
