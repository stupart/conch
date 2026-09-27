import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageVersion } from "../src/version.ts";
import { VAD_MODEL } from "../src/speech-engine.ts";

/**
 * "Download one thing and it works." (Tyler.) conch.app carries its daemon
 * (scripts/embed-daemon.sh → Contents/Helpers/conch-daemon) and seashell's
 * speech engine (scripts/embed-engine.sh → whisper-cli, whisper-server and sox
 * in Contents/Helpers, the VAD model in Contents/Resources/models), each signed
 * like the app. The build phases run here as Xcode runs them, with stand-ins
 * for bun, codesign and lipo that record what they were asked to do; the CI
 * gate builds the app unsigned, so the scripts and the project are the check.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const read = (path: string) => readFileSync(repo(path), "utf8");
const VERSION = packageVersion(read("package.json"));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-bundle-build-"));
  roots.push(root);
  return root;
}

function tool(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** codesign and lipo that append their argv (one call per line, args joined by |) to a log. */
function recorders(root: string) {
  const log = join(root, "calls.log");
  const codesign = tool(root, "codesign", `echo "codesign|$(IFS='|'; echo "$*")" >> '${log}'`);
  // lipo -create a b -output out: keep the first slice, so the output runs; -archs: the host's.
  const lipo = tool(root, "lipo", `
if [[ "$1" == "-archs" ]]; then uname -m; exit 0; fi
echo "lipo|$(IFS='|'; echo "$*")" >> '${log}'
out=""; inputs=()
while [[ $# -gt 0 ]]; do
  case "$1" in -create) ;; -output) out="$2"; shift ;; *) inputs+=("$1") ;; esac
  shift
done
cp "\${inputs[0]}" "$out"`);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|")) : []);
  return { codesign, lipo, calls };
}

async function runPhase(script: string, env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", repo(script)], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: env.HOME ?? "/nonexistent", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

function xcodeEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    TARGET_BUILD_DIR: join(root, "Products"),
    CONTENTS_FOLDER_PATH: "conch-mac.app/Contents",
    UNLOCALIZED_RESOURCES_FOLDER_PATH: "conch-mac.app/Contents/Resources",
    CONFIGURATION: "Release",
    ARCHS: "arm64",
    CODE_SIGNING_ALLOWED: "YES",
    EXPANDED_CODE_SIGN_IDENTITY: "0123456789ABCDEF0123456789ABCDEF01234567",
    ...extra,
  };
}

const contents = (root: string) => join(root, "Products", "conch-mac.app", "Contents");

// MARK: - The daemon

/** A bun that "compiles" a script reporting `conch <version>`, and logs its argv. */
function fakeBun(root: string, reports = VERSION): string {
  const log = join(root, "bun.log");
  return tool(root, "bun", `
echo "$*" >> '${log}'
out=""
while [[ $# -gt 0 ]]; do [[ "$1" == "--outfile" ]] && out="$2"; shift; done
printf '#!/bin/sh\\n[ "$1" = version ] && echo "conch ${reports}"\\n' > "$out"
chmod +x "$out"`);
}

