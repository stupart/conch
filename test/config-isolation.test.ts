import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertUnderTestRoot } from "./isolation-guard.ts";
import { conchHome } from "../src/home.ts";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_CONCH_CONFIG_DIR } from "../src/settings.ts";
import { defaultUninstallPaths } from "../src/uninstall.ts";
import { SOX_RECORD_PATH } from "../src/sox-orphan.ts";
import { IDENTITY_PATH } from "../src/daemon-identity.ts";
import { WHISPER_RECORD_PATH } from "../src/whisper-orphan.ts";

const root = process.env.CONCH_TEST_ROOT ?? "";

/**
 * `homedir()` is deliberately NOT redirected — Bun caches it at process start,
 * so it still names the real home. That makes it the honest reference for
 * "would this have hit Tyler's machine?".
 */
describe("the suite cannot reach the real configuration", () => {
  test("the test root is a temp directory, not a home directory", () => {
    expect(root).not.toBe("");
    expect(root.startsWith(homedir())).toBe(false);
  });

  test("conch resolves its home to the temp root, not the real one", () => {
    expect(conchHome()).not.toBe(homedir());
    assertUnderTestRoot({ "conch home": conchHome() }, root);
  });

  /**
   * The paths from the hazard, resolved exactly as the installers and the
   * uninstaller resolve them. Import-time constants are included on purpose:
   * they are the ones a preload can only win against by running first.
   */
  test("every path the installers write to lands inside the temp root", () => {
    const cfg = loadConfig({ env: {}, settingsPath: join(root, "settings.json") });
    const paths = defaultUninstallPaths(cfg);
    assertUnderTestRoot({
      "Claude settings": paths.claudeSettings,
      "Claude instructions": paths.claudeInstructions,
      "Codex hooks": paths.codexHooks,
      "Codex instructions": paths.codexInstructions,
      "launchd plist": paths.servicePlist,
      "speech models": paths.modelsDir,
      "Claude config dir": cfg.claudeDir,
      "Codex config.toml": join(conchHome(), ".codex", "config.toml"),
      "Claude plugins": join(conchHome(), ".claude", "plugins"),
      LaunchAgents: join(conchHome(), "Library", "LaunchAgents"),
      "conch config dir": DEFAULT_CONCH_CONFIG_DIR,
      "sox recorders": SOX_RECORD_PATH,
      "daemon identity": IDENTITY_PATH,
      "whisper records": WHISPER_RECORD_PATH,
    }, root);
  });

  /**
   * The guard proving itself: a deliberate attempt to resolve the real
   * `~/.claude/settings.json` inside the suite has to fail, and the failure has
   * to name the path so whoever hits it knows which default escaped.
   */
  test("a deliberate reach for the real ~/.claude/settings.json fails, naming it", () => {
    const real = join(homedir(), ".claude", "settings.json");
    expect(() => assertUnderTestRoot({ "Claude settings": real }, root)).toThrow(real);
    expect(() => assertUnderTestRoot({ "Claude settings": real }, root))
      .toThrow("conch test isolation broken");

    for (const escape of [
      join(homedir(), ".codex", "config.toml"),
      join(homedir(), "Library", "LaunchAgents", "com.conch.daemon.plist"),
      join(homedir(), ".claude", "plugins"),
      `${root}-sibling/settings.json`, // a prefix match is not containment
    ]) {
      expect(() => assertUnderTestRoot({ escape }, root)).toThrow(escape);
    }
  });

  /**
   * `runService` shells out to `launchctl bootstrap` and writes a real
   * LaunchAgent; `runSetup` runs the whole installer. Neither is injectable, so
   * the rule is simply that no test calls them.
   */
  test("no test runs launchctl or a real service install", () => {
    const here = import.meta.dir;
    const offenders = readdirSync(here)
      .filter((name) => name.endsWith(".test.ts") && name !== "config-isolation.test.ts")
      .filter((name) => /\brunService\s*\(|\brunSetup\s*\(/.test(readFileSync(join(here, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  /**
   * The tripwire has to stay armed. Deleting the preload's guard call or its
   * CONCH_HOME redirect is exactly the regression this file exists to catch.
   */
  test("the preload arms the guard and the redirect before any test runs", () => {
    const preload = readFileSync(join(import.meta.dir, "preload.ts"), "utf8");
    expect(preload).toContain("assertUnderTestRoot({");
    expect(preload).toContain("process.env.CONCH_HOME = testHome;");
  });
});
