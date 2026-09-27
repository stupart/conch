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
  // The existing backoff and give-up (restartAttempts), and the frozen-restart budget on top.
  expect(recover).toContain("case .restart:");
  expect(recover).toContain("scheduleRestart()");
  expect(recover).toContain("case .giveUp:");
  expect(recover).toContain('state = .failed("conch\'s background service kept freezing, so it was stopped. Check the log, then start it again.")');
  const schedule = body("private func scheduleRestart() {");
  expect(schedule).toContain("restartAttempts += 1");
  expect(schedule).toContain("guard restartAttempts <= 5 else {");
  expect(body("private func handleExit(_ finished: Process) {")).toContain("scheduleRestart()");
  // A start by hand after giving up is a fresh budget.
  expect(body("func start() {")).toContain("if case .failed = state { health.forgetRestarts() }");
  expect(host).not.toMatch(/pkill|killall/);
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
