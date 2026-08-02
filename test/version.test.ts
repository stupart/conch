import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONCH_VERSION, packageVersion } from "../src/version.ts";

describe("version command", () => {
  test("reads the canonical package version", async () => {
    const metadata = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(CONCH_VERSION).toBe(metadata.version);
    expect(packageVersion('{"version":"9.8.7"}')).toBe("9.8.7");
  });

  for (const command of ["version", "--version"]) {
    test(`conch ${command} prints only the version and succeeds`, () => {
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const proc = Bun.spawnSync([process.execPath, cli, command]);
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toBe(`conch ${CONCH_VERSION}\n`);
      expect(proc.stderr.toString()).toBe("");
    });
  }
});
