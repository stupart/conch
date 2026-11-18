import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTmux } from "../src/doctor-checks.ts";
import type { SpeechEngineStatus } from "../src/speech-engine.ts";
import { resolveTmux, type TmuxBinary } from "../src/tmux-binary.ts";

/**
 * conch hosts sessions in its own tmux server, so conch.app carries tmux:
 * scripts/fetch-tmux.sh builds tmux 3.7c from pinned, sha256-checked sources
 * (libevent, jemalloc and utf8proc linked in statically, only the system linked
 * dynamically) and scripts/embed-tmux.sh puts it at Contents/Helpers/tmux,
 * signed like the app. "Download one thing and it works." (Tyler.) The daemon
 * resolves it CONCH_TMUX → the app → Homebrew → PATH, and publishes which.
 * The build phase runs here as Xcode runs it, with stand-ins for codesign and
 * lipo; the CI gate builds the app unsigned, so the scripts are the check.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const read = (path: string) => readFileSync(repo(path), "utf8");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-tmux-bundle-"));
  roots.push(root);
  return root;
}

function tool(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// MARK: - Resolution

const APP = "/Applications/conch.app";
const HOME = "/Users/someone";

/** resolveTmux over a pretend file system: `present` are the executables that exist. */
function resolveWith(present: string[], env: Record<string, string> = {}, extra: { execPath?: string; which?: string | null } = {}): TmuxBinary {
  return resolveTmux({
    env,
    home: HOME,
    execPath: extra.execPath ?? "/usr/local/bin/bun",
    executable: (path) => present.includes(path),
    which: () => extra.which ?? null,
    brewPrefixes: ["/opt/homebrew", "/usr/local"],
  });
}

describe("conch's tmux resolves: CONCH_TMUX, then the app's own, then Homebrew, then PATH", () => {
  const appTmux = `${APP}/Contents/Helpers/tmux`;

  test("with everything installed, the app's own copy wins", () => {
    expect(resolveWith([appTmux, "/opt/homebrew/bin/tmux", "/usr/bin/tmux"], {}, { which: "/usr/bin/tmux" }))
      .toEqual({ path: appTmux, source: "conch.app", found: true });
  });

  test("CONCH_APP_BUNDLE (what the app hands its daemon) is the app looked in, and the only one", () => {
    const other = "/Volumes/dmg/conch.app";
    expect(resolveWith([appTmux, `${other}/Contents/Helpers/tmux`], { CONCH_APP_BUNDLE: other }))
      .toEqual({ path: `${other}/Contents/Helpers/tmux`, source: "conch.app", found: true });
    // An app without tmux (an older build) is not routed around to another copy of conch.
    expect(resolveWith([appTmux, "/opt/homebrew/bin/tmux"], { CONCH_APP_BUNDLE: other }))
      .toEqual({ path: "/opt/homebrew/bin/tmux", source: "homebrew", found: true });
  });

  test("the bundled daemon finds the app it sits in", () => {
    const inside = "/Users/someone/Downloads/conch.app";
    expect(resolveWith([`${inside}/Contents/Helpers/tmux`, appTmux], {}, { execPath: `${inside}/Contents/Helpers/conch-daemon` }))
      .toEqual({ path: `${inside}/Contents/Helpers/tmux`, source: "conch.app", found: true });
  });

  test("an explicit CONCH_TMUX beats everything — even when it is missing, which is a setting to fix", () => {
    expect(resolveWith([appTmux, "/custom/tmux"], { CONCH_TMUX: "/custom/tmux" }))
      .toEqual({ path: "/custom/tmux", source: "explicit", found: true });
    expect(resolveWith([appTmux], { CONCH_TMUX: "/nowhere/tmux" }))
      .toEqual({ path: "/nowhere/tmux", source: "explicit", found: false });
    // Blank is unset.
    expect(resolveWith([appTmux], { CONCH_TMUX: "  " }).source).toBe("conch.app");
  });

  test("without the app: Apple silicon's Homebrew, then Intel's, then PATH", () => {
    expect(resolveWith(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]).path).toBe("/opt/homebrew/bin/tmux");
    expect(resolveWith(["/usr/local/bin/tmux"])).toEqual({ path: "/usr/local/bin/tmux", source: "homebrew", found: true });
    expect(resolveWith(["/opt/local/bin/tmux"], {}, { which: "/opt/local/bin/tmux" }))
      .toEqual({ path: "/opt/local/bin/tmux", source: "PATH", found: true });
  });

  test("found nowhere, it is bare `tmux` — as conch always spawned it — and says so", () => {
    expect(resolveWith([])).toEqual({ path: "tmux", source: "missing", found: false });
    // A PATH answer that is not an executable file is not a tmux.
    expect(resolveWith([], {}, { which: "/stale/tmux" })).toEqual({ path: "tmux", source: "missing", found: false });
  });

  test("a real bundle on disk: the app's Contents/Helpers/tmux, found through CONCH_APP_BUNDLE", () => {
    const root = scratch();
    const app = join(root, "conch.app");
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    const helper = tool(join(app, "Contents", "Helpers"), "tmux", "echo tmux 3.7c");
    expect(resolveTmux({ env: { CONCH_APP_BUNDLE: app }, which: () => null, brewPrefixes: [] }))
      .toEqual({ path: helper, source: "conch.app", found: true });
    chmodSync(helper, 0o644);
    expect(resolveTmux({ env: { CONCH_APP_BUNDLE: app }, which: () => null, brewPrefixes: [] }).found).toBeFalse();
  });
});

