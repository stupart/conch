import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Can u make sure that whatever the fix is that its bundled with the app so
 * people in the future can just download one thing and it works." (Tyler,
 * 2026-09-27.) The natural voices set themselves up with a uv the app carries:
 * scripts/embed-uv.sh puts it at conch.app/Contents/Helpers/uv, signed like the
 * app, and DaemonHost hands its path to the daemon as CONCH_UV. These pin each
 * link of that chain; CI builds neither app, so the source is the check.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run the build phase as Xcode would, with a stand-in uv and a codesign that records its argv. */
async function runEmbed(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "conch-embed-uv-test-"));
  roots.push(root);
  const fakeUv = join(root, "uv-source");
  writeFileSync(fakeUv, "#!/bin/sh\necho 'uv 0.0.0-test'\n");
  chmodSync(fakeUv, 0o755);
  const signLog = join(root, "codesign.argv");
  const fakeCodesign = join(root, "codesign");
  writeFileSync(fakeCodesign, `#!/bin/sh\nprintf '%s\\n' "$@" > '${signLog}'\n`);
  chmodSync(fakeCodesign, 0o755);
  const products = join(root, "Products");
  const proc = Bun.spawn(["/bin/bash", repo("scripts/embed-uv.sh")], {
    env: {
      PATH: "/usr/bin:/bin",
      TARGET_BUILD_DIR: products,
      CONTENTS_FOLDER_PATH: "conch-mac.app/Contents",
      UNLOCALIZED_RESOURCES_FOLDER_PATH: "conch-mac.app/Contents/Resources",
      CONFIGURATION: "Release",
      CONCH_UV_SOURCE: fakeUv,
      CODESIGN: fakeCodesign,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const app = join(products, "conch-mac.app", "Contents");
  return {
    code,
    stdout,
    stderr,
    helper: join(app, "Helpers", "uv"),
    notices: join(app, "Resources", "ThirdParty", "uv"),
    fakeUv,
    signed: existsSync(signLog) ? readFileSync(signLog, "utf8").trim().split("\n") : null,
  };
}

describe("the app carries uv", () => {
  test("the build phase copies uv into Contents/Helpers and signs it with the app's identity and hardened runtime", async () => {
    const result = await runEmbed({
      CODE_SIGNING_ALLOWED: "YES",
      EXPANDED_CODE_SIGN_IDENTITY: "0123456789ABCDEF0123456789ABCDEF01234567",
    });
    expect(result.code).toBe(0);
    expect(readFileSync(result.helper, "utf8")).toBe(readFileSync(result.fakeUv, "utf8"));
    expect(statSync(result.helper).mode & 0o111).toBe(0o111);
    expect(result.signed).toEqual([
      "--force",
      "--sign",
      "0123456789ABCDEF0123456789ABCDEF01234567",
      "--options",
      "runtime",
      "--timestamp=none",
      result.helper,
    ]);
    // Its licence travels with it (uv is MIT OR Apache-2.0).
    expect(readFileSync(join(result.notices, "LICENSE-MIT"), "utf8")).toStartWith("MIT License");
    expect(readFileSync(join(result.notices, "LICENSE-APACHE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(result.notices, "NOTICE"), "utf8")).toContain("Contents/Helpers/uv");
  });

  test("a release asking for a secure timestamp gets one on the helper too", async () => {
    const result = await runEmbed({
      CODE_SIGNING_ALLOWED: "YES",
      EXPANDED_CODE_SIGN_IDENTITY: "ABC",
      OTHER_CODE_SIGN_FLAGS: "--timestamp",
    });
    expect(result.code).toBe(0);
    expect(result.signed?.slice(-2)).toEqual(["--timestamp", result.helper]);
  });

  test("an unsigned build (the CI gate's) still embeds uv and never runs codesign", async () => {
    const result = await runEmbed({ CODE_SIGNING_ALLOWED: "NO", EXPANDED_CODE_SIGN_IDENTITY: "" });
    expect(result.code).toBe(0);
    expect(existsSync(result.helper)).toBeTrue();
    expect(result.signed).toBeNull();
  });
});
