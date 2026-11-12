import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Mac app's window is drawn again only for what it shows (2026-11-11, on the live app's steady ~4% of a core).
 *
 * A 10 s SwiftUI trace of the live app with 25 rows, 15 of them working, found every publish of the store drawing the
 * window three times over: once for the store's own update, and twice more because the app's body watched the store
 * (ConchMacApp's `@StateObject`s, app-cpu.test.ts pins that they are gone). Under each pass the session list ran its
 * body and its eleven folder headers', and the conversation stack, the window's costliest body, ran on every publish
 * of any session through its own watch on the store, behind the conversation pane's `==`.
 *
 * The harness (test/fixtures/window-churn-main.swift) is the app's real ContentView, compiled from the app's own
 * sources with the other stores the app hands it, in an offscreen window, over a real StateStore reading a sessions
 * file the harness writes the way the daemon does: an acme workspace, every path to the real daemon's files rewritten
 * to this test's temp folder before compiling. Counters patched into the copy say how often each view's body ran, and
 * the harness counts the store's publishes. Needs a login session with a window server (`launchctl managername` says
 * Aqua); runs in ci-local's `mac` stage (CONCH_WINDOW_CHURN=1).
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const drawable = process.env.CONCH_WINDOW_CHURN === "1" && Bun.which("swiftc") !== null
  && Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "Aqua";

const counted = ["ContentView", "SessionLedger", "FolderHeader", "DashboardRow", "ConversationPane", "ConversationStackView"];

type Phase = { name: string; writes?: number; publishes: number; bodies: Record<string, number> };
const phases: Phase[] = [];
let root = "";
let harnessError = "";

/** One body probe at the top of `view`'s body, wherever its struct sits in the file. */
function probe(text: string, file: string, view: string): string {
  const head = new RegExp(`\\n(?:private |fileprivate )?struct ${view}(?:<[^>]*>)?: View[^{]*\\{`).exec(text);
  const body = head ? text.indexOf("var body: some View {", head.index) : -1;
  if (body < 0) throw new Error(`${file}: no body for ${view}`);
  const at = body + "var body: some View {".length;
  return `${text.slice(0, at)}\n        let _ = ChurnProbe.body("${view}")${text.slice(at)}`;
}

async function swiftc(args: string[]): Promise<void> {
  const jobs = String(Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)));
  const compile = Bun.spawn(["swiftc", "-swift-version", "5", "-j", jobs, ...args], { stdout: "pipe", stderr: "pipe", cwd: root });
  const [code, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (code !== 0) throw new Error(`swiftc failed:\n${stderr.split("\n").filter((line) => line.includes("error:")).slice(0, 30).join("\n")}`);
}

beforeAll(async () => {
  if (!drawable) return;
  root = mkdtempSync(join(tmpdir(), "conch-window-churn-"));
  const sandbox = join(root, "sandbox");
  mkdirSync(join(sandbox, "tmp"), { recursive: true });
  const src = join(root, "src");
  mkdirSync(src);

  // The app's sources, all but the @main app and the debug-request reader (sidebar-settle-stubs.swift stands in for
  // them), with every path to the real daemon's socket and files pointed into the sandbox, where nothing listens.
  const app = repo("mac-app/conch-mac");
  const found = new Set<string>();
  for (const name of readdirSync(app).filter((file) => file.endsWith(".swift"))) {
    if (name === "ConchMacApp.swift" || name === "DebugSnapshot.swift") continue;
    let text = readFileSync(join(app, name), "utf8")
      .replaceAll('"/tmp/conch.sock"', JSON.stringify(join(sandbox, "no-daemon.sock")))
      .replaceAll('"/tmp/conch-sessions.json"', JSON.stringify(join(sandbox, "state.json")))
      .replaceAll('"/tmp/conch-daemon.log"', JSON.stringify(join(sandbox, "daemon.log")));
    if (name === "RemoteMacStore.swift") {
      // No remote Macs: their pairings live in the Keychain and their sessions are real.
      const from = "        do {\n            pairings = try RemoteMacPairingStore.loadAll()";
      if (text.split(from).length !== 2) throw new Error(`${name}: the pairings load moved`);
      text = text.replace(from, `        if true { return }\n${from}`);
    }
    for (const view of counted) {
      if (new RegExp(`\\n(?:private |fileprivate )?struct ${view}(?:<[^>]*>)?: View`).test(text)) {
        text = probe(text, name, view);
        found.add(view);
      }
    }
    for (const real of ["/tmp/conch.sock", "/tmp/conch-sessions.json", "/tmp/conch-daemon.log", "/tmp/conch-shot", "/tmp/conch-inspect", "/tmp/conch-select"]) {
      if (text.includes(`"${real}`)) throw new Error(`${name} still names ${real}`);
    }
    writeFileSync(join(src, name), text);
  }
  if (found.size !== counted.length) throw new Error(`no struct for ${counted.filter((view) => !found.has(view)).join(", ")}`);

  const design = repo("design/ConchDesign/Sources/ConchDesign");
  const designSources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  await swiftc(["-parse-as-library", "-emit-library", "-static", "-emit-module", "-module-name", "ConchDesign",
    "-emit-module-path", join(root, "ConchDesign.swiftmodule"), "-o", join(root, "libConchDesign.a"), ...designSources]);
  // Named main.swift: only that file may run statements at the top level.
  copyFileSync(repo("test/fixtures/window-churn-main.swift"), join(root, "main.swift"));
  const binary = join(root, "window-churn");
  const appSources = readdirSync(src).map((name) => join(src, name));
  await swiftc(["-I", root, "-L", root, "-lConchDesign", ...appSources, repo("test/fixtures/sidebar-settle-stubs.swift"),
    join(root, "main.swift"), "-o", binary]);

  // An environment that names only the sandbox.
  const run = Bun.spawn([binary], {
    stdout: "pipe", stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: `${sandbox}/tmp/`,
      CONCH_SOCKET: join(sandbox, "no-daemon.sock"), CONCH_STATE_FILE: join(sandbox, "state.json"),
      CONCH_SESSIONS_FILE: join(sandbox, "state.json"), CONCH_LOG_FILE: join(sandbox, "daemon.log"),
      CONCH_CONFIG_DIR: join(sandbox, "config"), CONCH_HOME: join(sandbox, "home"),
    },
  });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (code !== 0) harnessError = `the harness exited ${code}:\n${out}\n${err.split("\n").slice(-20).join("\n")}`;
  if (process.env.CONCH_WINDOW_CHURN_DEBUG) console.log(out, err);
  for (const line of out.trim().split("\n").filter(Boolean)) phases.push(JSON.parse(line) as Phase);
}, 420_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const phase = (name: string): Phase => {
  const found = phases.find((entry) => entry.name === name);
  expect(found, `no "${name}" phase; ${harnessError}`).toBeDefined();
  return found!;
};
const ran = (entry: Phase, view: string) => entry.bodies[view] ?? 0;

