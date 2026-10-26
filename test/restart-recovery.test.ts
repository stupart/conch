import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GONE_GRACE_MS,
  POWER_OFF_WINDOW_MS,
  RESTORE_TRIES,
  RestartGuard,
  bootTime,
  emptyLedger,
  planAfterRestart,
  sameBoot,
  watchedToTheEnd,
  type RestartLedger,
  type RunningRecord,
  type RunningSession,
} from "../src/restart-recovery.ts";
import type { StartSessionRequest } from "../src/session-lifecycle.ts";

const root = mkdtempSync(join(tmpdir(), "conch-restart-recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let files = 0;
const freshFile = () => join(root, `running-${files++}.json`);

const BOOT_A = 1_793_000_000;
const BOOT_B = BOOT_A + 6 * 60 * 60; // the Mac started again six hours later
const T0 = BOOT_A * 1000 + 60 * 60_000;

const request = (id: string): StartSessionRequest => ({ backend: "claude", cwd: "/Users/t/p", resumeSessionId: id, host: "terminal" } as StartSessionRequest);
const record = (id: string, over: Partial<RunningRecord> = {}): RunningRecord => ({
  conversationId: id, label: `session ${id}`, backend: "claude", request: request(id), seenAt: T0, ...over,
});
const session = (id: string): RunningSession => ({ sessionId: id, label: `session ${id}`, backend: "claude" });

function guard(file: string, clock: { now: number; boot: number }, launched: StartSessionRequest[] = [], logs: string[] = []) {
  return new RestartGuard({
    file,
    relaunchFor: async (s) => request(s.agentSessionId ?? s.sessionId),
    launch: async (r) => { launched.push(r); },
    log: (line) => logs.push(line),
    now: () => clock.now,
    boot: () => clock.boot,
  });
}

describe("the rules", () => {
  test("a boot is the same boot within rounding, a restart moves it", () => {
    expect(bootTime(1_000_000_000, 100)).toBe(999_900);
    expect(sameBoot(BOOT_A, BOOT_A + 2)).toBe(true);
    expect(sameBoot(BOOT_A, BOOT_B)).toBe(false);
  });

  test("conch watched to the end when the Mac said it was going, or conch never stopped", () => {
    const base = { heartbeat: T0 };
    expect(watchedToTheEnd(base)).toBe(true); // went down with the Mac
    expect(watchedToTheEnd({ ...base, poweringOffAt: T0 - 5_000, stoppedAt: T0 })).toBe(true); // a shutdown, then a clean stop
    expect(watchedToTheEnd({ ...base, stoppedAt: T0 })).toBe(false); // quit before the restart
    // A power-off long before conch's last look didn't happen: someone cancelled it.
    expect(watchedToTheEnd({ ...base, poweringOffAt: T0 - POWER_OFF_WINDOW_MS - 1, stoppedAt: T0 })).toBe(false);
  });

  test("after a restart: resumed when watched, offered when not, never what runs or was closed or came back too often", () => {
    const ledger: RestartLedger = {
      ...emptyLedger(BOOT_A, T0),
      records: [
        record("a"),
        record("live"),
        record("closed", { goneAt: T0 - GONE_GRACE_MS }),
        record("vanishing", { goneAt: T0 - 5_000 }), // went with the shutdown, in its last moments
        record("tired"),
      ],
      attempts: { tired: Array.from({ length: RESTORE_TRIES }, (_, i) => T0 + i) },
    };
    const plan = planAfterRestart({ ledger, liveConversations: new Set(["live"]), now: T0 + 60_000 });
    expect(plan.resume.map((r) => r.conversationId)).toEqual(["a", "vanishing"]);
    expect(plan.offer).toEqual([]);
    expect(Object.fromEntries(plan.skipped.map(({ record, why }) => [record.conversationId, why]))).toEqual({
      live: "it is running already",
      closed: "it was closed before the restart",
      tired: `already brought back ${RESTORE_TRIES} times today`,
    });
    const quit = planAfterRestart({ ledger: { ...ledger, stoppedAt: T0 }, liveConversations: new Set(), now: T0 + 60_000 });
    expect(quit.resume).toEqual([]);
    expect(quit.offer.map((r) => r.conversationId)).toEqual(["a", "live", "vanishing"]);
  });
});

describe("the guard", () => {
  test("it records what runs, once, with how to start it in the background", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    const asked: string[] = [];
    const g = new RestartGuard({
      file, now: () => clock.now, boot: () => clock.boot, log: () => {}, launch: async () => {},
      relaunchFor: async (s) => { asked.push(s.sessionId); return request(s.sessionId); },
    });
    await g.observe([session("a")], new Set(["a"]));
    clock.now += 1_000;
    await g.observe([session("a")], new Set(["a"]));
    expect(asked).toEqual(["a"]);
    const stored = JSON.parse(readFileSync(file, "utf8")) as RestartLedger;
    expect(stored.records.map((r) => [r.conversationId, r.request.host, r.request.resumeSessionId])).toEqual([["a", "background", "a"]]);
  });

  test("a session conch watches go is forgotten only once it has stayed gone", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    const g = guard(file, clock);
    await g.observe([session("a")], new Set(["a"]));
    clock.now += 10_000;
    await g.observe([], new Set());
    expect((JSON.parse(readFileSync(file, "utf8")) as RestartLedger).records.map((r) => r.conversationId)).toEqual(["a"]);
    clock.now += GONE_GRACE_MS + 1;
    await g.observe([], new Set());
    expect((JSON.parse(readFileSync(file, "utf8")) as RestartLedger).records).toEqual([]);
  });

  test("while the Mac powers off, nothing that ends is forgotten, and it all comes back after", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    const before = guard(file, clock);
    await before.observe([session("a"), session("b")], new Set(["a", "b"]));
    before.poweringOff();
    // Terminal quits before conch does: the sessions vanish while conch still looks.
    clock.now += 30_000;
    await before.observe([], new Set());
    clock.now += GONE_GRACE_MS + 30_000;
    await before.observe([], new Set());
    before.stopped();

    clock.now += 8 * 60 * 60_000;
    clock.boot = BOOT_B;
    const launched: StartSessionRequest[] = [];
    const after = guard(file, clock, launched);
    await after.observe([], new Set());
    expect(launched.map((r) => [r.resumeSessionId, r.host, r.trustFolder])).toEqual([["a", "background", true], ["b", "background", true]]);
    expect(after.summary().restored.map((s) => s.conversationId)).toEqual(["a", "b"]);
    after.dismissRestored();
    expect(after.summary().restored).toEqual([]);
  });

  test("a Mac that died with conch running brings its sessions back too", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    await guard(file, clock).observe([session("a")], new Set(["a"]));
    clock.now += 60 * 60_000;
    clock.boot = BOOT_B;
    const launched: StartSessionRequest[] = [];
    await guard(file, clock, launched).observe([], new Set());
    expect(launched.map((r) => r.resumeSessionId)).toEqual(["a"]);
  });

  test("a restart after conch was quit offers the sessions instead of starting them", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    const before = guard(file, clock);
    await before.observe([session("a")], new Set(["a"]));
    before.stopped();
    clock.now += 60 * 60_000;
    clock.boot = BOOT_B;
    const launched: StartSessionRequest[] = [];
    const after = guard(file, clock, launched);
    await after.observe([], new Set());
    expect(launched).toEqual([]);
    expect(after.summary().offered.map((s) => s.conversationId)).toEqual(["a"]);
    expect(await after.settleOffer(true)).toBe(1);
    expect(launched.map((r) => r.resumeSessionId)).toEqual(["a"]);
    expect(after.summary().offered).toEqual([]);
  });

  test("a daemon restart under a Mac that kept running restores nothing, and a session closed meanwhile is let go", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    const before = guard(file, clock);
    await before.observe([session("a")], new Set(["a"]));
    before.stopped();
    clock.now += 10 * 60_000;
    const launched: StartSessionRequest[] = [];
    const after = guard(file, clock, launched);
    await after.observe([], new Set());
    clock.now += GONE_GRACE_MS + 1;
    await after.observe([], new Set());
    expect(launched).toEqual([]);
    expect((JSON.parse(readFileSync(file, "utf8")) as RestartLedger).records).toEqual([]);
  });

  test("a conversation already running after the restart is not started twice", async () => {
    const file = freshFile();
    const clock = { now: T0, boot: BOOT_A };
    await guard(file, clock).observe([session("a")], new Set(["a"]));
    clock.now += 60 * 60_000;
    clock.boot = BOOT_B;
    const launched: StartSessionRequest[] = [];
    await guard(file, clock, launched).observe([session("a")], new Set(["a"]));
    expect(launched).toEqual([]);
  });
});

