import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTmux } from "../src/doctor-checks.ts";
import type { SpeechEngineStatus } from "../src/speech-engine.ts";
import { describeTmux, resolveTmux, type TmuxBinary } from "../src/tmux-binary.ts";

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
  test("one line per case: where it came from, or what to fix", () => {
    expect(describeTmux({ path: "/A/conch.app/Contents/Helpers/tmux", source: "conch.app", found: true }))
      .toBe("tmux from the app (/A/conch.app/Contents/Helpers/tmux) — conch's own sessions run in it");
    expect(describeTmux({ path: "/opt/homebrew/bin/tmux", source: "homebrew", found: true })).toStartWith("tmux from Homebrew (/opt/homebrew/bin/tmux)");
    expect(describeTmux({ path: "/x/tmux", source: "explicit", found: true })).toStartWith("tmux from CONCH_TMUX (/x/tmux)");
    expect(describeTmux({ path: "/usr/bin/tmux", source: "PATH", found: true })).toStartWith("tmux from PATH (/usr/bin/tmux)");
    expect(describeTmux({ path: "/x/tmux", source: "explicit", found: false })).toBe("tmux: CONCH_TMUX=/x/tmux is not an executable — fix the setting or unset it");
    expect(describeTmux({ path: "tmux", source: "missing", found: false })).toContain("not found — the conch app carries one");
  });

  const published = (tmux: unknown, pid = 42) => () => ({ pid, parts: { tmux } }) as unknown as SpeechEngineStatus & { pid: number };

  test("the doctor reports the live daemon's tmux (it resolves from the app that launched it), else resolves here", () => {
    const app = { path: "/A/conch.app/Contents/Helpers/tmux", source: "conch.app", found: true };
    const here = (): TmuxBinary => ({ path: "/opt/homebrew/bin/tmux", source: "homebrew", found: true });
    expect(checkTmux({ published: published(app), resolve: here }))
      .toEqual({ ok: true, label: "tmux", message: "tmux from the app (/A/conch.app/Contents/Helpers/tmux) — conch's own sessions run in it (daemon 42)." });
    expect(checkTmux({ published: () => null, resolve: here }).message).toBe("tmux from Homebrew (/opt/homebrew/bin/tmux) — conch's own sessions run in it.");
    // A daemon from before the app carried tmux published no source: resolve here.
    expect(checkTmux({ published: published({ found: true, path: "/opt/homebrew/bin/tmux" }), resolve: here }).message).not.toContain("daemon 42");
  });

  test("tmux is optional — missing is not a failure — but a CONCH_TMUX naming nothing is", () => {
    expect(checkTmux({ published: () => null, resolve: () => ({ path: "tmux", source: "missing", found: false }) }).ok).toBeTrue();
    const broken = checkTmux({ published: () => null, resolve: () => ({ path: "/x/tmux", source: "explicit", found: false }) });
    expect(broken.ok).toBeFalse();
    expect(broken.action).toContain("CONCH_TMUX");
  });

  test("the daemon publishes resolveTmux beside the speech engine, and `conch doctor` prints the probe", () => {
    const daemon = read("src/daemon.ts");
    const manager = daemon.slice(daemon.indexOf("new SpeechEngineManager({"), daemon.indexOf("});", daemon.indexOf("new SpeechEngineManager({")));
    expect(manager).toContain("tmux: () => resolveTmux(),");
    expect(read("src/speech-engine.ts")).toContain("tmux: { found: tmux.found, path: tmux.path, source: tmux.source },");
    expect(read("src/install.ts")).toContain("console.log(formatDoctorProbe(checkTmux()));");
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

  test("the conch-mac target runs the phase after the speech engine, unsandboxed", () => {
    const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
    const target = project.slice(project.indexOf("isa = PBXNativeTarget;"), project.indexOf("/* End PBXNativeTarget section */"));
    expect(target).toContain('name = "conch-mac";');
    const phases = target.slice(target.indexOf("buildPhases = ("), target.indexOf(");", target.indexOf("buildPhases = (")));
    expect(phases.indexOf("/* Embed tmux */")).toBeGreaterThan(phases.indexOf("/* Embed speech engine */"));
    expect(phases.indexOf("/* Embed speech engine */")).toBeGreaterThan(-1);
    const section = project.slice(project.indexOf("/* Begin PBXShellScriptBuildPhase section */"), project.indexOf("/* End PBXShellScriptBuildPhase section */"));
    const phase = section.slice(section.indexOf("/* Embed tmux */ = {"));
    expect(phase).toContain('name = "Embed tmux";');
    expect(phase).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-tmux.sh\\"\\n";');
    // Sandboxed script phases cannot read the repo's scripts or run codesign.
    for (const config of ["A80000000000000000000003 /* Debug */", "A80000000000000000000004 /* Release */"]) {
      const at = project.indexOf(`${config} = {`);
      expect(project.slice(at, project.indexOf("name = ", at))).toContain("ENABLE_USER_SCRIPT_SANDBOXING = NO;");
    }
  });

  test("every shipping script's bundle check covers tmux: signed, Hardened Runtime, the app's architectures, notices, system-only links", () => {
    const check = read("scripts/check-app-bundle.sh");
    expect(check).toContain("for helper in conch-daemon whisper-cli whisper-server sox tmux; do");
    for (const notice of NOTICES) expect(check).toContain(`ThirdParty/tmux/${notice}`);
    expect(check).toContain('[[ "$(env -i PATH=/usr/bin:/bin "$HELPERS/tmux" -V)" == "tmux $TMUX_VERSION" ]]');
    expect(check).toContain(`outside="$(otool -L "$HELPERS/tmux" | tail -n +2 | awk '{print $1}' | grep -vE '^(/System/Library/Frameworks/|/usr/lib/)' || true)"`);
    expect(check).toContain('[[ -z "$outside" ]] || fail "$HELPERS/tmux links a library outside the system: $outside"');
    expect(check).toContain(`TMUX_VERSION="$(sed -n 's/^TMUX_VERSION=//p' "$REPO_ROOT/scripts/fetch-tmux.sh")"`);
  });
});