describe.skipIf(!drawable)("the window is drawn again only for what it shows", () => {
  test("the harness ran every phase, and the window drew the sessions and the conversation", () => {
    expect(harnessError).toBe("");
    expect(phases.map((entry) => entry.name)).toEqual([
      "ready", "clock only", "same bytes", "written another way", "another session's activity", "a subagent's conversation",
      "the shown session", "done",
    ]);
    const ready = phase("ready");
    for (const view of counted) expect(ran(ready, view), view).toBeGreaterThan(0);
  });

  /**
   * A write that decodes to what the store already shows is no publish: the daemon's clock moving (a third of its
   * writes), the same bytes again, the same state written another way. With no publish nothing in the window runs.
   */
  test.each(["clock only", "same bytes", "written another way"])("%s: the store does not publish", (name) => {
    const entry = phase(name);
    expect(entry.publishes, JSON.stringify(entry)).toBe(0);
    for (const view of ["ContentView", "SessionLedger", "FolderHeader", "DashboardRow", "ConversationPane"]) {
      expect(ran(entry, view), `${view}: ${JSON.stringify(entry)}`).toBe(0);
    }
  });

  /**
   * Another session's activity line is that session's row, redrawn, and the list's body that hands it over: no folder
   * header, no conversation pane, no conversation stack. A subagent's conversation is none of the list's business.
   */
  test("another session's activity line redraws its row and the list, nothing else", () => {
    const entry = phase("another session's activity");
    expect(entry.publishes, JSON.stringify(entry)).toBeGreaterThanOrEqual(entry.writes!);
    expect(ran(entry, "SessionLedger"), JSON.stringify(entry)).toBeLessThanOrEqual(entry.writes!);
    expect(ran(entry, "DashboardRow"), JSON.stringify(entry)).toBeGreaterThanOrEqual(entry.writes!);
    expect(ran(entry, "DashboardRow"), JSON.stringify(entry)).toBeLessThanOrEqual(entry.writes! + 2);
    for (const view of ["FolderHeader", "ConversationPane", "ConversationStackView"]) {
      expect(ran(entry, view), `${view}: ${JSON.stringify(entry)}`).toBe(0);
    }
  });

  test("a subagent's conversation moving on redraws nothing in the list or the pane", () => {
    const entry = phase("a subagent's conversation");
    expect(entry.publishes, JSON.stringify(entry)).toBeGreaterThanOrEqual(entry.writes!);
    for (const view of ["SessionLedger", "FolderHeader", "DashboardRow", "ConversationPane", "ConversationStackView"]) {
      expect(ran(entry, view), `${view}: ${JSON.stringify(entry)}`).toBe(0);
    }
  });

  /** And what the window shows still reaches it: the quiet above is the window not being asked, not it not listening. */
  test("the shown session's line and conversation redraw its row, the pane and the stack", () => {
    const entry = phase("the shown session");
    for (const view of ["DashboardRow", "ConversationPane", "ConversationStackView"]) {
      expect(ran(entry, view), `${view}: ${JSON.stringify(entry)}`).toBeGreaterThan(0);
    }
    expect(ran(entry, "FolderHeader"), JSON.stringify(entry)).toBe(0);
  });
});
