import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhoneBridgeApplication, mintPairingCode, type PhoneSetupHooks } from "../src/phone-bridge.ts";
import {
  ComputerName,
  decodeSetupStage,
  PHONE_DEVICE_MAX_CHARS,
  PHONE_SETUP_MAX_DEVICES,
  PHONE_SETUP_REPORT_GRACE_MS,
  PHONE_SETUP_STAGES,
  PhoneSetup,
  phoneSetupPath,
  type PublishedPhone,
} from "../src/phone-setup.ts";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const scratch = () => join(mkdtempSync(join(tmpdir(), "conch-phone-setup-")), "phone-setup.json");
const report = (stage: string, declined: string[] = [], device = "Tyler's iPhone") => ({ kind: "setup-stage", stage, declined, device });
const decoded = (value: unknown) => {
  const result = decodeSetupStage(value);
  if (!result.ok) throw new Error(result.err);
  return result.value;
};

describe("a setup-stage report is checked strictly", () => {
  test("a report a phone following the flow sends is taken, trimmed and in the enum's order", () => {
    expect(decodeSetupStage(report("tour", ["microphone", "notifications"], "  Tyler's iPhone "))).toEqual({
      ok: true,
      value: { stage: "tour", declined: ["notifications", "microphone"], device: "Tyler's iPhone" },
    });
    // `kind` is optional on the dedicated route, and must say setup-stage when present.
    expect(decodeSetupStage({ stage: "paired", declined: [], device: "iPhone" }).ok).toBe(true);
    expect(decodeSetupStage({ ...report("paired"), kind: "phone-device" })).toEqual({ ok: false, err: "kind must be setup-stage" });
  });

  test("the stage is one of the enum's, and one a phone may say", () => {
    for (const stage of ["paired", "notifications", "microphone", "tour", "finished"]) {
      expect(decodeSetupStage(report(stage)).ok).toBe(true);
    }
    for (const stage of ["Paired", "done", "", "microphone ", "0"]) {
      expect(decodeSetupStage(report(stage))).toMatchObject({ ok: false, err: expect.stringContaining("stage must be one of") });
    }
    for (const stage of [3, null, undefined, ["tour"], { stage: "tour" }]) {
      expect(decodeSetupStage({ ...report("tour"), stage }).ok).toBe(false);
    }
    // The Mac's own stages: a phone that can report has got past both.
    expect(decodeSetupStage(report("waiting"))).toEqual({ ok: false, err: "waiting is the Mac's to say, not the phone's" });
    expect(decodeSetupStage(report("connecting"))).toEqual({ ok: false, err: "connecting is the Mac's to say, not the phone's" });
  });

  test("declined names only the permissions the phone asks for, once each, and only once reached", () => {
    expect(decodeSetupStage({ ...report("tour"), declined: "microphone" })).toEqual({ ok: false, err: "declined must be an array" });
    expect(decodeSetupStage({ stage: "tour", device: "iPhone" })).toEqual({ ok: false, err: "declined must be an array" });
    expect(decodeSetupStage(report("tour", ["tour"])).ok).toBe(false);
    expect(decodeSetupStage(report("tour", ["camera"])).ok).toBe(false);
    expect(decodeSetupStage(report("tour", ["microphone", "microphone"]))).toEqual({ ok: false, err: "declined names microphone twice" });
    expect(decodeSetupStage(report("tour", ["microphone", "notifications", "microphone"]))).toEqual({ ok: false, err: "declined has too many entries" });
    expect(decodeSetupStage(report("paired", ["microphone"]))).toEqual({ ok: false, err: "declined microphone before reaching it" });
    expect(decodeSetupStage(report("microphone", ["microphone"])).ok).toBe(true);
  });

  test("device is one short line naming the phone", () => {
    expect(decodeSetupStage({ stage: "paired", declined: [] })).toEqual({ ok: false, err: "device must be a string" });
    expect(decodeSetupStage(report("paired", [], "   "))).toEqual({ ok: false, err: "device must name the phone" });
    expect(decodeSetupStage(report("paired", [], "x".repeat(PHONE_DEVICE_MAX_CHARS))).ok).toBe(true);
    expect(decodeSetupStage(report("paired", [], "x".repeat(PHONE_DEVICE_MAX_CHARS + 1))).ok).toBe(false);
    // Counted in characters, not UTF-16 units: an emoji name is not cut short.
    expect(decodeSetupStage(report("paired", [], "🐚".repeat(PHONE_DEVICE_MAX_CHARS))).ok).toBe(true);
    for (const name of ["Tyler's\niPhone", "a\u0000b", "a b", "a\u007fb"]) {
      expect(decodeSetupStage(report("paired", [], name))).toEqual({ ok: false, err: "device must be one line of text" });
    }
    for (const value of [null, [], "setup-stage", 7]) expect(decodeSetupStage(value).ok).toBe(false);
  });
});

