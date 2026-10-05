import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Mac app's session list settles: after a dismiss, a restore, conch's words on a closing row and agents' activity
 * lines moving on, SwiftUI stops updating it within a second.
 *
 * Tyler's conch froze five times between 2026-10-03 and 10-05: the main thread at 80-100% CPU for good, every sample
 * inside SwiftUI laying the sidebar out again and again (LazySubviewPlacements, LazyStack measureEstimates,
 * LazyLayoutViewCache.updateItemPhases, `SessionRow` copies from the ledger's ForEach), each right after a session was
 * dismissed or restored, and once (23:13) right after a deliverable was filed while agents worked. The first came the
 * day the activity lines (#494) made sidebar rows change height every second. SessionLedger (DashboardView.swift) now lays its rows out eagerly, scrolls only to an id it draws, once per
 * update, never animated while rows change shape (`LedgerScroller`), and the activity line is rewritten in place
 * (`SidebarSecondLine`).
 *
 * The harness (test/fixtures/sidebar-settle-main.swift) is the app's real SessionLedger, compiled from the app's own
 * sources, in an offscreen window, handed an acme workspace directly — no store, socket client or daemon host is made,
 * and every path to the real daemon's files is rewritten to this test's temp folder before compiling. Counters patched
 * into the copy say how often the list's body, its rows' bodies and their layout ran; a watchdog thread reports a main
 * thread that stops returning to its run loop, which is the freeze itself.
 *
 * Needs a login session with a window server (`launchctl managername` says Aqua). Nothing is shown: the app can never
 * be active, and the window is borderless, transparent and parked off every screen.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const read = (path: string) => readFileSync(repo(path), "utf8");
// About a minute of compiling and driving SwiftUI, so it runs in ci-local's `mac` stage (CONCH_SIDEBAR_SETTLE=1), not in
// every `bun test` a push runs. The source checks below always run.
const drawable = process.env.CONCH_SIDEBAR_SETTLE === "1" && Bun.which("swiftc") !== null
  && Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "Aqua";

type Phase = Record<string, number | string>;
const phases: Phase[] = [];
let root = "";
let harnessError = "";

function patch(text: string, file: string, from: string, to: string): string {
  const found = text.split(from).length - 1;
  if (found !== 1) throw new Error(`${file}: expected one ${JSON.stringify(from.slice(0, 80))}, found ${found}`);
  return text.replace(from, to);
}

async function swiftc(args: string[]): Promise<void> {
  const jobs = String(Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)));
  const compile = Bun.spawn(["swiftc", "-swift-version", "5", "-j", jobs, ...args], { stdout: "pipe", stderr: "pipe", cwd: root });
  const [code, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (code !== 0) throw new Error(`swiftc failed:\n${stderr.split("\n").filter((line) => line.includes("error:")).slice(0, 30).join("\n")}`);
}

beforeAll(async () => {
  if (!drawable) return;
  root = mkdtempSync(join(tmpdir(), "conch-sidebar-settle-"));
  const sandbox = join(root, "sandbox");
  mkdirSync(join(sandbox, "tmp"), { recursive: true });
  const src = join(root, "src");
  mkdirSync(src);

  // The app's sources, all but the @main app and the debug-request reader (sidebar-settle-stubs.swift), with every
  // path to the real daemon's socket and files pointed into the sandbox, where nothing listens.
  const app = repo("mac-app/conch-mac");
  for (const name of readdirSync(app).filter((file) => file.endsWith(".swift"))) {
    if (name === "ConchMacApp.swift" || name === "DebugSnapshot.swift") continue;
    let text = readFileSync(join(app, name), "utf8")
      .replaceAll('"/tmp/conch.sock"', JSON.stringify(join(sandbox, "no-daemon.sock")))
      .replaceAll('"/tmp/conch-sessions.json"', JSON.stringify(join(sandbox, "state.json")))
      .replaceAll('"/tmp/conch-daemon.log"', JSON.stringify(join(sandbox, "daemon.log")));
    if (name === "RemoteMacStore.swift") {
      // No remote Macs: their pairings live in the Keychain and their sessions are real.
      text = patch(text, name, "        do {\n            pairings = try RemoteMacPairingStore.loadAll()",
        "        if true { return }\n        do {\n            pairings = try RemoteMacPairingStore.loadAll()");
    }
    if (name === "DashboardView.swift") {
      text = patch(text, name,
        "    var body: some View {\n        Group {\n            if let state, !state.rows.isEmpty || !state.dismissedRows.isEmpty {",
        "    var body: some View {\n        Group {\n            let _ = LedgerProbe.ledgerBody()\n            if let state, !state.rows.isEmpty || !state.dismissedRows.isEmpty {");
      text = patch(text, name,
        "    var body: some View {\n        Group {\n            if isRenaming {\n                rowContent",
        "    var body: some View {\n        Group {\n            let _ = LedgerProbe.rowBody()\n            if isRenaming {\n                rowContent");
      text = patch(text, name,
        "        .frame(maxWidth: .infinity, minHeight: Self.rowHeight)\n        .background {",
        "        .frame(maxWidth: .infinity, minHeight: Self.rowHeight)\n        .modifier(LedgerProbe.Measured())\n        .background {");
      text = text.replaceAll("proxy.scrollTo(", "LedgerProbe.scrolled(); proxy.scrollTo(");
      // SessionLedger is private to its file, so the harness's way in lives there too.
      text += `
@MainActor
func makeLedgerForSettleTest(
    state: PublishedState?, selectedSessionID: SessionRow.ID?, renameDraft: Binding<String>,
    rowMessages: [SessionRow.ID: String], undoDismissal: SessionDismissUndo?, actions: DashboardActions
) -> some View {
    SessionLedger(
        onSelectRemote: { _ in }, state: state, selectedSessionID: selectedSessionID, renamingSessionID: nil,
        renameDraft: renameDraft, rowMessages: rowMessages, undoDismissal: undoDismissal, actions: actions
    )
}
`;
    }
    // As a string the code uses, that is: comments may still name them.
    for (const real of ["/tmp/conch.sock", "/tmp/conch-sessions.json", "/tmp/conch-daemon.log", "/tmp/conch-shot", "/tmp/conch-inspect", "/tmp/conch-select"]) {
      if (text.includes(`"${real}`)) throw new Error(`${name} still names ${real}`);
    }
    writeFileSync(join(src, name), text);
  }

  const design = repo("design/ConchDesign/Sources/ConchDesign");
  const designSources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  await swiftc(["-parse-as-library", "-emit-library", "-static", "-emit-module", "-module-name", "ConchDesign",
    "-emit-module-path", join(root, "ConchDesign.swiftmodule"), "-o", join(root, "libConchDesign.a"), ...designSources]);
  // Named main.swift: only that file may run statements at the top level.
  copyFileSync(repo("test/fixtures/sidebar-settle-main.swift"), join(root, "main.swift"));
  const binary = join(root, "sidebar-settle");
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
  if (process.env.CONCH_SIDEBAR_DEBUG) console.log(out, err);
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

const triggers = [
  "initial", "select", "dismiss, undo first", "dismiss, row moves", "dismiss", "undo expires", "restore",
  "restore, group open", "close, cleanly", "close, failed", "activity", "review filed while agents work",
  "dismiss and restore while agents work",
];

describe.skipIf(!drawable)("the session list settles after every change", () => {
  test("the harness ran every phase, and the main thread never stalled", () => {
    expect(harnessError).toBe("");
    expect(phases.map((entry) => entry.name)).toEqual([...triggers, "done"]);
  });

  /**
   * The freeze, as the samples show it: the list's layout running without end. One quiet second after each change —
   * after the dismiss and restore that preceded every freeze, and after five seconds of activity lines moving on —
   * must hold no update at all: no body of the list or of a row, no measuring or placing of a row, and next to no
   * main-thread CPU (an idle list costs a millisecond or two; the frozen app spent the whole second).
   */
  test.each(triggers)("%s: nothing runs in the quiet second after it", (name) => {
    const entry = phase(name);
    expect(entry.quietLedgerBodies, `${name}: ${JSON.stringify(entry)}`).toBe(0);
    expect(entry.quietRowBodies, `${name}: ${JSON.stringify(entry)}`).toBe(0);
    expect(entry.quietLayouts, `${name}: ${JSON.stringify(entry)}`).toBe(0);
    expect(Number(entry.quietCpuMs), `${name}: ${JSON.stringify(entry)}`).toBeLessThan(150);
  });

  test("every change reached the list, so the quiet is the list settling rather than not listening", () => {
    for (const name of triggers) {
      expect(Number(phase(name).layouts), name).toBeGreaterThan(0);
    }
  });

  /**
   * One scroll per change. A dismiss used to fire two animated scrolls in one update (the row order and the undo, each
   * on its own `onChange`), at a row that had just moved; activity lines, which change rows' heights every second,
   * never scroll the list.
   */
  test("a dismiss or a restore scrolls once, and activity lines never scroll", () => {
    for (const name of ["select", "dismiss, undo first", "dismiss, row moves", "dismiss", "undo expires", "restore", "restore, group open", "close, cleanly", "close, failed"]) {
      expect(Number(phase(name).scrolls), name).toBeLessThanOrEqual(1);
    }
    expect(Number(phase("dismiss").scrolls)).toBe(1);
    expect(Number(phase("activity").scrolls)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ the source, pinned

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const ledger = dashboard.slice(dashboard.indexOf("private struct SessionLedger: View {"), dashboard.indexOf("/// One folder's header in the session list."));
const sidebarRow = read("design/ConchDesign/Sources/ConchDesign/SidebarRow.swift");

describe("the session list's layout and scrolling, as the fix left them", () => {
  test("the list is an eager stack", () => {
    expect(ledger).toContain("                            VStack(spacing: 2) {");
    expect(ledger).not.toContain("LazyVStack(");
  });

  test("every scroll is made in one place, to an id the list draws right now", () => {
    // One scrollTo in the whole file, inside LedgerScroller's flush.
    expect(dashboard.split("proxy.scrollTo(").length - 1).toBe(1);
    const scroller = dashboard.slice(dashboard.indexOf("final class LedgerScroller {"), dashboard.indexOf("/// One folder's header in the session list."));
    expect(scroller).toContain("proxy.scrollTo(pending.target, anchor: .center)");
    // Requests are only ever made through keepInView, which drops any id the list does not draw.
    const keep = ledger.slice(ledger.indexOf("private func keepInView("));
    expect(keep).toContain("guard let target, scrollTargets.contains(target) else { return }");
    expect(ledger).not.toContain("withAnimation(.easeOut(duration: 0.18))");
    // The dismissed rows are scroll targets only while the group is open; an undo for a row not yet moved into it
    // lands on the group's header.
    const targets = ledger.slice(ledger.indexOf("private var scrollTargets: Set<String> {"), ledger.indexOf("private func scrollTarget(for"));
    expect(targets).toContain('targets.insert("dismissed-header")');
    expect(targets).toContain("if showsDismissedRows {");
    expect(ledger).toContain('?? (scrollTargets.contains("dismissed-header") ? "dismissed-header" : nil)');
  });

  test("one scroll per update, the same target never re-fired while it may still be moving, and no ease while rows change shape", () => {
    const scroller = dashboard.slice(dashboard.indexOf("final class LedgerScroller {"), dashboard.indexOf("/// One folder's header in the session list."));
    expect(scroller).toContain("let first = pending == nil");
    expect(scroller).toContain("DispatchQueue.main.async { [weak self] in");
    expect(scroller).toContain("guard pending.target != lastTarget");
    expect(scroller).toContain("if pending.animated, now.timeIntervalSince(lastRowChange) >= Self.settle {");
    expect(scroller).toContain("transaction.disablesAnimations = true");
    // Row order, the undo and a row's second line coming or going all count as rows changing shape.
    for (const change of [".onChange(of: rowOrder) { _, _ in\n                            scroller.rowsChanged()",
      ".onChange(of: rowShape) { _, _ in\n                            scroller.rowsChanged()",
      ".onChange(of: undoDismissal?.id) { _, _ in\n                            scroller.rowsChanged()"]) {
      expect(ledger).toContain(change);
    }
    // Only a change of focus asks to ease; everything a dismiss, a restore or conch's words set off jumps.
    expect(ledger.split("animated: true").length - 1).toBe(1);
    expect(ledger).toContain(".onChange(of: focusID) { _, _ in\n                            keepInView(keptInView, proxy, animated: true)");
  });

  test("the activity line is rewritten in place: no identity per text, no transition, no animation", () => {
    const view = sidebarRow.slice(sidebarRow.indexOf("public struct SidebarSecondLine: View {"));
    const body = view.slice(view.indexOf("public var body: some View {"), view.indexOf("private var style: AnyShapeStyle {"));
    expect(body).toContain("TailFadeText(line.text, fade: 24)");
    expect(body).not.toContain(".id(");
    expect(body).not.toContain(".transition(");
    expect(body).not.toContain(".animation(");
  });
});
