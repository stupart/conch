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

  test("legacy verbs live only in the persisted-data migration helper", () => {
    const controls = source("src/instant-controls.ts");

    expect(controls).toContain('export type LegacyModeControl = "mute" | "unmute"');
    expect(controls).toContain("public inputs reject it");
  });
});
