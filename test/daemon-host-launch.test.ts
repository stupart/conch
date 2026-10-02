import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Which daemon conch.app runs (DaemonHost.launchCommand), exercised for real:
 * the app's own Swift, compiled with a small harness
 * (test/fixtures/daemon-launch-main.swift) and run against a fake filesystem.
 *
 * "Download one thing and it works" (Tyler) — so a release runs the daemon it
 * carries, then Homebrew's `conch` on PATH, then a checkout; and "the bundled
 * binary would be stale the moment anyone edits the source" — so the dev
 * install (build-app.sh, `ConchDaemonSource=checkout`) runs the checkout first,
 * and still falls back to the bundled daemon when there is none.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
let root = "";
let lines = new Map<string, string>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "conch-daemon-launch-"));
  copyFileSync(repo("test/fixtures/daemon-launch-main.swift"), join(root, "main.swift"));
  const binary = join(root, "launch");
  const compile = Bun.spawnSync(
    ["swiftc", "-swift-version", "5", repo("mac-app/conch-mac/DaemonHost.swift"),
      repo("design/ConchDesign/Sources/ConchDesign/DaemonHealth.swift"),
      repo("design/ConchDesign/Sources/ConchDesign/DaemonEnvironment.swift"), join(root, "main.swift"), "-o", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (compile.exitCode !== 0) throw new Error(`swiftc failed:\n${compile.stderr.toString()}`);
  const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: `${root}/` } });
  if (run.exitCode !== 0) throw new Error(`the harness failed:\n${run.stderr.toString()}`);
  lines = new Map(run.stdout.toString().trim().split("\n").map((line) => {
    const space = line.indexOf(" ");
    return [line.slice(0, space), line.slice(space + 1)] as const;
  }));
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const BUNDLED = "bundled /Applications/conch.app/Contents/Helpers/conch-daemon daemon";
const CHECKOUT = "checkout /Users/tester/.bun/bin/bun /Users/tester/conch/src/cli.ts,daemon";
const BREW = "path /opt/homebrew/bin/conch daemon";

describe("a release runs the daemon it carries", () => {
  test("the bundled daemon wins over Homebrew's and a checkout", () => {
    expect(lines.get("release-all")).toBe(BUNDLED);
  });

  test("without one, Homebrew's conch on PATH, then a checkout, then nothing", () => {
    expect(lines.get("release-no-bundle")).toBe(BREW);
    expect(lines.get("release-checkout-only")).toBe(CHECKOUT);
    expect(lines.get("release-nothing")).toBe("none");
  });

  test("any conch on the PATH the app inherited counts, after Homebrew's own directories", () => {
    expect(lines.get("inherited-path")).toBe("path /Users/tester/tools/conch daemon");
  });

  test("an app with no ConchDaemonSource key behaves as a release", () => {
    expect(lines.get("no-plist-key")).toBe(BUNDLED);
    expect(lines.get("prefers-checkout-release")).toBe("false");
  });
});

describe("the dev install runs the checkout, and never ends up with nothing", () => {
  test("ConchDaemonSource=checkout puts the checkout first", () => {
    expect(lines.get("prefers-checkout-plist")).toBe("true");
    expect(lines.get("dev-all")).toBe(CHECKOUT);
  });

  test("a missing checkout (or one without bun) falls back to the bundled daemon, then PATH", () => {
    expect(lines.get("dev-no-checkout")).toBe(BUNDLED);
    expect(lines.get("dev-checkout-without-bun")).toBe(BUNDLED);
    expect(lines.get("dev-only-path")).toBe(BREW);
  });

  test("CONCH_DAEMON_SOURCE in the environment beats the Info.plist, either way", () => {
    expect(lines.get("env-beats-plist")).toBe(CHECKOUT);
    expect(lines.get("env-bundled-beats-dev-plist")).toBe(BUNDLED);
  });
});

describe("the only daemon the health check may stop is the one on this socket that wrote the identity file", () => {
  // A frozen daemon is stopped by the pid in ~/.cache/conch/daemon.json when the app adopted it (DaemonHealth). That
  // pid must be the daemon's: on the app's socket, and started before it wrote the file — a pid reused since by
  // another process started after.
  test("the daemon that wrote it, on this socket, may be signalled", () => {
    expect(lines.get("identity-current")).toBe("4242");
  });

  test("another socket's daemon, a record with no time, a reused pid and no record are never signalled", () => {
    expect(lines.get("identity-other-socket")).toBe("none");
    expect(lines.get("identity-older-daemon")).toBe("none");
    expect(lines.get("identity-reused-pid")).toBe("none");
    expect(lines.get("identity-process-gone")).toBe("none");
    expect(lines.get("identity-absent")).toBe("none");
  });
});

describe("the app and its build agree", () => {
  const host = readFileSync(repo("mac-app/conch-mac/DaemonHost.swift"), "utf8");
  const project = readFileSync(repo("mac-app/conch-mac.xcodeproj/project.pbxproj"), "utf8");
  const plist = readFileSync(repo("mac-app/conch-mac/Info.plist"), "utf8");

  test("the lookup is Contents/Helpers/conch-daemon, where scripts/embed-daemon.sh installs it", () => {
    expect(host).toContain('bundle.bundleURL.appendingPathComponent("Contents/Helpers/conch-daemon")');
    expect(readFileSync(repo("scripts/embed-daemon.sh"), "utf8")).toContain('DAEMON="$HELPERS/conch-daemon"');
  });

  test("the preference is read from ConchDaemonSource, which the build setting fills: checkout in Debug, bundled in Release", () => {
    expect(host).toContain('bundle.object(forInfoDictionaryKey: "ConchDaemonSource")');
    expect(plist).toContain("<key>ConchDaemonSource</key>\n\t<string>$(CONCH_DAEMON_SOURCE)</string>");
    for (const [config, value] of [["A80000000000000000000003 /* Debug */", "checkout"], ["A80000000000000000000004 /* Release */", "bundled"]]) {
      const at = project.indexOf(`${config} = {`);
      expect(at).toBeGreaterThan(-1);
      expect(project.slice(at, project.indexOf("name = ", at))).toContain(`CONCH_DAEMON_SOURCE = ${value};`);
    }
  });

  test("whichever daemon runs is told which app launched it, so it uses this app's engine", () => {
    const set = host.indexOf('environment["CONCH_APP_BUNDLE"] = Bundle.main.bundleURL.path');
    expect(set).toBeGreaterThan(-1);
    expect(host.slice(set - 120, set)).toContain('if environment["CONCH_APP_BUNDLE"] == nil {');
    expect(host.indexOf("task.environment = environment")).toBeGreaterThan(set);
  });
});