describe("the phone's setup, as the Mac holds it", () => {
  test("stages only move forward per device, and a late report never undoes one", () => {
    const setup = new PhoneSetup({ path: scratch() });
    expect(setup.report(decoded(report("paired")))).toEqual({ stage: "paired", moved: true });
    expect(setup.report(decoded(report("microphone")))).toEqual({ stage: "microphone", moved: true });
    expect(setup.report(decoded(report("microphone")))).toEqual({ stage: "microphone", moved: false });
    expect(setup.report(decoded(report("paired")))).toEqual({ stage: "microphone", moved: false });
    expect(setup.published(true).setup.stage).toBe("microphone");
    expect(setup.report(decoded(report("tour", ["microphone"])))).toEqual({ stage: "tour", moved: true });
    // A refusal said once stays said.
    setup.report(decoded(report("finished")));
    expect(setup.published(true)).toEqual({
      enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "finished", declined: ["microphone"] },
    });
  });

  test("a refusal on the screen already reported is taken without moving the stage", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(decoded(report("microphone")));
    expect(setup.report(decoded(report("microphone", ["microphone"])))).toEqual({ stage: "microphone", moved: true });
    expect(setup.published(true).setup).toEqual({ stage: "microphone", declined: ["microphone"] });
    // A late report can't add one either: it is ignored whole.
    setup.report(decoded(report("tour")));
    setup.report(decoded(report("microphone", ["microphone"])));
    expect(setup.published(true).setup).toEqual({ stage: "tour", declined: ["microphone"] });
  });

  test("a second phone starts its own setup, and the first can still move its own on", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(decoded(report("tour", [], "Tyler's iPhone")));
    setup.report(decoded(report("paired", [], "Work iPhone")));
    expect(setup.published(true)).toMatchObject({ device: "Work iPhone", setup: { stage: "paired" } });
    setup.report(decoded(report("paired", [], "Tyler's iPhone")));
    expect(setup.published(true)).toMatchObject({ device: "Work iPhone", setup: { stage: "paired" } });
    setup.report(decoded(report("finished", [], "Tyler's iPhone")));
    expect(setup.published(true)).toMatchObject({ device: "Tyler's iPhone", setup: { stage: "finished" } });
  });

  test("connecting is the key exchange in flight, only on a Mac no phone has paired with", () => {
    const changes: PublishedPhone[] = [];
    const setup: PhoneSetup = new PhoneSetup({ path: scratch(), onChange: () => changes.push(setup.published(true)) });
    expect(setup.published(false)).toEqual({ enabled: false, paired: false, device: null, setup: { stage: "waiting", declined: [] } });
    setup.exchange("started");
    expect(setup.published(true).setup.stage).toBe("connecting");
    setup.exchange("abandoned");
    expect(setup.published(true)).toMatchObject({ paired: false, setup: { stage: "waiting" } });
    setup.exchange("started");
    setup.exchange("completed");
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "paired", declined: [] } });
    expect(changes.map((phone) => phone.setup.stage)).toEqual(["connecting", "waiting", "connecting", "paired"]);
    // Every reconnect is a key exchange too; once paired they change nothing, and say nothing.
    setup.exchange("started");
    setup.exchange("completed");
    setup.exchange("abandoned");
    expect(changes).toHaveLength(4);
    expect(setup.published(true).setup.stage).toBe("paired");
  });

  test("a report means paired, whichever way the phone came in", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(decoded(report("paired")));
    expect(setup.published(true).paired).toBe(true);
  });

  test("it survives a restart, and connecting never reaches the disk", () => {
    const path = scratch();
    const first = new PhoneSetup({ path });
    first.exchange("started");
    expect(existsSync(path)).toBe(false);
    first.exchange("completed");
    first.report(decoded(report("tour", ["microphone"])));
    const again = new PhoneSetup({ path });
    expect(again.published(true)).toEqual(first.published(true));
    expect(again.report(decoded(report("microphone")))).toEqual({ stage: "tour", moved: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A restart mid-exchange comes back waiting, never stuck on connecting.
    const unpaired = scratch();
    new PhoneSetup({ path: unpaired }).exchange("started");
    expect(new PhoneSetup({ path: unpaired }).published(true).setup.stage).toBe("waiting");
  });

  test("a phone that paired and said nothing more is still paired after a restart, with nothing to mirror (#28)", () => {
    const path = scratch();
    const first = new PhoneSetup({ path });
    first.exchange("started");
    first.exchange("completed");
    expect(new PhoneSetup({ path }).published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "finished", declined: [] } });
  });

  test("a damaged file starts afresh and says so; a hand-edited stage is dropped", () => {
    const path = scratch();
    writeFileSync(path, "{not json");
    const logs: string[] = [];
    expect(new PhoneSetup({ path, log: (line) => logs.push(line) }).published(true).setup.stage).toBe("waiting");
    expect(logs[0]).toStartWith("phone setup: starting afresh");
    writeFileSync(path, JSON.stringify({
      version: 1, paired: true, device: "iPhone",
      devices: { iPhone: { stage: "sideways", declined: [], at: 1 }, Other: { stage: "tour", declined: ["tour"], at: 2 } },
    }));
    // Paired, and nothing sound reported: nothing to mirror.
    expect(new PhoneSetup({ path }).published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "finished", declined: [] } });
  });

  test(`at most ${PHONE_SETUP_MAX_DEVICES} phones are remembered, the oldest forgotten`, () => {
    const path = scratch();
    let now = 0;
    const setup = new PhoneSetup({ path, now: () => ++now });
    for (let index = 0; index <= PHONE_SETUP_MAX_DEVICES; index += 1) setup.report(decoded(report("tour", [], `iPhone ${index}`)));
    const phones = Object.keys(JSON.parse(readFileSync(path, "utf8")).phones);
    expect(phones).toHaveLength(PHONE_SETUP_MAX_DEVICES);
    expect(phones).not.toContain("name:iPhone 0");
    // Forgotten means a fresh start for that phone, not a refusal.
    expect(setup.report(decoded(report("paired", [], "iPhone 0")))).toEqual({ stage: "paired", moved: true });
  });

  test("lives with the pairing, under conch's own config", () => {
    expect(phoneSetupPath("/h")).toBe("/h/.config/conch/phone-setup.json");
  });
});

