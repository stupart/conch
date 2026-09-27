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
const read = (path: string) => readFileSync(repo(path), "utf8");
const squash = (text: string) => text.replace(/\s+/g, " ");
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

  test("the conch-mac target runs that phase after its resources, unsandboxed", () => {
    const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
    const target = project.slice(project.indexOf("isa = PBXNativeTarget;"), project.indexOf("/* End PBXNativeTarget section */"));
    expect(target).toContain('name = "conch-mac";');
    const phases = target.slice(target.indexOf("buildPhases = ("), target.indexOf(");", target.indexOf("buildPhases = (")));
    expect(phases.indexOf("/* Embed uv helper */")).toBeGreaterThan(phases.indexOf("/* Resources */"));
    expect(phases.indexOf("/* Resources */")).toBeGreaterThan(-1);

    const phase = project.slice(project.indexOf("/* Begin PBXShellScriptBuildPhase section */"), project.indexOf("/* End PBXShellScriptBuildPhase section */"));
    expect(phase).toContain('name = "Embed uv helper";');
    expect(phase).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-uv.sh\\"\\n";');

    // Sandboxed script phases cannot read the repo's scripts or run codesign.
    for (const config of ["A80000000000000000000003 /* Debug */", "A80000000000000000000004 /* Release */"]) {
      const at = project.indexOf(`${config} = {`);
      expect(at).toBeGreaterThan(-1);
      expect(project.slice(at, project.indexOf("name = ", at))).toContain("ENABLE_USER_SCRIPT_SANDBOXING = NO;");
    }
  });

  test("uv is pinned by version and by the sha256 of its release, and a Release build refuses to ship without it", () => {
    const fetch = read("scripts/fetch-uv.sh");
    expect(fetch).toMatch(/^UV_VERSION=\d+\.\d+\.\d+$/m);
    expect(fetch).toMatch(/^UV_SHA256=[0-9a-f]{64}$/m);
    expect(fetch).toContain('shasum -a 256 -c -');
    expect(fetch).toContain("uv-$UV_TRIPLE.tar.gz");
    const embed = read("scripts/embed-uv.sh");
    expect(squash(embed)).toContain('if [[ "${CONFIGURATION:-}" == "Release" ]]; then echo "error: could not fetch the pinned uv');
  });

  test("the install and release scripts verify the embedded uv's signature", () => {
    const install = read("scripts/build-app.sh");
    expect(install).toContain('UV_HELPER="$INSTALLED_APP_PATH/Contents/Helpers/uv"');
    expect(install).toContain('codesign --verify --strict --verbose=2 "$UV_HELPER"');
    expect(read("scripts/build-release.sh")).toContain('codesign --verify --strict "$APP_SRC/Contents/Helpers/uv"');
    expect(read("scripts/release-app.sh")).toContain('codesign --verify --strict --verbose=2 "$APP/Contents/Helpers/uv"');
  });
});

describe("the app hands its uv to the daemon, and shows where the voices stand", () => {
  test("DaemonHost sets CONCH_UV to its own Contents/Helpers/uv before the daemon's environment is handed over", () => {
    const host = read("mac-app/conch-mac/DaemonHost.swift");
    const set = host.indexOf('environment["CONCH_UV"] = uv.path');
    expect(set).toBeGreaterThan(-1);
    expect(host.slice(set - 160, set)).toContain('if environment["CONCH_UV"] == nil, let uv = DaemonHost.bundledUV()');
    expect(host.indexOf("task.environment = environment")).toBeGreaterThan(set);
    const helper = host.slice(host.indexOf("static func bundledUV("), host.indexOf("static func bundledUV(") + 400);
    expect(helper).toContain('bundle.bundleURL.appendingPathComponent("Contents/Helpers/uv")');
  });

  test("Settings shows 'Natural voices: setting up… / ready / off (reason)' from the published state", () => {
    const settings = read("mac-app/conch-mac/SettingsView.swift");
    const status = settings.slice(settings.indexOf("private struct NaturalVoicesStatus"), settings.indexOf("private struct NaturalVoicesEnvelope"));
    expect(status.length).toBeGreaterThan(200);
    expect(status).toContain('case "ready": return "Natural voices: ready"');
    expect(status).toContain('case "setting-up": return "Natural voices: setting up…"');
    expect(status).toContain('default: return "Natural voices: off" + (reason.map { " (\\($0))" } ?? "")');
    expect(settings).toContain("let naturalVoices: NaturalVoicesStatus?");
    const section = settings.slice(settings.indexOf("private struct SessionVoicesSection"), settings.indexOf("private struct NaturalVoicesStatus"));
    expect(section).toContain("Text(natural.headline)");
    expect(section).toContain("Text(natural.detail)");
  });
});