// MARK: - The recipe and its notices

describe("tmux is built from pinned sources, reproducibly, linking only the system", () => {
  const fetch = read("scripts/fetch-tmux.sh");
  const pin = (name: string) => fetch.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];

  test("tmux, libevent, jemalloc and utf8proc are each pinned by version and sha256, verified before anything is unpacked", () => {
    expect(pin("TMUX_VERSION")).toBe("3.7c");
    expect(pin("LIBEVENT_VERSION")).toBe("2.1.13-stable");
    expect(pin("JEMALLOC_VERSION")).toBe("5.3.1");
    expect(pin("UTF8PROC_VERSION")).toBe("2.11.3");
    // The digests Homebrew's formulae pin for the same releases.
    expect(pin("TMUX_SHA256")).toBe("7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf");
    expect(pin("LIBEVENT_SHA256")).toBe("f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c");
    expect(pin("JEMALLOC_SHA256")).toBe("3826bc80232f22ed5c4662f3034f799ca316e819103bdc7bb99018a421706f92");
    expect(pin("UTF8PROC_SHA256")).toBe("abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78");
    const unpack = fetch.indexOf("tar -x");
    for (const name of ["TMUX", "LIBEVENT", "JEMALLOC", "UTF8PROC"]) {
      const at = fetch.indexOf(`"$SCRIPT_DIR/fetch-pinned.sh" "$${name}_URL" "$${name}_SHA256"`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(unpack);
    }
    // Every unpack reads the verified cache, never the partial.
    for (const line of fetch.split("\n").filter((l) => l.startsWith("tar -x"))) expect(line).toContain('"$SOURCES/');
  });

  test("configured as Homebrew does on macOS — utf8proc, jemalloc, sixel — with the pane TERM pinned, not probed", () => {
    expect(fetch).toContain("--enable-utf8proc --enable-jemalloc --enable-sixel --with-TERM=\"$DEFAULT_TERM\"");
    expect(pin("DEFAULT_TERM")).toBe("screen-256color");
    expect(fetch).toContain("--with-jemalloc-prefix=je_");
    expect(fetch).toContain("-Wl,-u,_je_zone_register");
    for (const feature of ['"utf8proc: $UTF8PROC_VERSION|utf8proc: on"', '"jemalloc: on"', '"ncurses: on"']) expect(fetch).toContain(feature);
  });

  test("the SDK's functions newer than the minimum macOS are ruled out, and any weak import fails the build", () => {
    expect(pin("MACOS_MIN")).toBe("14.0");
    expect(fetch).toContain("too_new=(ac_cv_func_pipe2=no ac_cv_func_dup3=no)");
    for (const step of ["libevent-configure", "jemalloc-configure", "tmux-configure"]) {
      const line = fetch.split("\n").find((l) => l.startsWith(`step ${step} `))!;
      expect(line).toContain('"${too_new[@]}"');
    }
    expect(fetch).toContain(`weak="$(nm -m "$binary" | grep '(undefined) weak external' | grep -v ' _malloc_default_purgeable_zone ' || true)"`);
    expect(fetch).toContain('[[ -z "$weak" ]] || {');
  });

  test("only the system is linked dynamically — ncurses included — and what should be linked in is", () => {
    expect(fetch).toContain(`outside="$(grep -vE '^(/System/Library/Frameworks/|/usr/lib/)' <<<"$links" || true)"`);
    expect(fetch).toContain('[[ -z "$outside" ]] || { echo "error: $binary links a library outside the system: $outside" >&2; exit 1; }');
    expect(fetch).toContain(`grep -qx '/usr/lib/libncurses.5.4.dylib' <<<"$links"`);
    expect(fetch).toContain("for symbol in _je_zone_register _je_mallctl _utf8proc_charwidth _event_base_loop; do");
    expect(fetch).toContain('symbols="$(nm "$binary")"');
    expect(fetch).toContain('[[ "$(lipo -archs "$binary")" == "$ARCH" ]] || {');
  });

  test("reproducible: a clean environment, pinned dates, no build paths or debug map in the binary", () => {
    expect(fetch).toContain('clean_env=(env -i "HOME=$HOME" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" "MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN"');
    expect(fetch).toContain('"SOURCE_DATE_EPOCH=1767225600" "ZERO_AR_DATE=1" "LC_ALL=C"');
    expect(fetch).toContain("-ffile-prefix-map=$work=.");
    expect(fetch).toContain('ldflags="-arch $ARCH -mmacosx-version-min=$MACOS_MIN -Wl,-S"');
    expect(fetch).toContain('if grep -aq "$work" "$binary"; then');
    // A cache is reused only for this recipe, and only as the bytes it recorded.
    expect(fetch).toContain('"$(cat "$OUT/recipe" 2>/dev/null)" == "$RECIPE"');
    expect(fetch).toContain('(cd "$OUT" && shasum -a 256 -c tmux.sha256 >/dev/null 2>&1)');
    expect(fetch).toContain('OUT="$CACHE_ROOT/tmux-$TMUX_VERSION-$ARCH"');
  });

  test("the checked-in licences are the pinned sources' own, compared at every build", () => {
    for (const pair of ['"$tmux_src/COPYING:COPYING"', '"$libevent_src/LICENSE:LICENSE.libevent"', '"$jemalloc_src/COPYING:COPYING.jemalloc"', '"$utf8proc_src/LICENSE.md:LICENSE.utf8proc.md"']) {
      expect(fetch).toContain(pair);
    }
    expect(fetch).toContain('cmp -s "${pair%%:*}" "$NOTICES/${pair#*:}" || {');
    // …and every compat file this build compiled in has its notice, verbatim, in LICENSE.compat.
    expect(fetch).toContain('for object in "$tmux_src"/compat/*.o; do compat+=("compat/$(basename "${object%.o}").c"); done');
    expect(fetch).toContain('[[ "$shipped" == *"$block"* ]] || unlisted+=("$file")');
    expect(fetch).toContain('[[ "${#unlisted[@]}" -eq 0 ]] || {');
  });
});