describe("the published contract the Mac's setup window codes against", () => {
  test("exactly { enabled, paired, device, setup: { stage, declined } }, in every state", () => {
    const setup = new PhoneSetup({ path: scratch() });
    const shapes: PublishedPhone[] = [setup.published(false)];
    setup.exchange("started");
    shapes.push(setup.published(true));
    setup.exchange("completed");
    shapes.push(setup.published(true));
    setup.report(decoded(report("tour", ["microphone"])));
    shapes.push(setup.published(true));
    for (const phone of shapes) {
      expect(Object.keys(phone).sort()).toEqual(["device", "enabled", "paired", "setup"]);
      expect(Object.keys(phone.setup).sort()).toEqual(["declined", "stage"]);
      expect(typeof phone.enabled).toBe("boolean");
      expect(typeof phone.paired).toBe("boolean");
      expect(phone.device === null || typeof phone.device === "string").toBe(true);
      expect(PHONE_SETUP_STAGES).toContain(phone.setup.stage);
      expect(Array.isArray(phone.setup.declined)).toBe(true);
      // Round-trips as JSON unchanged: no undefined, no Set, no Date.
      expect(JSON.parse(JSON.stringify(phone))).toEqual(phone);
    }
    expect(shapes.map((phone) => phone.setup.stage)).toEqual(["waiting", "connecting", "paired", "tour"]);
  });

  test("stays small at its largest", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(decoded(report("finished", ["notifications", "microphone"], "W".repeat(PHONE_DEVICE_MAX_CHARS))));
    expect(JSON.stringify(setup.published(true)).length).toBeLessThan(200);
  });

  test("enabled mirrors the setting, and the published copy can't reach back into the store", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(decoded(report("tour", ["microphone"])));
    expect(setup.published(false).enabled).toBe(false);
    setup.published(true).setup.declined.push("notifications");
    expect(setup.published(true).setup.declined).toEqual(["microphone"]);
  });

  test("the daemon publishes it on every full state and on every change, and on the phone setting's changes", () => {
    const daemon = read("src/daemon.ts");
    expect(daemon).toContain("const phoneSetup = new PhoneSetup({ onChange: () => publishPhoneSetup(), log });");
    expect(daemon).toContain("lastPublishedPanelState = { ...lastPublishedPanelState, ts: Date.now(), phone: phoneSetup.published(cfg.phoneEnabled) };");
    expect(daemon).toContain("lastPublishedPanelState.phone = phoneSetup.published(cfg.phoneEnabled);");
    const sync = daemon.slice(daemon.indexOf("function syncPhoneBridge(): void {"), daemon.indexOf("function applyPhoneTransports(): void {"));
    expect(sync).toContain("publishPhoneSetup();");
    const hooks = daemon.slice(daemon.indexOf("setup: {"), daemon.indexOf("macName: computerName,"));
    expect(hooks).toContain("report: (report) => phoneSetup.report(report),");
    expect(hooks).toContain("exchange: (event) => phoneSetup.exchange(event),");
    expect(read("src/panel.ts")).toContain("phone?: PublishedPhone;");
  });
});

