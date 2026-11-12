import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("retired mode aliases", () => {
  test("the CLI and public TurnEvent type advertise only pause and resume", () => {
    const cli = source("src/cli.ts");
    const hook = source("src/hook.ts");

    expect(cli).not.toMatch(/case ["'](?:mute|unmute)["']/);
    expect(hook).not.toMatch(/\| ["'](?:mute|unmute)["']/);
  });

  test("the legacy verbs are gone, migration helper included", () => {
    // normalizeLegacyModeControl mapped mute/unmute read from persisted data, but
    // nothing persisted or read those verbs through it, so it went 2026-11-11.
    const controls = source("src/instant-controls.ts");

    expect(controls).not.toMatch(/["'](?:mute|unmute)["']/);
  });
});
