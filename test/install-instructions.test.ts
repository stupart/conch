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
  REVIEW_INSTRUCTIONS_BLOCK,
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