describe("its notices say what ships", () => {
  const notice = (name: string) => read(`mac-app/third-party/tmux/${name}`);
  const fetch = read("scripts/fetch-tmux.sh");
  const pin = (name: string) => fetch.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];

  test("the NOTICE names the helper, every library and version the recipe pins, and the system's ncurses", () => {
    const text = notice("NOTICE");
    expect(text).toContain("Contents/Helpers/tmux");
    expect(text).toContain(`tmux ${pin("TMUX_VERSION")}`);
    expect(text).toContain(`libevent ${pin("LIBEVENT_VERSION")}`);
    expect(text).toContain(`jemalloc ${pin("JEMALLOC_VERSION")}`);
    expect(text).toContain(`utf8proc ${pin("UTF8PROC_VERSION")}`);
    expect(text).toContain("/usr/lib/libncurses.5.4.dylib");
    for (const name of ["COPYING", "LICENSE.compat", "LICENSE.libevent", "COPYING.jemalloc", "LICENSE.utf8proc.md"]) expect(text).toContain(name);
  });

  test("the licences are the upstream texts: ISC, BSD 3-clause, BSD 2-clause, MIT, and the BSD compat code", () => {
    expect(notice("COPYING")).toContain("Permission to use, copy, modify, and distribute this software for any");
    expect(notice("LICENSE.libevent")).toContain("Redistribution and use in source and binary forms");
    expect(notice("COPYING.jemalloc")).toStartWith("Unless otherwise specified, files in the jemalloc source distribution are");
    expect(notice("LICENSE.utf8proc.md")).toContain('MIT "expat"');
    const compat = notice("LICENSE.compat");
    // What both slices compile in, and strtonum.c, which only the Intel one (a cross build) does.
    for (const file of ["compat/vis.c", "compat/unvis.c", "compat/daemon.c", "compat/queue.h", "compat/tree.h", "compat/imsg.c", "compat/strtonum.c"]) {
      expect(compat).toContain(`==> ${file} <==`);
    }
    expect(compat).toContain("The Regents of the University of California");
  });
});