describe("the app carries its daemon", () => {
  test("the build phase compiles src/cli.ts for the app's architecture into Contents/Helpers/conch-daemon, signed with JIT and the Hardened Runtime", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CONCH_BUN: fakeBun(root), CODESIGN: codesign, LIPO: lipo }));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const daemon = join(contents(root), "Helpers", "conch-daemon");
    expect(statSync(daemon).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(root, "bun.log"), "utf8").trim()).toStartWith("build --compile --target=bun-darwin-arm64 ./src/cli.ts --outfile ");
    expect(calls()).toEqual([[
      "codesign", "--force", "--sign", "0123456789ABCDEF0123456789ABCDEF01234567", "--options", "runtime",
      "--entitlements", repo("mac-app/helpers/conch-daemon.entitlements"), "--timestamp=none", daemon,
    ]]);
    // Which build it is, before signing changed its bytes.
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(daemon)).digest("hex");
    expect(readFileSync(join(contents(root), "Resources", "conch-daemon.sha256"), "utf8")).toBe(`${digest}  conch-daemon\n`);
    // Bun's licence travels with the runtime it embeds.
    expect(readFileSync(join(contents(root), "Resources", "ThirdParty", "bun", "LICENSE.md"), "utf8")).toContain("Bun");
  });

  test("a universal build compiles each architecture and joins them with lipo", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { ARCHS: "arm64 x86_64", CONCH_BUN: fakeBun(root), CODESIGN: codesign, LIPO: lipo }));
    expect(result.code).toBe(0);
    const compiled = readFileSync(join(root, "bun.log"), "utf8").trim().split("\n");
    expect(compiled.map((line) => line.split(" ")[2])).toEqual(["--target=bun-darwin-arm64", "--target=bun-darwin-x64"]);
    expect(calls()[0]![0]).toBe("lipo");
    expect(calls()[0]!.slice(1, 2)).toEqual(["-create"]);
  });

  test("a release embeds the CLI it already compiled (CONCH_DAEMON_BINARY), not a second build", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const cli = tool(root, "conch-cli", `[ "$1" = version ] && echo "conch ${VERSION}"`);
    const result = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CONCH_DAEMON_BINARY: cli, CODESIGN: codesign, LIPO: lipo, CONCH_BUN: "/nonexistent/bun" }));
    expect(result.code).toBe(0);
    expect(readFileSync(join(contents(root), "Helpers", "conch-daemon"), "utf8")).toBe(readFileSync(cli, "utf8"));
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(cli)).digest("hex");
    expect(readFileSync(join(contents(root), "Resources", "conch-daemon.sha256"), "utf8")).toStartWith(digest);
  });

  test("a daemon that reports another version than package.json is refused", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const result = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CONCH_BUN: fakeBun(root, "0.0.1"), CODESIGN: codesign, LIPO: lipo }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`reports 'conch 0.0.1', but package.json is ${VERSION}`);
    expect(existsSync(join(contents(root), "Helpers", "conch-daemon"))).toBeFalse();
  });

  test("a Release build without bun fails; a Debug build warns and goes without", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const release = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CONCH_BUN: "/nonexistent/bun", CODESIGN: codesign, LIPO: lipo }));
    expect(release.code).toBe(1);
    expect(release.stderr).toContain("a Release conch.app must carry its daemon");
    const debug = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CONFIGURATION: "Debug", CONCH_BUN: "/nonexistent/bun", CODESIGN: codesign, LIPO: lipo }));
    expect(debug.code).toBe(0);
    expect(debug.stdout).toContain("warning: bun was not found");
  });

  test("an unsigned build (the CI gate's) embeds and never runs codesign", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-daemon.sh", xcodeEnv(root, { CODE_SIGNING_ALLOWED: "NO", EXPANDED_CODE_SIGN_IDENTITY: "", CONCH_BUN: fakeBun(root), CODESIGN: codesign, LIPO: lipo }));
    expect(result.code).toBe(0);
    expect(existsSync(join(contents(root), "Helpers", "conch-daemon"))).toBeTrue();
    expect(calls()).toEqual([]);
  });
});

// MARK: - The engine

function fakeEngine(root: string, name = "engine"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const binary of ["whisper-cli", "whisper-server", "sox"]) tool(dir, binary, `echo ${binary}-${name}`);
  writeFileSync(join(dir, VAD_MODEL.file), "vad");
  writeFileSync(join(dir, "sox-14.4.2.tar.gz"), "source");
  return dir;
}