describe("POST /setup-stage on the phone bridge", () => {
  function bridge(setup: PhoneSetupHooks | undefined) {
    return createPhoneBridgeApplication({
      getState: () => ({ v: 1, rows: [] }),
      forwardControl: async () => { throw new Error("setup-stage must not reach the control socket"); },
      replyFor: async () => "",
      acceptUpload: async () => ({ error: "no" }),
      ...(setup ? { setup } : {}),
      log() {},
    }, { token: "t".repeat(32) });
  }
  const post = (body: string, token = "t".repeat(32), headers: Record<string, string> = {}) =>
    new Request("https://conch.invalid/setup-stage", { method: "POST", body, headers: { authorization: `Bearer ${token}`, ...headers } });
  const hooks = (store: PhoneSetup): PhoneSetupHooks => ({
    report: (value) => store.report(value), exchange: (event) => store.exchange(event), macName: () => "Tyler's MacBook Pro",
  });

  test("answers with the stage, whether it moved, and the Mac's name", async () => {
    const store = new PhoneSetup({ path: scratch() });
    const app = bridge(hooks(store));
    const response = await app.handle(post(JSON.stringify(report("microphone"))))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "setup-stage-ack", stage: "microphone", moved: true, mac: "Tyler's MacBook Pro" });
    const again = await app.handle(post(JSON.stringify(report("paired"))))!;
    expect(await again.json()).toEqual({ kind: "setup-stage-ack", stage: "microphone", moved: false, mac: "Tyler's MacBook Pro" });
  });

  test("needs the phone's credential, like every route but /pair", async () => {
    const store = new PhoneSetup({ path: scratch() });
    const response = await bridge(hooks(store)).handle(post(JSON.stringify(report("finished")), "wrong"))!;
    expect(response.status).toBe(401);
    expect(store.published(true).paired).toBe(false);
  });

  test("refuses a bad report with the reason, and a big one before reading it", async () => {
    const store = new PhoneSetup({ path: scratch() });
    const app = bridge(hooks(store));
    const bad = await app.handle(post(JSON.stringify(report("waiting"))))!;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ kind: "setup-stage-error", error: "waiting is the Mac's to say, not the phone's" });
    expect((await app.handle(post("{"))!).status).toBe(400);
    const big = await app.handle(post(JSON.stringify({ ...report("tour"), pad: "x".repeat(2000) })))!;
    expect(big.status).toBe(413);
    expect(store.published(true)).toMatchObject({ paired: false, setup: { stage: "waiting" } });
  });

  test("a Mac without setup says it doesn't know the route, as an older one does", async () => {
    expect((await bridge(undefined).handle(post(JSON.stringify(report("paired"))))!).status).toBe(404);
  });

  test("a LAN pairing completes the key exchange; a wrong code does not", async () => {
    const store = new PhoneSetup({ path: scratch() });
    const app = bridge(hooks(store));
    const code = mintPairingCode();
    app.offerPairingCode(code);
    const wrong = code.code === "000000" ? "111111" : "000000";
    const pair = (value: string) => app.handle(new Request("https://conch.invalid/pair", { method: "POST", body: JSON.stringify({ code: value }) }))!;
    expect((await pair(wrong)).status).toBe(401);
    expect(store.published(true).paired).toBe(false);
    expect((await pair(code.code)).status).toBe(200);
    expect(store.published(true)).toMatchObject({ paired: true, setup: { stage: "paired" } });
  });
});

