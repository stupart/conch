import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const host = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "DaemonHost.swift"), "utf8");
const notices = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "Notices.swift"), "utf8");

/** The body of `signature`, up to the method's closing brace. */
function body(signature: string): string {
  const at = host.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  return host.slice(at, host.indexOf("\n    }\n", at));
}

/**
 * An adopted daemon is someone else's process: no exit callback fires when
 * it dies, and the app sat on a dead socket twice on 2026-09-10 — hooks
 * failing, phone gone, window still saying "Running — started outside this
 * app" (A2). And a daemon of the app's own that freezes never exits at all: on
 * 2026-09-28 one sat in a synchronous loop for eight minutes while a bare
 * connect() to its socket kept succeeding. So the host pings both (DaemonHealth
 * in ConchDesign, tested there), starts its own when an adopted one is gone,
 * and stops a frozen one by its pid and replaces it. Nothing runs this Swift
 * here, so the wiring is pinned as text.
 */
test("adopting a daemon, or launching one, starts the health watch", () => {
  expect(host).toContain("state = .adopted\n            watchHealth()");
  expect(host).toContain("state = .running(pid: task.processIdentifier)\n            watchHealth()");
  const watch = body("private func watchHealth() {");
  expect(watch).toContain("Timer(timeInterval: health.policy.interval, repeats: true)");
  expect(watch).toContain("await self?.checkHealth()");
});

test("the watch pings rather than connects, and names who may be stopped", () => {
  expect(host).toContain("private lazy var health = DaemonHealthMonitor(hooks: .init(");
  expect(host).toContain("target: { [weak self] in self?.healthTarget() }");
  expect(host).toContain("DaemonHealth.appendToLog(line, path: logPath)");
  const target = body("private func healthTarget() -> DaemonHealth.Target? {");
  // Our own child by its Process's pid; an adopted one only by an identity that checks out.
  expect(target).toContain("DaemonHealth.Target(pid: task.processIdentifier, launchedAt: launchedAt)");
  expect(target).toContain("DaemonHost.signallableIdentity(socketPath: socketPath)");
});

test("an adopted daemon that is gone starts our own, as before", () => {
  const check = body("private func checkHealth() async {");
  expect(check).toContain("guard let verdict = await health.check() else { return }");
  const gone = check.slice(check.indexOf("case .gone:"));
  expect(gone).toContain("guard case .adopted = state else { return }");
  expect(gone).toContain("state = .stopped\n            start()");
  expect(check).toContain("case .unresponsive(let pid):\n            await recoverFrozenDaemon(pid: pid)");
  // An unidentified daemon is said once, not every five seconds and not again after it is dismissed.
  expect(check).toContain("guard failures == health.policy.failuresBeforeRestart else { return }");
});

test("a frozen daemon is detached, stopped by its pid, and replaced within both restart budgets", () => {
  const recover = body("private func recoverFrozenDaemon(pid: Int32) async {");
  // Its own exit must not also restart it through handleExit.
  const detach = recover.indexOf("task.terminationHandler = nil");
  const stop = recover.indexOf("await health.recover(pid: pid)");
  expect(detach).toBeGreaterThan(-1);
  expect(stop).toBeGreaterThan(detach);
  expect(recover).toContain('recoveryNotice = "conch\'s background service stopped responding and was restarted."');
  // The frozen-restart budget (3 in 10 minutes, `health.recover`) decides a freeze's restart; the crash budget never
  // counts it, or freezes and exits added up to "kept stopping" (#442 review, finding 8).
  expect(recover).toContain("case .restart:");
  expect(recover).toContain("scheduleRestart(after: 2)");
  expect(recover).not.toContain("crashes.");
  expect(recover).toContain("case .giveUp:");
  expect(recover).toContain('state = .failed("conch\'s background service kept freezing, so it was stopped. Check the log, then start it again.")');
  // An exit is the crash budget's: backoff and give-up from DaemonHealth.CrashBudget (DaemonHealthTests pins the numbers).
  const exit = body("private func handleExit(_ finished: Process) {");
  expect(exit).toContain("switch crashes.exited() {");
  expect(exit).toContain("scheduleRestart(after: delay)");
  expect(exit).toContain('state = .failed("The daemon kept stopping. Check the log, then start it again.")');
  expect(host).toContain("private var crashes = DaemonHealth.CrashBudget()");
  // A start by hand after giving up is a fresh budget, both of them.
  const start = body("func start() {");
  expect(start).toContain("health.forgetRestarts()");
  expect(start).toContain("crashes = DaemonHealth.CrashBudget()");
  expect(host).not.toMatch(/pkill|killall/);
});

