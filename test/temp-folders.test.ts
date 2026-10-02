import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { darwinUserTempDir, describeTempFolders, inTempFolder, realTempFolders, tempFolders } from "../src/temp-folders.ts";

/**
 * Each process used to allow its own `os.tmpdir()`, which is `$TMPDIR`: the agent's MCP server read the agent's
 * environment and the daemon its own, and when they differed `review_to_front` said "accepted" for a file the daemon
 * then dropped. The temp folders are now /tmp and the per-user folder macOS names for this user, whatever TMPDIR says.
 */

const repo = join(import.meta.dir, "..");

/** `getconf DARWIN_USER_TEMP_DIR`: the system's own answer, independent of any environment. */
function systemUserTemp(): string {
  const run = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { env: { PATH: "/usr/bin:/bin" } });
  return run.stdout.toString().trim().replace(/\/+$/, "");
}

describe("the temp folders, named the same in every process", () => {
  test("the per-user one is what macOS names for this user, not this process's TMPDIR", () => {
    // This process's TMPDIR is the suite's run root, and still the answer is the system's.
    expect(process.env.TMPDIR?.replace(/\/+$/, "")).not.toBe(darwinUserTempDir());
    expect(darwinUserTempDir()).toBe(systemUserTemp());
    expect(darwinUserTempDir()).toMatch(/^\/var\/folders\/[^/]+\/[^/]+\/T$/);
  });

  test("the suite stands its run root in for it, by conch's own variable, so a test can build a folder that is not temp", () => {
    // test/preload.ts: every fixture lives under the real per-user folder.
    expect(process.env.CONCH_USER_TEMP_DIR).toBeTruthy();
    expect(tempFolders()).toEqual(["/tmp", process.env.CONCH_USER_TEMP_DIR!]);
    expect(realTempFolders()[0]).toBe("/private/tmp");
    expect(describeTempFolders()).toBe(`the temp folders (/tmp, ${process.env.CONCH_USER_TEMP_DIR})`);
    const saved = process.env.CONCH_USER_TEMP_DIR;
    delete process.env.CONCH_USER_TEMP_DIR;
    try {
      expect(tempFolders()).toEqual(["/tmp", systemUserTemp()]);
      expect(inTempFolder(`/private${systemUserTemp()}/conch-x/a.png`)).toBe(true);
      expect(inTempFolder(`/private${systemUserTemp()}`)).toBe(false);
      expect(inTempFolder("/private/tmp/a.png")).toBe(true);
      expect(inTempFolder("/Users/someone/a.png")).toBe(false);
    } finally {
      process.env.CONCH_USER_TEMP_DIR = saved;
    }
  });

  /**
   * Both processes, each with a TMPDIR of its own and neither the folder the file is in: the MCP server's check and the
   * daemon's are the one `checkReviewLink`, so a fresh process with any TMPDIR is either. Spawned with an explicit
   * environment, which the suite's variable is not in.
   */
  test("a file in the per-user temp folder passes the link check in a process whatever its TMPDIR, and in both the same", async () => {
    const folder = mkdtempSync(join(systemUserTemp(), "conch-temp-both-"));
    try {
      const shot = join(folder, "hero.png");
      writeFileSync(shot, "png");
      const verdicts: string[] = [];
      for (const tmp of ["/tmp/conch-agent-elsewhere/", `${folder}-not-this/`, "/Users/Shared/"]) {
        const run = Bun.spawnSync([process.execPath, "-e",
          `import { checkReviewLink } from "${join(repo, "src", "snippet.ts")}";`
            + `const checked = await checkReviewLink(${JSON.stringify(shot)}, "/nowhere", ["/nowhere"]);`
            + "console.log(JSON.stringify(checked));"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmp, HOME: "/nonexistent" } });
        verdicts.push(run.stdout.toString().trim());
      }
      expect(verdicts.map((line) => JSON.parse(line).ok)).toEqual([true, true, true]);
      expect(new Set(verdicts).size).toBe(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