describe("which tmux is in use is published, and the doctor says it", () => {
  const published = (tmux: unknown, pid = 42) => () => ({ pid, parts: { tmux } }) as unknown as SpeechEngineStatus & { pid: number };

  test("the doctor reports the live daemon's tmux (it resolves from the app that launched it), else resolves here", () => {
    const app = { path: "/A/conch.app/Contents/Helpers/tmux", source: "conch.app", found: true };
    const here = (): TmuxBinary => ({ path: "/opt/homebrew/bin/tmux", source: "homebrew", found: true });
    const live = checkTmux({ published: published(app), resolve: here });
    expect(live.ok).toBeTrue();
    expect(live.message).toContain("/A/conch.app/Contents/Helpers/tmux");
    expect(live.message).toContain("daemon 42");
    expect(checkTmux({ published: () => null, resolve: here }).message).toContain("/opt/homebrew/bin/tmux");
    // A daemon from before the app carried tmux published no source: resolve here.
    expect(checkTmux({ published: published({ found: true, path: "/opt/homebrew/bin/tmux" }), resolve: here }).message).not.toContain("daemon 42");
  });

  test("tmux is optional — missing is not a failure — but a CONCH_TMUX naming nothing is", () => {
    expect(checkTmux({ published: () => null, resolve: () => ({ path: "tmux", source: "missing", found: false }) }).ok).toBeTrue();
    const broken = checkTmux({ published: () => null, resolve: () => ({ path: "/x/tmux", source: "explicit", found: false }) });
    expect(broken.ok).toBeFalse();
    expect(broken.action).toContain("CONCH_TMUX");
  });

});

// MARK: - The build phase

/** codesign and lipo that append their argv (one call per line, args joined by |) to a log. */
function recorders(root: string) {
  const log = join(root, "calls.log");
  const codesign = tool(root, "codesign", `echo "codesign|$(IFS='|'; echo "$*")" >> '${log}'`);
  const lipo = tool(root, "lipo", `
echo "lipo|$(IFS='|'; echo "$*")" >> '${log}'
out=""; inputs=()
while [[ $# -gt 0 ]]; do
  case "$1" in -create) ;; -output) out="$2"; shift ;; *) inputs+=("$1") ;; esac
  shift
done
cat "\${inputs[@]}" > "$out"`);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("|")) : []);
  return { codesign, lipo, calls };
}

function fakeTmux(root: string): string {
  const dir = join(root, "tmux-build");
  mkdirSync(dir, { recursive: true });
  tool(dir, "tmux", "echo 'tmux 3.7c'");
  return dir;
}

async function runEmbed(root: string, env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", repo("scripts/embed-tmux.sh")], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/nonexistent",
      TARGET_BUILD_DIR: join(root, "Products"),
      CONTENTS_FOLDER_PATH: "conch-mac.app/Contents",
      UNLOCALIZED_RESOURCES_FOLDER_PATH: "conch-mac.app/Contents/Resources",
      CONFIGURATION: "Release",
      ARCHS: "arm64",
      CODE_SIGNING_ALLOWED: "YES",
      EXPANDED_CODE_SIGN_IDENTITY: "0123456789ABCDEF0123456789ABCDEF01234567",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const contents = join(root, "Products", "conch-mac.app", "Contents");
  return { code: await proc.exited, stdout, stderr, helper: join(contents, "Helpers", "tmux"), notices: join(contents, "Resources", "ThirdParty", "tmux") };
}