/** Two installs of the app, as iOS 16 names every phone: "iPhone". */
const FIRST = "6F1C2B3A-0D4E-4F5A-8B9C-0D1E2F3A4B5C";
const SECOND = "A0B1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D";
const installed = (stage: string, install: string, declined: string[] = [], device = "iPhone") => decoded({ ...report(stage, declined, device), install });

describe("each install keeps its own progress; the name is only shown (#27)", () => {
  test("a report may carry its install id: a short plain id, else refused; without one it is still taken", () => {
    expect(decodeSetupStage({ ...report("paired"), install: FIRST })).toEqual({
      ok: true, value: { stage: "paired", declined: [], device: "Tyler's iPhone", install: FIRST },
    });
    expect(decoded(report("paired"))).not.toHaveProperty("install");
    for (const install of ["", "short", "x".repeat(65), "has space in it", "slash/es-here", 42, null, ["id"]]) {
      expect(decodeSetupStage({ ...report("paired"), install }), JSON.stringify(install)).toEqual({ ok: false, err: "install must be the app's install id" });
    }
  });

  test("a second phone with the same name starts its own setup: not finished from its first report, no refusal it didn't make", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(installed("tour", FIRST, ["microphone"]));
    setup.report(installed("finished", FIRST, ["microphone"]));
    expect(setup.report(installed("paired", SECOND))).toEqual({ stage: "paired", moved: true });
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: "iPhone", setup: { stage: "paired", declined: [] } });
    expect(setup.report(installed("microphone", SECOND))).toEqual({ stage: "microphone", moved: true });
    expect(setup.published(true).setup).toEqual({ stage: "microphone", declined: [] });
  });

  test("this phone reinstalled (a new install id, a lower stage) starts afresh, and a rename is shown by its new name", () => {
    const path = scratch();
    const setup = new PhoneSetup({ path });
    setup.report(installed("finished", FIRST, ["microphone"], "Tyler's iPhone"));
    expect(setup.report(installed("paired", SECOND, [], "Tyler's iPhone"))).toEqual({ stage: "paired", moved: true });
    expect(setup.published(true)).toMatchObject({ device: "Tyler's iPhone", setup: { stage: "paired", declined: [] } });
    setup.report(installed("paired", SECOND, [], "Tyler's other iPhone"));
    expect(setup.published(true).device).toBe("Tyler's other iPhone");
    // On disk by install, each with its name; nothing else about the phone.
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(file.phones).sort()).toEqual([`install:${FIRST}`, `install:${SECOND}`]);
    expect(file.phones[`install:${SECOND}`].name).toBe("Tyler's other iPhone");
    expect(file.current).toBe(`install:${SECOND}`);
  });

  test("the first setup build's reports, without an install id, are kept by name, and its file is read", () => {
    const path = scratch();
    writeFileSync(path, JSON.stringify({
      version: 1, paired: true, device: "Tyler's iPhone",
      devices: { "Tyler's iPhone": { stage: "tour", declined: ["microphone"], at: 5 } },
    }));
    const setup = new PhoneSetup({ path });
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: "Tyler's iPhone", setup: { stage: "tour", declined: ["microphone"] } });
    expect(setup.report(decoded(report("finished")))).toEqual({ stage: "finished", moved: true });
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).phones)).toEqual(["name:Tyler's iPhone"]);
    // The same phone updated to an app with install ids: its own record from now on.
    expect(setup.report(installed("finished", FIRST, [], "Tyler's iPhone"))).toEqual({ stage: "finished", moved: true });
  });

  test("the published block keeps its contract: the name, never the install id", () => {
    const setup = new PhoneSetup({ path: scratch() });
    setup.report(installed("tour", FIRST, ["microphone"], "Tyler's iPhone"));
    const phone = setup.published(true);
    expect(Object.keys(phone).sort()).toEqual(["device", "enabled", "paired", "setup"]);
    expect(Object.keys(phone.setup).sort()).toEqual(["declined", "stage"]);
    expect(JSON.stringify(phone)).not.toContain(FIRST);
  });
});

