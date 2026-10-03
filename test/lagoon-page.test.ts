import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The lagoon as a page in the Mac app (phase A, 2026-10-04; the brand repo's experiments/bridge/MAC-APP-SPEC.md):
 *
 * - scripts/build-app.sh carries the page into conch.app only when the brand repo is on the Mac, and nothing of it is ever
 *   committed here;
 * - the snapshot the app sends is what the brand repo's sanitize.mjs makes of the same `PublishedState` (skipped where that
 *   repo isn't);
 * - the app's own web view (mac-app/conch-mac/LagoonWeb.swift, compiled with its models and ConchDesign) loads a stub of
 *   the page over conch-lagoon:// offscreen: `ready` arrives, `update` gets the encoded snapshot, the review route serves a
 *   fixture file by byte range, nothing leaves its folder, and in phase A no message acts;
 * - and, where the brand repo has built it, the real lagoon draws one crab per row of a fixture state, and a picture of it
 *   is kept to look at (CONCH_LAGOON_KEEP=<folder>).
 *
 * The web view parts need a login session (`launchctl managername` says Aqua) and swiftc, as page-capture-render does.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const read = (path: string) => readFileSync(repo(path), "utf8");
const BRIDGE = join(homedir(), "Projects/conch-design/brand/experiments/bridge");
const SANITIZE = join(BRIDGE, "sanitize.mjs");
const REAL_BUNDLE = join(BRIDGE, "dist/lagoon");
const node = Bun.which("node");
const swiftc = Bun.which("swiftc");
const drawable = swiftc !== null
  && Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "Aqua";
const crossCheckable = swiftc !== null && node !== null && existsSync(SANITIZE);
const realBundle = drawable && existsSync(join(REAL_BUNDLE, "index.html"));

// ---------------------------------------------------------------------------------------------- the bundle and the build

describe("build-app.sh carries the lagoon only when it is there, and never commits it", () => {
  const install = read("scripts/build-app.sh");
  const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

  test("the dev install prepares it before xcodebuild and hands it to the build phase", () => {
    const prepare = install.indexOf('LAGOON_BUNDLE="$("$SCRIPT_DIR/prepare-lagoon.sh" "$LAGOON_SCRATCH")"');
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(install.indexOf("xcodebuild \\"));
    expect(install).toContain('  CONCH_LAGOON_BUNDLE="$LAGOON_BUNDLE" \\\n  CONCH_DAEMON_SOURCE=checkout \\\n  build');
    // Its scratch folder goes with the script, and a lagoon that was asked for and didn't arrive stops the install
    // before the installed app is touched.
    expect(install).toContain(`trap 'rm -rf "$LAGOON_SCRATCH"' EXIT`);
    const missing = install.indexOf('if [[ -n "$LAGOON_BUNDLE" && ! -f "$BUILT_APP_PATH/Contents/Resources/Lagoon/index.html" ]]; then');
    expect(missing).toBeGreaterThan(install.indexOf("xcodebuild \\"));
    expect(missing).toBeLessThan(install.indexOf('rm -rf "$INSTALLED_APP_PATH"'));
  });

  test("the copy is a build phase before Xcode's seal, after the helpers, never a folder reference", () => {
    const target = project.slice(project.indexOf("isa = PBXNativeTarget;"), project.indexOf("/* End PBXNativeTarget section */"));
    const phases = target.slice(target.indexOf("buildPhases = ("), target.indexOf(");", target.indexOf("buildPhases = (")));
    expect(phases.indexOf("/* Embed lagoon */")).toBeGreaterThan(phases.indexOf("/* Embed tmux */"));
    expect(project).toContain('shellScript = "exec \\"$SRCROOT/../scripts/embed-lagoon.sh\\"\\n";');
    // The spec's "folder reference named Lagoon" would mean committing 23-33 MB here: the project names no Lagoon folder.
    expect(project).not.toMatch(/path = Lagoon;/);
    expect(project).not.toContain("Lagoon in Resources");
    for (const file of ["LagoonSource.swift", "LagoonWeb.swift", "LagoonPane.swift"]) {
      expect(project).toContain(`/* ${file} in Sources */ = {isa = PBXBuildFile;`);
    }
  });

  test("nothing of the bundle is tracked, and a copy put in the app's sources is ignored", async () => {
    const tracked = (await Bun.$`git -C ${repo(".")} ls-files`.quiet().text()).split("\n");
    const bundled = tracked.filter((path) => /(^|\/)Lagoon\//.test(path) || /three\.module\.js$|\.hdr$|coast_sand_|vendor\/three\//.test(path));
    expect(bundled).toEqual([]);
    const ignored = Bun.spawnSync(["git", "-C", repo("."), "check-ignore", "-q", "mac-app/conch-mac/Lagoon/index.html"]);
    expect(ignored.exitCode).toBe(0);
    // The stub the tests load is a few hundred bytes, not the lagoon.
    const stub = ["index.html", "js/stub.js", "data/hello.json", "BUNDLE.txt"].map((file) => statSync(repo(`test/fixtures/lagoon-stub/${file}`)).size);
    expect(stub.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  // A brand repo of our own: a builder that writes a page and its stamp where it's told, through bun standing in for node.
  const fake = (root: string) => {
    const bridge = join(root, "brand/experiments/bridge");
    const source = join(root, "brand/experiments/lagoon3d-v4");
    mkdirSync(join(source, "js"), { recursive: true });
    mkdirSync(bridge, { recursive: true });
    writeFileSync(join(source, "index.html"), "<!doctype html>");
    writeFileSync(join(source, "js/main.js"), "export {}");
    writeFileSync(join(bridge, "build-bundle.mjs"), `
      import fs from 'fs'; import path from 'path';
      const i = process.argv.indexOf('--out'); const out = i > 0 ? process.argv[i + 1] : path.join(import.meta.dir, 'dist/lagoon');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><title>built</title>');
      fs.writeFileSync(path.join(out, 'BUNDLE.txt'), 'conch lagoon runtime bundle · built fresh\\n');
      fs.writeFileSync(path.join(path.dirname(out), 'ran'), 'yes');
      console.log('bundle: ' + out);
    `);
    return { bridge, source };
  };
  const prepare = (bridge: string, scratch: string, nodePath = Bun.which("bun")!) =>
    Bun.spawnSync([repo("scripts/prepare-lagoon.sh"), scratch], {
      env: { ...process.env, CONCH_LAGOON_BRIDGE: bridge, NODE: nodePath },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("no brand repo: one line saying so, nothing to embed, and the build goes on", () => {
    const root = mkdtempSync(join(tmpdir(), "lagoon-prepare-"));
    const run = prepare(join(root, "nowhere"), root);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(run.stderr.toString()).toContain("conch.app is built without it");
  });

  test("an up-to-date dist is reused; a stale one is rebuilt into our scratch folder, never the brand repo's", () => {
    const root = mkdtempSync(join(tmpdir(), "lagoon-prepare-"));
    const { bridge, source } = fake(root);
    const dist = join(bridge, "dist/lagoon");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>dist</title>");
    writeFileSync(join(dist, "BUNDLE.txt"), "conch lagoon runtime bundle · the dist\n");
    // The stamp is newer than every source: reused as it is.
    const past = new Date(Date.now() - 60_000);
    for (const path of [join(bridge, "build-bundle.mjs"), join(source, "index.html"), join(source, "js/main.js"), join(source, "js")]) utimesSync(path, past, past);
    const fresh = prepare(bridge, join(root, "scratch-a"));
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout.toString().trim()).toBe(dist);
    expect(fresh.stderr.toString()).toContain("up to date (conch lagoon runtime bundle · the dist)");
    // A source newer than the stamp: built afresh, into the scratch folder.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(source, "js/main.js"), future, future);
    const scratch = join(root, "scratch-b");
    mkdirSync(scratch);
    const stale = prepare(bridge, scratch);
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout.toString().trim()).toBe(join(scratch, "lagoon"));
    expect(readFileSync(join(scratch, "lagoon/BUNDLE.txt"), "utf8")).toContain("built fresh");
    expect(readFileSync(join(dist, "BUNDLE.txt"), "utf8")).toContain("the dist");
    // The builder's report went to stderr: stdout is the folder alone.
    expect(stale.stderr.toString()).toContain("bundle: ");
    // A builder that fails, or no node: a warning, nothing to embed, and the build goes on.
    writeFileSync(join(bridge, "build-bundle.mjs"), "process.exit(2)");
    const failed = prepare(bridge, scratch);
    expect([failed.exitCode, failed.stdout.toString()]).toEqual([0, ""]);
    expect(failed.stderr.toString()).toContain("warning: the lagoon didn't build");
    const noNode = prepare(bridge, scratch, join(root, "no-such-node"));
    expect([noNode.exitCode, noNode.stdout.toString()]).toEqual([0, ""]);
    expect(noNode.stderr.toString()).toContain("needs node");
  });

  const embed = (app: string, bundle?: string) =>
    Bun.spawnSync([repo("scripts/embed-lagoon.sh")], {
      env: {
        ...process.env,
        TARGET_BUILD_DIR: app,
        CONTENTS_FOLDER_PATH: "conch-mac.app/Contents",
        UNLOCALIZED_RESOURCES_FOLDER_PATH: "conch-mac.app/Contents/Resources",
        CONCH_LAGOON_BUNDLE: bundle ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("the build phase copies the page as plain files into Resources/Lagoon, and removes a stale one when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "lagoon-embed-"));
    const bundle = join(root, "bundle");
    cpSync(repo("test/fixtures/lagoon-stub"), bundle, { recursive: true });
    chmodSync(join(bundle, "js/stub.js"), 0o755);
    Bun.spawnSync(["xattr", "-wx", "com.apple.FinderInfo", "5445585474747874000000000000000000000000000000000000000000000000", join(bundle, "index.html")]);
    const products = join(root, "products");
    const ok = embed(products, bundle);
    expect(ok.exitCode, ok.stderr.toString()).toBe(0);
    const lagoon = join(products, "conch-mac.app/Contents/Resources/Lagoon");
    expect(readFileSync(join(lagoon, "js/stub.js"), "utf8")).toBe(readFileSync(repo("test/fixtures/lagoon-stub/js/stub.js"), "utf8"));
    expect(statSync(join(lagoon, "js/stub.js")).mode & 0o111).toBe(0);
    // No Finder info comes along: on a resource it fails the seal. (macOS adds its own com.apple.provenance to what a
    // process writes, which the seal doesn't mind.)
    expect(Bun.spawnSync(["xattr", join(bundle, "index.html")]).stdout.toString()).toContain("com.apple.FinderInfo");
    expect(Bun.spawnSync(["xattr", join(lagoon, "index.html")]).stdout.toString()).not.toContain("com.apple.FinderInfo");
    expect(ok.stdout.toString()).toContain("embedded the lagoon: 4 files");
    // A symlink in the folder is refused rather than sealed.
    symlinkSync("/etc/hosts", join(bundle, "hosts"));
    expect(embed(products, bundle).exitCode).toBe(1);
    // Not asked for: a line saying so, and no Lagoon left from before.
    const none = embed(products);
    expect(none.exitCode).toBe(0);
    expect(none.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(existsSync(lagoon)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------- the fixture state

/** A `PublishedState` with every kind of row the lagoon reads, and every field it must never be sent. */
function fixtureState(work: string, home: string, rows = 0) {
  const at = 1_791_039_800_000;
  const long = (n: number, word = "word ") => word.repeat(Math.ceil(n / word.length)).slice(0, n);
  const state: Record<string, unknown> = {
    v: 1,
    features: { deliverables: 4, viewedState: 1, sessionHosts: 1 },
    ownerDeviceId: "device-secret",
    execution: { runtimes: [{ id: "device:x", kind: "device", ownerDeviceId: "device-secret", label: "Mac" }], accounts: [], connections: [] },
    ts: at + 10_478,
    audioControl: { holder: "local", revision: 3, expiresAt: null },
    audioOutbox: [{ seq: 1, text: "said aloud", voice: "Ava", label: "x", session: { ownerDeviceId: "d", localSessionKey: "k" }, at }],
    naturalVoices: { state: "ready", detail: "conch's own environment", source: "conch" },
    speechEngine: { state: "ready", parts: { whisper: { path: "/Applications/conch.app/Contents/Helpers/whisper-cli" } } },
    sessionSettings: { claude: { settings: [{ key: "model", label: "Model" }] } },
    mode: { muted: false, paused: true, holding: 2 },
    live: { state: "speaking", label: "Lagoon page", partial: "", level: 0.4 },
    reply: { sessionId: "s-page", text: "a reply", spokenChars: 3 },
    preview: null,
    conversation: { sessionId: "s-page", items: [{ id: "c1", kind: "assistant", text: "the single conversation" }] },
    deliveries: [{ opId: "op", sessionId: "s-page", at, delivered: true }],
    showing: { sessionId: "s-page", reviewId: "r-page", confidence: 1, surface: { kind: "conch", path: "/secret/path" } },
    phone: { paired: true },
    previewRequests: [{ id: "p", sessionId: "s-page", review: "r-page", folder: "/tmp/x" }],
    practice: { state: "idle" },
    rows: [
      {
        id: "s-page", label: "Lagoon page", status: "waiting", at, needsResponse: false, detail: "Ready for review", paused: false,
        muted: false, live: null, active: true, cwd: join(work, "work"), transcriptPath: "/Users/x/.claude/projects/p/1.jsonl",
        accountLabel: "Blueprint", claudeAccountId: "acct-1", voice: "Ava", settings: { model: "opus" }, revealable: true,
        execution: { providerId: "claude", runtimeId: "device:x", connectionId: "c" },
        reviews: [
          { id: "r-page", summary: "The page", link: "site/page.html", at: at - 5000, kind: "page", version: 2, artifact: "art-page",
            scene: { target: { kind: "page" }, inspect: "the header", marks: [{ id: "m", kind: "box", frame: { selector: ".x" } }] },
            focus: ["a"], access: { conch: "page", none: "page" } },
          { id: "r-notes", summary: "Notes", link: join(work, "work/notes.txt"), at: at - 4000, kind: "text", viewedAt: at - 100 },
          { id: "r-web", summary: "A live site", link: "https://example.com/x", at: at - 3000, kind: "url", linkRefused: "no" },
        ],
        review: { id: "r-web", summary: "A live site", link: "https://example.com/x", at: at - 3000, kind: "url" },
      },
      {
        id: "s-codex", label: "Codex refactor", status: "working", at, needsResponse: false, paused: false, pauseExempt: true, muted: false,
        live: "listening", active: true, cwd: `${home}/Projects/Conch`, codexAccountId: "codex-1", accountLabel: "Work",
        workDirs: [`${home}/Projects/Conch`, "/tmp/a", home, "/fourth"], usageLimit: "You've hit your usage limit until 4pm",
        execution: { providerId: "codex", runtimeId: "device:x" }, context: { usedTokens: 120_000, limitTokens: 200_000 },
        activity: { text: long(120, "Running the test suite "), kind: "step", at: at - 1000 }, waitingOnAgents: true, snippet: long(200),
      },
      {
        id: "s-needs", label: long(140, "A very long session name "), status: "needs", at, needsResponse: true, detail: long(260),
        paused: true, muted: false, live: null, active: false, approval: { id: "ap-1", name: "Bash", summary: "rm -rf build", answerable: false },
        cwd: "/srv/elsewhere",
      },
      {
        id: "s-sub", label: "subagent", status: "working", at, needsResponse: false, paused: false, muted: false, live: null, active: false,
        backend: "codex", parentSessionId: "s-codex", cwd: `${home}/Projects/Conch`,
      },
      {
        id: "s-started", label: "started", status: "review", at, needsResponse: false, paused: false, muted: false, live: null, active: false,
        backend: "conch", execution: { providerId: "codex", runtimeId: "device:x" }, startedBySessionId: "s-page",
        context: { usedTokens: 5, limitTokens: 0 },
      },
      {
        id: "s-old", label: "older daemon", status: "waiting", at, needsResponse: false, paused: false, muted: false, live: "speaking",
        active: false, review: { summary: "From before ids", link: "~/notes/old.md", at: at - 9000, artifact: "art-old", scene: { marks: [] } },
      },
    ],
    conversations: {
      "s-page": {
        sessionId: "s-page",
        items: [
          { id: "u1", rev: 1, kind: "user", text: "please build it", at: at - 900 },
          { id: "t1", rev: 1, kind: "tool", text: "ls", at: at - 800, tool: { name: "Bash", kind: "command_execution" } },
          { id: "a1", rev: 1, kind: "assistant", text: "first answer", at: at - 700 },
          { id: "th", rev: 1, kind: "thinking", text: "private thoughts", at: at - 600 },
          { id: "t2", rev: 1, kind: "tool", text: long(300, "cat a-very-long-file "), at: at - 500 },
          { id: "m1", rev: 1, kind: "material", text: "a file", at: at - 450, material: { kind: "image", title: "x", path: "/secret.png" } },
          { id: "t3", rev: 1, kind: "tool", text: "grep", at: at - 300 },
          { id: "a2", rev: 1, kind: "assistant", text: long(400, "the second answer is long "), at: at - 400 },
        ],
      },
      "s-codex": { sessionId: "s-codex", items: [] },
      "s-gone": { sessionId: "s-gone", items: [{ id: "x", kind: "assistant", text: "no row", at }] },
    },
    dismissed: ["d-1"],
    dismissedRows: [{ id: "d-2", label: "Dismissed" }, { id: "d-1", label: "Again" }],
  };
  const list = state.rows as Record<string, unknown>[];
  for (let i = 0; i < rows; i++) {
    const status = ["working", "waiting", "needs", "waiting"][i % 4];
    list.push({
      id: `s-crowd-${i}`, label: `Crowd ${i}`, status, at: at - i * 1000, needsResponse: status === "needs", paused: false, muted: false,
      live: null, active: i % 3 === 0, cwd: `${home}/Projects/${["Conch", "Blueprint", "Seashell"][i % 3]}`,
      execution: { providerId: i % 5 === 0 ? "codex" : "claude", runtimeId: "device:x" },
    });
  }
  return state;
}

// ---------------------------------------------------------------------------------------------- compiled once

let root = "";
let harness = "";
let compileError = "";
const keep = process.env.CONCH_LAGOON_KEEP;

beforeAll(async () => {
  if (!crossCheckable && !drawable) return;
  root = mkdtempSync(join(tmpdir(), "conch-lagoon-"));
  const strip = (path: string) => read(path).replace(/^import ConchDesign$/m, "");
  writeFileSync(join(root, "Models.swift"), strip("mac-app/conch-mac/Models.swift"));
  writeFileSync(join(root, "ExecutionModels.swift"), strip("mac-app/conch-mac/ExecutionModels.swift"));
  const store = read("mac-app/conch-mac/StateStore.swift");
  const start = store.indexOf("enum LinkTarget {");
  writeFileSync(join(root, "LinkTarget.swift"), `import Foundation\n${store.slice(start, store.indexOf("\n}\n", start) + 3)}`);
  const design = repo("design/ConchDesign/Sources/ConchDesign");
  const sources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  // Named main.swift: only that file may run statements at the top level.
  writeFileSync(join(root, "main.swift"), read("test/fixtures/lagoon-main.swift"));
  harness = join(root, "lagoon-harness");
  const compile = Bun.spawn([
    "swiftc", "-swift-version", "5", ...sources,
    join(root, "Models.swift"), join(root, "ExecutionModels.swift"), join(root, "LinkTarget.swift"),
    repo("mac-app/conch-mac/LagoonSource.swift"), repo("mac-app/conch-mac/LagoonWeb.swift"), join(root, "main.swift"),
    "-o", harness,
  ], { stdout: "pipe", stderr: "pipe" });
  if (await compile.exited !== 0) compileError = `swiftc failed:\n${await new Response(compile.stderr).text()}`;
}, 300_000);

afterAll(() => {
  if (root && keep) {
    mkdirSync(keep, { recursive: true });
    if (existsSync(join(root, "out/lagoon-real.png"))) cpSync(join(root, "out/lagoon-real.png"), join(keep, "lagoon-real.png"));
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- the snapshot

describe.skipIf(!crossCheckable)("the app's snapshot is what sanitize.mjs makes of the same state", () => {
  test("field for field, and nothing on its NEVER list", async () => {
    expect(compileError).toBe("");
    const home = "/Users/lagoon-fixture";
    const work = join(root, "cross");
    const path = join(root, "cross-state.json");
    writeFileSync(path, JSON.stringify(fixtureState(work, home)));
    const swift = Bun.spawnSync([harness, "snapshot", path, home], { stdout: "pipe", stderr: "pipe" });
    expect(swift.exitCode, swift.stderr.toString()).toBe(0);
    const ours = JSON.parse(swift.stdout.toString());
    // sanitize.mjs itself, under node, with the bridge's `open` rule pointed at the app's scheme (serve.mjs `openUrl`).
    const script = `
      import { sanitize, NEVER, isWebLink, reviewKey } from ${JSON.stringify(SANITIZE)};
      import fs from 'fs';
      const state = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const openUrl = (r, rv, key) => isWebLink(rv.link) ? rv.link : !rv.link ? undefined
        : 'conch-lagoon://lagoon/review/' + encodeURIComponent(r.id) + '/' + encodeURIComponent(key);
      console.log(JSON.stringify({ out: sanitize(state, { openUrl }), never: NEVER }));
    `;
    const run = Bun.spawnSync([node!, "--input-type=module", "-e", script, path], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const { out: theirs, never } = JSON.parse(run.stdout.toString()) as { out: unknown; never: string[] };
    expect(ours).toEqual(theirs);
    // And none of NEVER at any depth (but as a session id under `conversations`).
    const keys = new Set<string>();
    const walk = (value: unknown, parent = "") => {
      if (Array.isArray(value)) return value.forEach((v) => walk(v));
      if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (parent !== "conversations") keys.add(k); walk(v, k); }
    };
    walk(ours);
    expect(never.filter((k) => keys.has(k))).toEqual([]);
    const text = JSON.stringify(ours);
    for (const secret of ["device-secret", "acct-1", "Blueprint", "/Users/x/.claude", "private thoughts", "please build it", "You've hit", "site/page.html"]) {
      expect(text).not.toContain(secret);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------- the web view

interface Check { check: string; [key: string]: unknown }

async function runPage(bundle: string, kind: "stub" | "real", state: Record<string, unknown>): Promise<Map<string, Check>> {
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  const path = join(root, `${kind}-state.json`);
  writeFileSync(path, JSON.stringify(state));
  const run = Bun.spawn([harness, "page", bundle, path, out, kind], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: `${root}/` } });
  const [text, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (process.env.CONCH_LAGOON_DEBUG) console.log(text, err);
  expect(code, err).toBe(0);
  return new Map(text.trim().split("\n").filter(Boolean).map((line) => { const c = JSON.parse(line) as Check; return [c.check, c]; }));
}

describe.skipIf(!drawable)("the app's web view, over conch-lagoon://, with the stub page", () => {
  let checks = new Map<string, Check>();
  let work = "";

  beforeAll(async () => {
    if (compileError) return;
    work = join(root, "stub-work");
    mkdirSync(join(work, "work/site/img"), { recursive: true });
    mkdirSync(join(work, "secret"), { recursive: true });
    writeFileSync(join(work, "work/site/page.html"), "<!doctype html><title>the deliverable</title><img src=img/dot.txt>");
    writeFileSync(join(work, "work/site/img/dot.txt"), "a dot");
    writeFileSync(join(work, "work/notes.txt"), "plain notes");
    writeFileSync(join(work, "secret/keys.txt"), "SECRET-KEYS");
    symlinkSync(join(work, "secret"), join(work, "work/site/out"));
    checks = await runPage(repo("test/fixtures/lagoon-stub"), "stub", fixtureState(work, homedir()));
  }, 180_000);

  test("the page boots read-only from the app's scheme and says ready", () => {
    expect(compileError).toBe("");
    const ready = checks.get("ready")!;
    expect(ready.ok).toBe(true);
    expect(ready.url).toBe("conch-lagoon://lagoon/index.html?app=1&readonly=1");
    expect(ready.readOnly).toBe(true);
    // A module script and a fetch, both over the scheme.
    expect(checks.get("update")!.hello).toBe("lagoon");
  });

  test("update is called with the encoded snapshot, after setVisible and before the liveness", () => {
    const update = checks.get("update")!;
    expect(update.count).toBe(1);
    expect(update.matches).toBe(true);
    expect(update.rows).toBe(6);
    expect(update.order).toEqual(["setVisible", "update", "setLiveness", "setLiveness"]);
  });

  test("paced: the same ts is not sent again, a newer one is, and nothing while unseen until seen again", () => {
    const pacing = checks.get("pacing")!;
    expect(pacing.sameTs).toBe(1);
    expect(pacing.afterNewer).toBe(2);
    expect(pacing.visibleWhileHidden).toBe(false);
    expect(pacing.afterShown).toBe(3);
    expect(pacing.visibleNow).toBe(true);
    expect(checks.get("focus")!.ids).toEqual(["s-page"]);
  });

  test("the review route: a byte range of the file, the bare route sent on, only its folder, only while it's held", () => {
    const results = checks.get("fetch")!.results as Record<string, { status?: number; range?: string; body?: string; type?: string; error?: string }>;
    // `<!doctype html><title>the deliverable</title><img src=img/dot.txt>`: 66 bytes, and bytes 2 to 5 are "doct".
    expect(results.range).toMatchObject({ status: 206, range: "bytes 2-5/66", body: "doct", type: "text/html; charset=utf-8" });
    // A page's bare route sends it on to its own name, so its relative links resolve beside it.
    expect(results.bare!.status).toBe(200);
    expect(results.bare!.body).toContain("conch-lagoon://lagoon/review/s-page/r-page/page.html");
    expect(results.image).toMatchObject({ status: 200, body: "a dot" });
    // A plain file's bare route is the file.
    expect(results.notes).toMatchObject({ status: 200, body: "plain notes" });
    expect(results.stale!.status).toBe(404);
    expect(results.gone!.status).toBe(404);
    expect(results.web!.status).toBe(404);
    for (const key of ["encoded", "dots", "literal", "symlink", "bundleOut"]) {
      expect(results[key]!.status, key).not.toBe(200);
      expect(results[key]!.body ?? "", key).not.toContain("SECRET-KEYS");
    }
    expect(results.encoded!.status).toBe(403);
    expect(results.symlink!.status).toBe(404);
    expect(checks.get("post")!.status).toBe(405);
  });

  test("phase A: every message checked and logged, none acted on; a frame can't speak for the page; no new windows", () => {
    const intents = checks.get("intents")!;
    expect(intents.routed).toEqual(["focusSession:logged", "reply:logged", "pause:logged"]);
    const refused = intents.refused as string[];
    for (const reason of ["focusSession for a session that isn't in the current state", "an unknown name: rm -rf", "from a frame that isn't the lagoon's own"]) {
      expect(refused).toContain(reason);
    }
    // window.open is refused before WebKit asks, or when it asks; either way nothing else is.
    expect(refused.filter((r) => !r.startsWith("navigation: the lagoon never opens a window"))).toHaveLength(3);
    expect(intents.sink).toEqual([]);
    expect(intents.noWindow).toBe(true);
    const navigation = checks.get("navigation")!;
    expect(navigation.url).toBe("conch-lagoon://lagoon/index.html?app=1&readonly=1");
    expect(navigation.refused).toContain("navigation: the lagoon's page is only ever its own");
  });

  test("let go after ten minutes unseen, a new web view says ready and is sent the latest", () => {
    const rebuild = checks.get("rebuild")!;
    expect(rebuild).toMatchObject({ ready: true, updates: 1, sameView: false });
  });
});

describe.skipIf(!realBundle)("the real lagoon, from the brand repo's dist, in the app's web view", () => {
  test("one crab per row of a fixture state, and a picture of it", async () => {
    expect(compileError).toBe("");
    const work = join(root, "real-work");
    mkdirSync(work, { recursive: true });
    const state = fixtureState(work, homedir(), 14);
    const checks = await runPage(REAL_BUNDLE, "real", state);
    expect(checks.get("ready")!.ok).toBe(true);
    const real = checks.get("real")!;
    expect(real.api).toEqual([1, "app", true]);
    expect(real.crabs).toBe((state.rows as unknown[]).length);
    expect(real.ids).toEqual(real.expectedIds);
    expect(real.refused).toEqual([]);
    expect(real.png).toBeTruthy();
    console.log(`lagoon: ${real.crabs} crabs; picture ${real.png}${keep ? ` (kept in ${keep})` : ""}`);
  }, 200_000);
});
