import { expect, test } from "bun:test";
import { join } from "node:path";
import { CONCH_VERSION } from "../src/version.ts";

test("conch version and conch --version print only the version and succeed", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  for (const command of ["version", "--version"]) {
    const proc = Bun.spawnSync([process.execPath, cli, command]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe(`conch ${CONCH_VERSION}\n`);
    expect(proc.stderr.toString()).toBe("");
  }
});
