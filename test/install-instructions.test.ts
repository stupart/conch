import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installReviewInstructions,
  renderSupervisorScript,
  REVIEW_INSTRUCTIONS_BLOCK,
  runInstall,
  spliceReviewInstructions,
} from "../src/install.ts";

const begin = "<!-- conch:begin -->";
const end = "<!-- conch:end -->";

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("global review instructions", () => {
  test("creates the canonical managed block from an absent file body", () => {
    expect(spliceReviewInstructions(""))
      .toBe(`${REVIEW_INSTRUCTIONS_BLOCK}\n`);
  });

  test("replaces stale and duplicate blocks while preserving surrounding text", () => {
    const existing = [
      "# User instructions",
      "",
      begin,
      "old conch wording",
      end,
      "",
      "Keep this middle note.",
      "",
      begin,
      "duplicate conch wording",
      end,
      "",
      "Final user note.",
    ].join("\n");

    const updated = spliceReviewInstructions(existing);

    expect(updated.startsWith("# User instructions\n\n")).toBe(true);
    expect(updated).toContain("\n\nKeep this middle note.\n\n");
    expect(updated.endsWith("\n\nFinal user note.")).toBe(true);
    expect(updated).not.toContain("old conch wording");
    expect(updated).not.toContain("duplicate conch wording");
    expect(occurrences(updated, begin)).toBe(1);
    expect(occurrences(updated, end)).toBe(1);
    expect(spliceReviewInstructions(updated)).toBe(updated);
  });

  test("backs up only the real modification and stays idempotent on rerun", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-review-instructions-"));
    const instructionsPath = join(root, "nested", "CLAUDE.md");
    const original = "# My global rules\n\nNever remove this.\n";
    try {
      mkdirSync(join(root, "nested"), { recursive: true });
      writeFileSync(instructionsPath, original);

      expect(await installReviewInstructions(instructionsPath, "CLAUDE.md"))
        .toBe("updated");
      const first = readFileSync(instructionsPath, "utf8");
      expect(first.startsWith(original)).toBe(true);
      expect(occurrences(first, begin)).toBe(1);
      expect(occurrences(first, end)).toBe(1);

      const backups = readdirSync(join(root, "nested"))
        .filter((name) => name.startsWith("CLAUDE.md.conch-backup-"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(root, "nested", backups[0]!), "utf8"))
        .toBe(original);

      expect(await installReviewInstructions(instructionsPath, "CLAUDE.md"))
        .toBe("unchanged");
      expect(readFileSync(instructionsPath, "utf8")).toBe(first);
      expect(
        readdirSync(join(root, "nested"))
          .filter((name) => name.startsWith("CLAUDE.md.conch-backup-")),
      ).toEqual(backups);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates an absent file and parent without a backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-review-instructions-"));
    const instructionsPath = join(root, "missing", "AGENTS.md");
    try {
      expect(await installReviewInstructions(instructionsPath, "AGENTS.md"))
        .toBe("created");
      expect(readFileSync(instructionsPath, "utf8"))
        .toBe(`${REVIEW_INSTRUCTIONS_BLOCK}\n`);
      expect(readdirSync(join(root, "missing")))
        .toEqual(["AGENTS.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns and skips an existing path that cannot be read as a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-review-instructions-"));
    const instructionsPath = join(root, "AGENTS.md");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      mkdirSync(instructionsPath);
      console.warn = (...data: any[]) => warnings.push(data.map(String).join(" "));

      expect(await installReviewInstructions(instructionsPath, "AGENTS.md"))
        .toBe("skipped");
      expect(warnings.join("\n")).toContain("could not read");
      expect(warnings.join("\n")).toContain("conch review contract skipped");
      expect(readdirSync(root)).toEqual(["AGENTS.md"]);
    } finally {
      console.warn = originalWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns and leaves a readable file with incomplete managed markers untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-review-instructions-"));
    const instructionsPath = join(root, "CLAUDE.md");
    const original = `# Keep me\n\n${begin}\nunfinished managed text\n`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      writeFileSync(instructionsPath, original);
      console.warn = (...data: any[]) => warnings.push(data.map(String).join(" "));

      expect(await installReviewInstructions(instructionsPath, "CLAUDE.md"))
        .toBe("skipped");
      expect(readFileSync(instructionsPath, "utf8")).toBe(original);
      expect(warnings.join("\n")).toContain("could not safely update");
      expect(readdirSync(root)).toEqual(["CLAUDE.md"]);
    } finally {
      console.warn = originalWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the supervisor's liveness check", () => {
  // The prose explains what went wrong and names the very commands under
  // test; asserting against it would pass on a script that only apologises.
  const code = renderSupervisorScript("/opt/homebrew/bin/tmux", "bun run src/cli.ts daemon")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  test("gates recovery on the daemon process, not the tmux session", () => {
    // `has-session` outlives a dead pane, so as the OUTER gate it reported
    // healthy while conch was gone and recovery could never run. It is still
    // sound further in, for "is there a stale session to clear" — so assert
    // the ordering, which is the part that was wrong, not its mere absence.
    const liveness = code.indexOf("pgrep -f");
    expect(liveness).toBeGreaterThan(-1);
    expect(code.indexOf("has-session")).toBeGreaterThan(liveness);
  });

  test("matches how the daemon actually runs, not one spelling of it", () => {
    // The replacement for has-session was equally wrong, just differently:
    // it looked for `bun run src/cli.ts daemon`, while `conch service install`
    // starts the daemon as `bun /abs/path/src/cli.ts daemon` — no `run`. The
    // supervisor never matched, believed conch was dead, and killed and
    // recreated it every 5 seconds on a live machine.
    expect(code).not.toMatch(/pgrep -f 'bun run/);
    expect(code).toMatch(/cli\.ts daemon/);
    // And a tmux wrapper carries the same words in its argv, so the process
    // itself has to be the discriminator — not just the command line.
    expect(code).toMatch(/ps -o comm=/);
  });

  test("never kills a session and creates one in the same pass", () => {
    // Killing the last session stops the tmux server; a new-session issued
    // before that teardown finishes silently loses the race, which is what
    // stretched healing to 30-45s. They must sit on opposite branches.
    const clear = code.indexOf("kill-session");
    const create = code.indexOf("new-session");
    expect(clear).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    const between = code.slice(Math.min(clear, create), Math.max(clear, create));
    expect(between).toMatch(/\belse\b/);
  });
});

describe("installing conch leaves the user's own instruction files alone", () => {
  // `conch install` used to splice a managed review-contract block into the
  // GLOBAL ~/.claude/CLAUDE.md (and ~/.codex/AGENTS.md), so installing a voice
  // tool silently edited the standing prompt of every session on the machine.
  // On Tyler's Mac it had CREATED that file, whose entire contents were conch's
  // block. The contract belongs to the plugin, which ships and updates with the
  // thing it describes and uninstalls cleanly.
  //
  // `installReviewInstructions` itself is kept — `conch uninstall` still has to
  // remove the block from machines that took the old install — so the guard has
  // to be that nothing on the install path CALLS it.
  test("runInstall writes settings.json and never CLAUDE.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-install-untouched-"));
    const log = console.log;
    try {
      console.log = () => {};
      await runInstall({ claudeDir: root } as any);
      expect(readdirSync(root)).toEqual(["settings.json"]);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing CLAUDE.md is left byte-for-byte intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-install-untouched-"));
    const claudeMd = join(root, "CLAUDE.md");
    const mine = "# My rules\n\nNothing conch put here.\n";
    const log = console.log;
    try {
      console.log = () => {};
      writeFileSync(claudeMd, mine);
      await runInstall({ claudeDir: root } as any);
      expect(readFileSync(claudeMd, "utf8")).toBe(mine);
      // and no timestamped backup, which is the fingerprint of a write
      expect(readdirSync(root).filter((n) => n.includes("conch-backup"))).toEqual([]);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