const NOTICES = ["NOTICE", "COPYING", "LICENSE.compat", "LICENSE.libevent", "COPYING.jemalloc", "LICENSE.utf8proc.md"];

describe("the app carries tmux", () => {
  test("the build phase puts tmux at Contents/Helpers/tmux, signed with the app's identity and the Hardened Runtime, no entitlements", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const source = fakeTmux(root);
    const result = await runEmbed(root, { CONCH_TMUX_SOURCE: source, CODESIGN: codesign, LIPO: lipo });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(readFileSync(result.helper, "utf8")).toBe(readFileSync(join(source, "tmux"), "utf8"));
    expect(statSync(result.helper).mode & 0o777).toBe(0o755);
    expect(calls()).toEqual([[
      "codesign", "--force", "--sign", "0123456789ABCDEF0123456789ABCDEF01234567", "--options", "runtime", "--timestamp=none", result.helper,
    ]]);
    // Every licence travels with it, byte for byte the checked-in notices.
    for (const notice of NOTICES) {
      expect(readFileSync(join(result.notices, notice), "utf8")).toBe(read(`mac-app/third-party/tmux/${notice}`));
    }
  });

  test("a secure-timestamp release passes its flags to the helper too", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runEmbed(root, { CONCH_TMUX_SOURCE: fakeTmux(root), CODESIGN: codesign, LIPO: lipo, OTHER_CODE_SIGN_FLAGS: "--timestamp" });
    expect(result.code).toBe(0);
    expect(calls()[0]!.slice(-2)).toEqual(["--timestamp", result.helper]);
  });

  test("a universal build joins one slice per architecture with lipo, then signs the result", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const source = fakeTmux(root);
    const result = await runEmbed(root, { ARCHS: "arm64 x86_64", CONCH_TMUX_SOURCE: source, CODESIGN: codesign, LIPO: lipo });
    expect(result.code).toBe(0);
    expect(calls().map((call) => call[0])).toEqual(["lipo", "codesign"]);
    expect(calls()[0]).toEqual(["lipo", "-create", join(source, "tmux"), join(source, "tmux"), "-output", result.helper]);
    expect(statSync(result.helper).mode & 0o111).toBe(0o111);
  });

  test("an unsigned build (the CI gate's) embeds and never runs codesign", async () => {
    const root = scratch();
    const { codesign, lipo, calls } = recorders(root);
    const result = await runEmbed(root, { CODE_SIGNING_ALLOWED: "NO", EXPANDED_CODE_SIGN_IDENTITY: "", CONCH_TMUX_SOURCE: fakeTmux(root), CODESIGN: codesign, LIPO: lipo });
    expect(result.code).toBe(0);
    expect(existsSync(result.helper)).toBeTrue();
    expect(calls()).toEqual([]);
    expect(result.stdout).toContain("code signing is off");
  });

  test("a source without an executable tmux is refused", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const empty = join(root, "empty");
    mkdirSync(empty);
    const result = await runEmbed(root, { CONCH_TMUX_SOURCE: empty, CODESIGN: codesign, LIPO: lipo });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${empty}/tmux is not an executable`);
    expect(existsSync(result.helper)).toBeFalse();
  });

  test("a Release build that cannot get tmux fails; a Debug build warns and goes without", async () => {
    const root = scratch();
    const { codesign, lipo } = recorders(root);
    const release = await runEmbed(root, { ARCHS: "i386", CODESIGN: codesign, LIPO: lipo });
    expect(release.code).toBe(1);
    expect(release.stderr).toContain("a Release conch.app must carry tmux");
    const debug = await runEmbed(root, { CONFIGURATION: "Debug", ARCHS: "i386", CODESIGN: codesign, LIPO: lipo });
    expect(debug.code).toBe(0);
    expect(debug.stdout).toContain("has no Contents/Helpers/tmux");
    expect(existsSync(debug.helper)).toBeFalse();
  });

});