describe("the app carries seashell's speech engine", () => {
  test("whisper-cli, whisper-server and sox go to Contents/Helpers and the VAD model to Resources/models, each binary signed; sox with the microphone entitlement", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { CONCH_ENGINE_SOURCE: fakeEngine(root), CODESIGN: codesign, LIPO: lipo }));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const helpers = join(contents(root), "Helpers");
    for (const binary of ["whisper-cli", "whisper-server", "sox"]) {
      expect(statSync(join(helpers, binary)).mode & 0o111).toBe(0o111);
    }
    expect(readFileSync(join(contents(root), "Resources", "models", VAD_MODEL.file), "utf8")).toBe("vad");
    const identity = ["--force", "--sign", "0123456789ABCDEF0123456789ABCDEF01234567", "--options", "runtime"];
    expect(calls()).toEqual([
      ["codesign", ...identity, "--timestamp=none", join(helpers, "whisper-cli")],
      ["codesign", ...identity, "--timestamp=none", join(helpers, "whisper-server")],
      ["codesign", ...identity, "--entitlements", repo("mac-app/helpers/sox.entitlements"), "--timestamp=none", join(helpers, "sox")],
    ]);
    // Licences, and SoX's source beside its binary, as its GPL asks.
    const notices = join(contents(root), "Resources", "ThirdParty");
    expect(readFileSync(join(notices, "whisper.cpp", "LICENSE"), "utf8")).toStartWith("MIT License");
    expect(readFileSync(join(notices, "sox", "LICENSE.GPL"), "utf8")).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(readFileSync(join(notices, "sox", "sox-14.4.2.tar.gz"), "utf8")).toBe("source");
    expect(readFileSync(join(notices, "silero-vad", "LICENSE"), "utf8")).toStartWith("MIT License");
  });

  test("a secure-timestamp release passes its flags to every helper", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { CONCH_ENGINE_SOURCE: fakeEngine(root), CODESIGN: codesign, LIPO: lipo, OTHER_CODE_SIGN_FLAGS: "--timestamp" }));
    expect(result.code).toBe(0);
    for (const call of calls()) expect(call.at(-2)).toBe("--timestamp");
  });

  test("a universal build joins one slice per architecture with lipo", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { ARCHS: "arm64 x86_64", CONCH_ENGINE_SOURCE: fakeEngine(root), CODESIGN: codesign, LIPO: lipo }));
    expect(result.code).toBe(0);
    const lipos = calls().filter((call) => call[0] === "lipo");
    expect(lipos.map((call) => call.at(-1))).toEqual(["whisper-cli", "whisper-server", "sox"].map((b) => join(contents(root), "Helpers", b)));
  });

  test("an engine missing a part is refused", async () => {
    const root = scratch();
    const engine = fakeEngine(root);
    rmSync(join(engine, "sox"));
    const { codesign, lipo } = recorders(root);
    const result = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { CONCH_ENGINE_SOURCE: engine, CODESIGN: codesign, LIPO: lipo }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${engine}/sox is not an executable`);
  });

  test("a Release build that cannot get the engine fails; a Debug build warns and goes without", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const release = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { ARCHS: "i386", CODESIGN: codesign, LIPO: lipo }));
    expect(release.code).toBe(1);
    expect(release.stderr).toContain("a Release conch.app must carry the speech engine");
    const debug = await runPhase("scripts/embed-engine.sh", xcodeEnv(root, { CONFIGURATION: "Debug", ARCHS: "i386", CODESIGN: codesign, LIPO: lipo }));
    expect(debug.code).toBe(0);
    expect(debug.stdout).toContain("has no bundled speech engine");
  });

  test("the engine is pinned: whisper.cpp at seashell's revision, SoX 14.4.2, the VAD model — each by sha256, verified before building", () => {
    const fetch = read("scripts/fetch-engine.sh");
    expect(fetch).toContain("WHISPER_REV=927cfce34f31707e17f2bff35c349632fb9e2c3a");
    expect(fetch).toMatch(/^WHISPER_SHA256=[0-9a-f]{64}$/m);
    expect(fetch).toMatch(/^SOX_SHA256=[0-9a-f]{64}$/m);
    expect(fetch).toContain(`VAD_SHA256=${VAD_MODEL.sha256}`);
    expect(read("scripts/check-app-bundle.sh")).toContain(`VAD_SHA256=${VAD_MODEL.sha256}`);
    expect(fetch).toContain('echo "$2  $3" | shasum -a 256 -c - >&2');
    for (const pinned of ['fetch "$WHISPER_URL" "$WHISPER_SHA256"', 'fetch "$SOX_URL" "$SOX_SHA256"', 'fetch "$VAD_URL" "$VAD_SHA256"']) {
      expect(fetch.indexOf(pinned)).toBeLessThan(fetch.indexOf('tar -xzf "$work/whisper.tar.gz"'));
    }
    // Metal on Apple silicon, static, only system libraries linked.
    expect(fetch).toContain("-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON");
    expect(fetch).toContain("-DBUILD_SHARED_LIBS=OFF");
    expect(fetch).toContain("--with-coreaudio=yes");
    expect(fetch).toContain("links a library outside the system");
  });
});

// MARK: - The project and the scripts that ship it

describe("the build wires it in, and every shipping script checks it", () => {
  const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

  test("the conch-mac target runs both phases after its resources and uv, unsandboxed", () => {
    const target = project.slice(project.indexOf("isa = PBXNativeTarget;"), project.indexOf("/* End PBXNativeTarget section */"));
    const phases = target.slice(target.indexOf("buildPhases = ("), target.indexOf(");", target.indexOf("buildPhases = (")));
    const at = (name: string) => phases.indexOf(`/* ${name} */`);
    expect(at("Resources")).toBeGreaterThan(-1);
    expect(at("Embed uv helper")).toBeGreaterThan(at("Resources"));
    expect(at("Embed conch daemon")).toBeGreaterThan(at("Embed uv helper"));
    expect(at("Embed speech engine")).toBeGreaterThan(at("Embed conch daemon"));
    const section = project.slice(project.indexOf("/* Begin PBXShellScriptBuildPhase section */"), project.indexOf("/* End PBXShellScriptBuildPhase section */"));
    expect(section).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-daemon.sh\\"\\n";');
    expect(section).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-engine.sh\\"\\n";');
  });

  test("the dev install prefers the checkout and checks the bundle it still carries", () => {
    const install = read("scripts/build-app.sh");
    expect(install).toContain("  CONCH_DAEMON_SOURCE=checkout \\\n  build");
    expect(install).toContain('"$SCRIPT_DIR/check-app-bundle.sh" "$INSTALLED_APP_PATH" checkout');
  });

  test("a release builds one app per architecture, embeds the CLI it ships as the daemon, and proves it", () => {
    const release = read("scripts/build-release.sh");
    expect(release).toContain('for pair in "arm64:bun-darwin-arm64:arm64" "x64:bun-darwin-x64:x86_64"; do');
    expect(release).toContain('ARCHS="$xcode_arch" ONLY_ACTIVE_ARCH=NO');
    expect(release).toContain('CONCH_DAEMON_BINARY="$PWD/$DIST/conch" CONCH_DAEMON_SOURCE=bundled');
    expect(release).toContain('scripts/check-app-bundle.sh "$APP_SRC" bundled || exit 1');
    expect(release).toContain('[ "$cli_sha" = "$app_sha" ]');
    // The CLI is compiled before the app that embeds it, and packed beside it.
    expect(release.indexOf('bun build --compile --target="$target"')).toBeLessThan(release.indexOf("xcodebuild -project"));
    expect(release).toContain('tar -C "$DIST" -czf "$DIST/conch-macos-$arch.tar.gz" conch conch.app');
    const cask = read("scripts/release-app.sh");
    expect(cask).toContain('ARCHS="$ARCH" ONLY_ACTIVE_ARCH=NO CONCH_DAEMON_SOURCE=bundled build');
    expect(cask).toContain('scripts/check-app-bundle.sh "$APP" bundled');
  });

  test("the bundle check covers every helper: present, Developer ID, Hardened Runtime, the app's architectures, the entitlements, the version", () => {
    const check = read("scripts/check-app-bundle.sh");
    expect(check).toContain("for helper in conch-daemon whisper-cli whisper-server sox; do");
    expect(check).toContain("'^Authority=Developer ID Application'");
    expect(check).toContain("runtime");
    expect(check).toContain('[[ "$archs" == "$app_archs" ]]');
    expect(check).toContain("com.apple.security.cs.allow-jit");
    expect(check).toContain("com.apple.security.device.audio-input");
    expect(check).toContain('[[ "$reported" == "conch $version" ]]');
    expect(check).toContain('[[ "$source_declared" == "$EXPECT_SOURCE" ]]');
  });

  test("the entitlements are exactly what each helper needs", () => {
    const daemon = read("mac-app/helpers/conch-daemon.entitlements");
    expect([...daemon.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(["com.apple.security.cs.allow-jit"]);
    const sox = read("mac-app/helpers/sox.entitlements");
    expect([...sox.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(["com.apple.security.device.audio-input"]);
 
    // codesign hands these to AMFI's strict XML parser, which refuses a comment
    // holding "--" (plutil -lint accepts it): measured, the Release build failed.
    for (const text of [daemon, sox]) {
      for (const [, comment] of text.matchAll(/<!--([\s\S]*?)-->/g)) expect(comment).not.toContain("--");
    }
  });
});