describe("the wiring, as source", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
  const daemon = read("src/daemon.ts");

  test("the daemon feeds it after the background guard, everything that guard doesn't host", () => {
    const at = daemon.indexOf("void backgroundGuard.observe(named, running).then(() => {");
    expect(at).toBeGreaterThan(-1);
    const chain = daemon.slice(at, daemon.indexOf("}).catch((error) => log(`session recovery: ${error}`));", at));
    expect(chain).toContain("const background = backgroundGuard.backgroundPids();");
    expect(chain).toContain("if (!background) return;");
    expect(chain).toContain("!s.parentSessionId && !s.jobId && s.messageRoute !== \"codex-app\"");
    expect(chain).toContain("!background.has(s.pid)");
    expect(chain).toContain("return restartGuard.observe(restartable, running);");
    // Named as the list names them.
    expect(daemon).toContain("const named = registryLive.map((s) => ({ ...s, label: labelForSessionId(s.sessionId) }));");
  });

  test("a power-off note, a clean stop, and the person's answer reach it", () => {
    expect(daemon).toContain("if (message.kind === \"system-power-off\") {\n      // The app heard the Mac is logging out, restarting or shutting down: what ends now comes back.\n      restartGuard.poweringOff();");
    expect(daemon).toContain("restartGuard.stopped();");
    expect(daemon).toContain("void restartGuard.settleOffer(message.accept)");
    expect(daemon).toContain("if (restore.restored.length || restore.offered.length) lastPublishedPanelState.restore = restore;");
  });

  test("the Mac app says when the Mac powers off, before anything quits, and shows what came back", () => {
    const app = read("mac-app/conch-mac/ConchMacApp.swift");
    expect(app).toContain("forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main");
    expect(app).toContain("ConchSocketClient().notifyNow([\"kind\": \"system-power-off\"])");
    const notices = read("mac-app/conch-mac/Notices.swift");
    expect(notices).toContain("RestoreNoticeLine()");
    expect(notices).toContain("Button(\"Bring them back\") { store.restoreSessions(accept: true) }");
    const store = read("mac-app/conch-mac/StateStore.swift");
    expect(store).toContain("restore: sourceState.restore");
  });

  test("the phone shows it too, and answers through the same control", () => {
    const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
    expect(ledger).toContain("if let restore = state.restore, !restore.restored.isEmpty || !restore.offered.isEmpty {");
    const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
    expect(bridge).toContain("await post(control: [\"kind\": \"restore-sessions\", \"accept\": accept])");
    expect(read("mobile/conch-ios/conch-ios/Models.swift")).toContain("restore = try? c.decodeIfPresent(Restore.self, forKey: .restore)");
  });
});