describe("a paired phone that never reports doesn't leave the Mac waiting on it (#28)", () => {
  function clocked(path = scratch()) {
    let now = 1_000_000;
    const timers: Array<{ run: () => void; due: number; cleared: boolean }> = [];
    const changes: PublishedPhone[] = [];
    const setup: PhoneSetup = new PhoneSetup({
      path,
      now: () => now,
      onChange: () => changes.push(setup.published(true)),
      setTimer: (run, ms) => {
        const timer = { run, due: now + ms, cleared: false };
        timers.push(timer);
        return { clear: () => { timer.cleared = true; } };
      },
    });
    /** Time passes, and the timers due in it fire. */
    const pass = (ms: number) => {
      now += ms;
      for (const timer of [...timers]) {
        if (!timer.cleared && timer.due <= now) {
          timer.cleared = true;
          timer.run();
        }
      }
    };
    return { setup, changes, pass, path };
  }

  test("paired by a key exchange and silent: paired while it may still report, then finished with nothing to mirror", () => {
    const { setup, changes, pass } = clocked();
    setup.exchange("started");
    setup.exchange("completed");
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "paired", declined: [] } });
    pass(PHONE_SETUP_REPORT_GRACE_MS - 1_000);
    expect(setup.published(true).setup.stage).toBe("paired");
    pass(2_000);
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "finished", declined: [] } });
    // Said, without anything else happening: the Mac's step moves on by itself.
    expect(changes.at(-1)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "finished", declined: [] } });
  });

  test("a phone that reports in time is followed as before, and the wait's end changes nothing", () => {
    const { setup, changes, pass } = clocked();
    setup.exchange("started");
    setup.exchange("completed");
    pass(1_000);
    setup.report(installed("paired", FIRST));
    pass(PHONE_SETUP_REPORT_GRACE_MS);
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: "iPhone", setup: { stage: "paired", declined: [] } });
    expect(changes.map((phone) => `${phone.setup.stage} ${phone.device}`)).toEqual(["connecting null", "paired null", "paired iPhone"]);
  });

  test("an earlier install's record, stopped part way, isn't shown for a phone that connects and says nothing", () => {
    const path = scratch();
    const before = new PhoneSetup({ path });
    before.report(installed("tour", FIRST, ["microphone"]));
    // Reinstalled: the pairing survived in the Keychain, the setup didn't, so the app says nothing.
    const { setup, pass } = clocked(path);
    expect(setup.published(true).setup.stage).toBe("tour");
    setup.exchange("started");
    setup.exchange("completed");
    expect(setup.published(true).setup.stage).toBe("tour");
    pass(PHONE_SETUP_REPORT_GRACE_MS + 1);
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: null, setup: { stage: "finished", declined: [] } });
    // It reports after all: its own progress, from its own start.
    setup.report(installed("paired", SECOND));
    expect(setup.published(true)).toEqual({ enabled: true, paired: true, device: "iPhone", setup: { stage: "paired", declined: [] } });
  });

  test("a phone part way through that reconnects and says where it is stays followed", () => {
    const { setup, pass } = clocked();
    setup.report(installed("microphone", FIRST));
    setup.exchange("started");
    setup.exchange("completed");
    pass(500);
    expect(setup.report(installed("microphone", FIRST))).toEqual({ stage: "microphone", moved: false });
    pass(PHONE_SETUP_REPORT_GRACE_MS + 1);
    expect(setup.published(true).setup.stage).toBe("microphone");
  });

  test("a finished phone that reconnects saying nothing is still finished, by its name", () => {
    const { setup, pass } = clocked();
    setup.report(installed("finished", FIRST, [], "Tyler's iPhone"));
    setup.exchange("started");
    setup.exchange("completed");
    pass(PHONE_SETUP_REPORT_GRACE_MS + 1);
    expect(setup.published(true)).toMatchObject({ device: "Tyler's iPhone", setup: { stage: "finished" } });
  });

});