test("answering steadily forgives the exits before it; printing doesn't (a headless daemon prints nothing)", () => {
  const check = body("private func checkHealth() async {");
  const observed = check.indexOf("crashes.observed(verdict, at: Date())");
  expect(observed).toBeGreaterThan(check.indexOf("guard let verdict = await health.check() else { return }"));
  expect(observed).toBeLessThan(check.indexOf("switch verdict {"));
  // The only other writers: a person's stop, or start after a failure. Never the daemon's output.
  expect(host.match(/^\s+crashes = DaemonHealth\.CrashBudget\(\)$/gm)?.length).toBe(2);
  expect(body("func stop() {")).toContain("crashes = DaemonHealth.CrashBudget()");
  expect(body("private func appendOutput(_ text: String) {")).not.toMatch(/crashes|restartAttempts/);
  expect(host).not.toContain("restartAttempts");
});

test("a daemon stopped in a terminal or a debugger is paused: never signalled, and said so until it answers again", () => {
  const check = body("private func checkHealth() async {");
  const paused = check.slice(check.indexOf("case .paused:"), check.indexOf("case .gone:"));
  expect(paused).toContain("guard !paused else { return }");
  expect(paused).toContain("recoveryNotice = Self.pausedWords");
  expect(paused).not.toMatch(/recoverFrozenDaemon|health\.recover|kill\(|signal\(|stop\(\)|start\(\)/);
  expect(host).toContain(`static let pausedWords = "conch's background service is paused (stopped in a terminal or debugger)."`);
  // Continued, the words go with the pause.
  expect(check).toContain("if recoveryNotice == Self.pausedWords { recoveryNotice = nil }");
  // The comment tells the truth: adopted is replaced when frozen, and never signalled when paused.
  const adopted = host.slice(host.indexOf("        case adopted") - 700, host.indexOf("        case adopted"));
  expect(adopted).toContain("running and not answering, it is frozen and is");
  expect(adopted).toContain("stopped (Ctrl-Z, a debugger), it was paused on");
  expect(adopted).not.toContain("leave it be");
  // Settings says it too.
  const settings = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "SettingsView.swift"), "utf8");
  expect(settings).toContain("if daemon.paused { return \"Paused — stopped in a terminal or debugger. conch leaves it alone until it's continued.\" }");
});

test("a socket that refuses while its identity names a live daemon is adopted, not raced", () => {
  // A frozen daemon's backlog fills and then refuses connects; one of ours would only lose the socket's lock to it.
  expect(body("func start() {")).toContain(
    "if socketAnswers() || DaemonHost.signallableIdentity(socketPath: socketPath) != nil {",
  );
});

test("stop() drops the watch, or a deliberate off would flip back on", () => {
  const stop = body("func stop() {");
  expect(stop).toContain("stopHealthWatch()");
  expect(body("func takeOverFromLaunchd() {")).toContain("stopHealthWatch()");
});

test("the window says so, and can be told it has been read", () => {
  expect(notices).toContain("if let notice = daemon.recoveryNotice {");
  expect(notices).toContain('Button("OK", action: daemon.dismissRecoveryNotice)');
});