describe("the Mac's name is known before any phone asks, and asking never holds the daemon (D7)", () => {
  test("before it has been asked: the host name, from what's known", () => {
    const name = new ComputerName(() => "tylers-mbp");
    expect(name.current()).toBe("tylers-mbp");
  });

  test("asked once, off the request path: its answer is kept, and asked again it isn't re-asked", async () => {
    let asked = 0;
    const name = new ComputerName(() => "tylers-mbp");
    const ask = async () => { asked++; return "Tyler's MacBook Pro\n"; };
    expect(await name.resolve({ ask })).toBe("Tyler's MacBook Pro");
    expect(await name.resolve({ ask })).toBe("Tyler's MacBook Pro");
    expect(name.current()).toBe("Tyler's MacBook Pro");
    expect(asked).toBe(1);
  });

  test("an answer that never comes, fails, or is empty: the host name, within the timeout", async () => {
    const hangs = new ComputerName(() => "tylers-mbp");
    const started = Date.now();
    expect(await hangs.resolve({ timeoutMs: 40, ask: () => new Promise(() => {}) })).toBe("tylers-mbp");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await new ComputerName(() => "tylers-mbp").resolve({ ask: async () => { throw new Error("no scutil"); } })).toBe("tylers-mbp");
    expect(await new ComputerName(() => "tylers-mbp").resolve({ ask: async () => "  " })).toBe("tylers-mbp");
    expect((await new ComputerName(() => "h").resolve({ ask: async () => "M".repeat(200) })).length).toBe(PHONE_DEVICE_MAX_CHARS);
  });

  test("nothing blocking in phone-setup.ts; the daemon asks at start, and the phone's route reads what's known", () => {
    expect(read("src/phone-setup.ts")).not.toContain("spawnSync");
    const daemon = read("src/daemon.ts");
    expect(daemon).toContain("void resolveComputerName();");
    expect(daemon.indexOf("void resolveComputerName();")).toBeLessThan(daemon.indexOf("macName: computerName,"));
  });
});
