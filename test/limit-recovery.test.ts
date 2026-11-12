import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_LIMIT_STOP } from "../src/claude-limit-menu.ts";
import { liveRunSessionSlots, type SwapUsageAccount } from "../src/claude-swap.ts";
import { PASTE_OVER_CHARS, TMUX_PASTE_OVER_CHARS } from "../src/inject.ts";
import {
  accountRoom, answerLimitMenu, limitNoticeText, LimitRecovery, pickRoomyAccount, resumeMessage, SWITCH_SETTLE_MS,
  type LimitNotice, type LimitRecoveryDeps, type LimitSession, type TypeBlocker,
} from "../src/limit-recovery.ts";
import { shellQuote } from "../src/agent-adapter.ts";
import { startBackgroundProcess } from "../src/background-sessions.ts";
import { probeCommand } from "../src/probe.ts";
import { paneTarget, resolveTmux } from "../src/tmux-binary.ts";

/**
 * 2026-11-12, Tyler: "it didn't autoswitch cause it got stuck on a terminal message", then "resume all". The night, as
 * these tests play it: account 2 ran out at 00:29 and claude-swap moved Default to account 1, itself near its week's
 * limit, because the one account with room, 3, had a `cswap run` session on it. Account 1 ran out at 00:45 and every
 * Default session stopped on Claude Code's usage-limit menu. A switch to 3 by hand at 00:53 didn't move them.
 */
const NIGHT = Date.parse("2026-11-12T00:45:00Z");
const rule = "─".repeat(72);
const ROWS = { stop: CLAUDE_LIMIT_STOP, wait: "Wait here, then continue automatically at 10pm", funds: "Add funds to continue with usage credits" };
const TYLERS = [ROWS.stop, ROWS.wait, ROWS.funds];

function account(number: number, pct: number, extra: Partial<SwapUsageAccount> = {}, readAt = NIGHT - 60_000): SwapUsageAccount {
  return {
    id: JSON.stringify([number]), number, label: `account ${number}`, email: `account${number}@example.test`, defaultLogin: false,
    status: "ok", windows: [{ name: "7 day", pct }], fetchedAt: new Date(readAt).toISOString(), lastGood: false, ...extra,
  };
}

interface Screen { menu?: { rows: string[]; at: number }; prompt: string; chose: string[] }

function draw(screen: Screen): string {
  const top = ["❯ keep going", "", "  ⎿  You've hit your weekly limit · resets Nov 14 at 10pm", ""];
  if (screen.menu) {
    return [...top, rule, "  What do you want to do?", "",
      ...screen.menu.rows.map((label, index) => `  ${index === screen.menu!.at ? "❯" : " "} ${index + 1}. ${label}`), "",
      "  Enter to confirm · Esc to cancel"].join("\n");
  }
  return [...top, rule, `❯ ${screen.prompt}`, rule].join("\n");
}

/** Sessions on the menu, claude-swap's list, the app's switch and conch's delivery, all stood in for. */
function night(options: { active?: number; accounts?: SwapUsageAccount[]; liveRun?: number[]; prefill?: string } = {}) {
  let clock = NIGHT;
  let accounts = (options.accounts ?? [account(1, 100), account(2, 100), account(3, 14)])
    .map((one) => ({ ...one, defaultLogin: one.number === (options.active ?? 1) }));
  const liveRun = new Set(options.liveRun ?? []);
  const sessions: LimitSession[] = [];
  const screens = new Map<string, Screen>();
  const windows = new Set<string>();
  const blockers = new Map<string, TypeBlocker>();
  const presses: string[] = [];
  const typed: Array<[string, string]> = [];
  const switches: number[] = [];
  const notices: LimitNotice[] = [];
  const lines: string[] = [];
  let idle = 0;
  let enabled = true;
  let typeAnswer: true | string = true;
  const deps: LimitRecoveryDeps = {
    enabled: () => enabled,
    sessions: () => sessions,
    readScreen: async (session) => draw(screens.get(session.sessionId)!),
    inPane: async (session) => !windows.has(session.sessionId),
    idleSeconds: async () => idle,
    pressKey: async (session, key) => {
      presses.push(`${session.label}:${key}`);
      const screen = screens.get(session.sessionId)!;
      const menu = screen.menu;
      if (!menu) return true;
      if (key === "Up") menu.at = Math.max(0, menu.at - 1);
      if (key === "Down") menu.at = Math.min(menu.rows.length - 1, menu.at + 1);
      if (key === "Enter") {
        screen.chose.push(menu.rows[menu.at]!);
        if (menu.rows[menu.at] === ROWS.stop) { screen.menu = undefined; screen.prompt = options.prefill ?? ""; }
      }
      return true;
    },
    alive: () => true,
    dashboard: async () => ({ source: "claude-swap", state: "ready", accounts }),
    liveRunSlots: () => liveRun,
    switchTo: async (slot) => {
      switches.push(slot);
      accounts = accounts.map((one) => ({ ...one, defaultLogin: one.number === slot }));
      return { ok: true, output: "" };
    },
    typeBlocker: (session) => blockers.get(session.sessionId) ?? null,
    type: async (session, text) => {
      typed.push([session.label, text]);
      if (typeAnswer !== true) return typeAnswer;
      screens.get(session.sessionId)!.prompt = "";
      const row = sessions.find((one) => one.sessionId === session.sessionId)!;
      row.status = "busy";
      delete row.usageLimit;
      return true;
    },
    notify: (notice) => notices.push(notice),
    log: (line) => lines.push(line),
    now: () => clock,
    menu: { intervalMs: 1, settleMs: 1, waitMs: 2_000 },
  };
  const recovery = new LimitRecovery(deps);
  const world = {
    recovery, presses, typed, switches, notices, lines, screens, sessions, windows, blockers,
    /** A session stopped on the menu. */
    stopped(label: string, extra: Partial<LimitSession> = {}, rows = TYLERS, at = 0): LimitSession {
      const session: LimitSession = {
        sessionId: `id-${label}`, label, backend: "claude", pid: 100 + sessions.length, status: "waiting", rotation: true,
        usageLimit: "You've hit your weekly limit · resets Nov 14 at 10pm", ...extra,
      };
      sessions.push(session);
      screens.set(session.sessionId, { menu: { rows: [...rows], at }, prompt: "", chose: [] });
      return session;
    },
    /** It stops on the menu again. */
    stopsAgain(session: LimitSession): void {
      session.status = "waiting";
      session.usageLimit = "You've hit your weekly limit";
      screens.get(session.sessionId)!.menu = { rows: [...TYLERS], at: 0 };
    },
    async look(after = 15_000): Promise<void> { clock += after; await recovery.look(); },
    get accounts() { return accounts; },
    set accounts(next: SwapUsageAccount[]) { accounts = next; },
    get now() { return clock; },
    set idle(seconds: number) { idle = seconds; },
    set enabled(on: boolean) { enabled = on; },
    set typeAnswer(answer: true | string) { typeAnswer = answer; },
    /** Tyler choosing an account in Settings › Providers › Claude: the app's switch, which the daemon passes on. */
    switchByHand(slot: number): void {
      accounts = accounts.map((one) => ({ ...one, defaultLogin: one.number === slot }));
      recovery.noteSwitch(slot);
    },
  };
  return world;
}

describe("which account has room", () => {
  test("at or near its limit, held out, signed out, unread or long unread: no room", () => {
    expect(accountRoom(account(3, 14), NIGHT)).toEqual({ room: true, used: 14 });
    expect(accountRoom(account(1, 90), NIGHT)).toEqual({ room: false, why: "90% of its 7 day limit used" });
    expect(accountRoom(account(1, 100), NIGHT)).toMatchObject({ room: false });
    expect(accountRoom(account(3, 14, { windows: [{ name: "7 day", pct: 14 }, { name: "Fable", pct: 96 }] }), NIGHT))
      .toEqual({ room: false, why: "96% of its Fable limit used" });
    expect(accountRoom(account(3, 14, { disabled: true }), NIGHT)).toEqual({ room: false, why: "held out of the rotation" });
    expect(accountRoom(account(3, 14, { status: "relogin_required" }), NIGHT)).toEqual({ room: false, why: "needs signing in again" });
    expect(accountRoom(account(3, 14, { windows: [] }), NIGHT)).toEqual({ room: false, why: "no usage reading" });
    expect(accountRoom(account(3, 14, {}, NIGHT - 45 * 60_000), NIGHT)).toEqual({ room: false, why: "usage last read 45 min ago" });
    // claude-swap's last good reading, too old for it to act on but recent: an account no one is on doesn't move.
    expect(accountRoom(account(3, 14, { status: "unavailable", lastGood: true }, NIGHT - 8 * 60_000), NIGHT)).toEqual({ room: true, used: 14 });
  });

  test("the night: account 3 had room, but a `cswap run` session was on it, so there was nowhere to go", () => {
    const accounts = [account(1, 100), account(2, 100), account(3, 14)];
    expect(pickRoomyAccount(accounts, 1, new Set([3]), NIGHT)).toEqual({
      passedOver: ["account 2: 100% of its 7 day limit used", "account 3: a `cswap run` session is on it"],
    });
    expect(pickRoomyAccount(accounts, 1, new Set(), NIGHT)).toMatchObject({ target: { number: 3 }, used: 14 });
  });

  test("the most room wins, never the account in use, never one near its limit", () => {
    const accounts = [account(1, 100), account(2, 40), account(3, 14), account(4, 92), account(5, 3)];
    expect(pickRoomyAccount(accounts, 5, new Set(), NIGHT).target?.number).toBe(3);
    expect(pickRoomyAccount([account(1, 100), account(2, 92)], 1, new Set(), NIGHT).target).toBeUndefined();
  });

  test("a `cswap run` session is found as claude-swap finds it: a live process in that account's profile", () => {
    const home = mkdtempSync(join(tmpdir(), "cswap-home-"));
    const profile = (name: string, pid: number) => {
      const dir = join(home, ".claude-swap-backup", "sessions", name, "sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: "x", cwd: "/" }));
    };
    profile("3-someone_example.test", 4927);
    profile("2-other_example.test", 5000);
    expect([...liveRunSessionSlots(home, (pid) => pid === 4927)]).toEqual([3]);
    expect([...liveRunSessionSlots(join(home, "nowhere"))]).toEqual([]);
  });
});

describe("what a stopped session is told, and what Tyler is told", () => {
  test("the message goes in as typed keys, not a paste, and says what happened and what to do", () => {
    for (const switched of [true, false]) {
      const text = resumeMessage(3, switched);
      expect(text.length).toBeLessThanOrEqual(Math.min(TMUX_PASTE_OVER_CHARS, PASTE_OVER_CHARS));
      expect(text).toContain("account 3");
      expect(text).toContain("restart any background agents that stopped on the limit");
    }
    expect(resumeMessage(3, true)).toContain("conch switched you to account 3");
  });

  test("one notice for the whole of it", () => {
    const base = { resumed: [] as string[], left: new Map<string, string>(), stuck: new Map<string, string>(), codex: [] as string[] };
    expect(limitNoticeText({ ...base, ranOut: 1, switchedTo: 3, on: 3, resumed: ["a", "b", "c", "d"] }))
      .toBe("Account 1 ran out; switched to account 3 and resumed 4 sessions.");
    expect(limitNoticeText({ ...base, ranOut: 1, on: 3, resumed: ["a"] })).toBe("Account 1 ran out; Claude is on account 3 now and resumed 1 session.");
    expect(limitNoticeText({ ...base, ranOut: 1, noRoom: "account 2: 100% of its 7 day limit used" }))
      .toBe("Account 1 ran out and no other account has room: account 2: 100% of its 7 day limit used.");
    expect(limitNoticeText({ ...base, ranOut: 1, switchedTo: 3, on: 3, resumed: ["a"], left: new Map([["b", "manual mode"]]), codex: ["c"] }))
      .toBe("Account 1 ran out; switched to account 3 and resumed 1 session. Out of the limit menu but not told to carry on: b (manual mode). "
        + "Codex: c has hit usage limits (/goal resume); Codex's limits are its own, so conch leaves it alone.");
  });
});

describe("sessions stopped at the limit, put back to work", () => {
  test("the night, replayed: nowhere to go is said once, and Tyler's switch to 3 resumes every session", async () => {
    const world = night({ liveRun: [3] });
    world.stopped("dashboard");
    world.stopped("importer");
    await world.look();
    // Account 1 is out; 2 is out; 3 has a `cswap run` session on it. No switch, no key pressed.
    expect(world.switches).toEqual([]);
    expect(world.presses).toEqual([]);
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0]!.text).toStartWith("Account 1 ran out and no other account has room: account 2: 100% of its 7 day limit used; account 3: a `cswap run` session is on it.");
    expect(world.notices[0]!.text).toContain("choose it in Settings › Providers › Claude");
    expect(world.notices[0]!.needsYou).toBe(true);
    for (let i = 0; i < 4; i++) await world.look();
    expect(world.notices).toHaveLength(1);

    // 00:53: Tyler chooses account 3. The sessions get time to pick the login up before anything is pressed.
    world.switchByHand(3);
    await world.look();
    expect(world.presses).toEqual([]);
    await world.look(SWITCH_SETTLE_MS);
    // "Stop and wait" was already highlighted: Enter, once, in each. Never another row.
    expect(world.presses).toEqual(["dashboard:Enter", "importer:Enter"]);
    for (const screen of world.screens.values()) expect(screen.chose).toEqual([CLAUDE_LIMIT_STOP]);
    expect(world.typed.map(([label]) => label)).toEqual(["dashboard", "importer"]);
    expect(world.typed[0]![1]).toBe(resumeMessage(3, false));
    expect(world.notices.at(-1)).toEqual({ text: "Account 1 ran out; Claude is on account 3 now and resumed 2 sessions.", needsYou: false, failures: [] });
    // Once per limit event: nothing more on later looks.
    for (let i = 0; i < 3; i++) await world.look();
    expect(world.presses).toHaveLength(2);
    expect(world.typed).toHaveLength(2);
    expect(world.notices).toHaveLength(2);
  });

  test("with an account that has room, conch switches now, then resumes", async () => {
    const world = night();
    world.stopped("dashboard");
    world.stopped("docs site");
    await world.look();
    expect(world.switches).toEqual([3]);
    expect(world.lines.some((line) => line.includes("switching Claude to account 3 (14% used)"))).toBe(true);
    expect(world.presses).toEqual([]);
    await world.look(SWITCH_SETTLE_MS);
    expect(world.typed.map(([, text]) => text)).toEqual([resumeMessage(3, true), resumeMessage(3, true)]);
    expect(world.notices).toEqual([{ text: "Account 1 ran out; switched to account 3 and resumed 2 sessions.", needsYou: false, failures: [] }]);
  });

  test("never into an account at or near its limit", async () => {
    const world = night({ accounts: [account(1, 100), account(2, 93)] });
    world.stopped("dashboard");
    await world.look();
    expect(world.switches).toEqual([]);
    expect(world.presses).toEqual([]);
    expect(world.notices[0]!.text).toBe("Account 1 ran out and no other account has room: account 2: 93% of its 7 day limit used.");
  });

  test("only ever \"Stop and wait\": from another row it is reached with Up, one key per look", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    world.stopped("dashboard", {}, TYLERS, 2);
    await world.look(SWITCH_SETTLE_MS);
    expect(world.presses).toEqual(["dashboard:Up", "dashboard:Up", "dashboard:Enter"]);
    expect(world.screens.get("id-dashboard")!.chose).toEqual([CLAUDE_LIMIT_STOP]);
  });

  test("manual mode: out of the menu, nothing typed, and said", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    world.stopped("dashboard");
    const quiet = world.stopped("notes");
    world.blockers.set(quiet.sessionId, "manual mode");
    await world.look(SWITCH_SETTLE_MS);
    expect(world.screens.get(quiet.sessionId)!.chose).toEqual([CLAUDE_LIMIT_STOP]);
    expect(world.typed.map(([label]) => label)).toEqual(["dashboard"]);
    expect(world.notices[0]!.text).toBe("Account 1 ran out; Claude is on account 3 now and resumed 1 session. Out of the limit menu but not told to carry on: notes (manual mode).");
    expect(world.notices[0]!.needsYou).toBe(true);
  });

  test("while conch's mic is open the message waits, then goes in once it closes", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    const session = world.stopped("dashboard");
    world.blockers.set(session.sessionId, "the mic is open");
    await world.look(SWITCH_SETTLE_MS);
    expect(world.screens.get(session.sessionId)!.chose).toEqual([CLAUDE_LIMIT_STOP]);
    expect(world.typed).toEqual([]);
    expect(world.notices).toEqual([]);
    world.blockers.delete(session.sessionId);
    await world.look();
    expect(world.typed.map(([label]) => label)).toEqual(["dashboard"]);
    expect(world.notices.map((notice) => notice.text)).toEqual(["Account 1 ran out; Claude is on account 3 now and resumed 1 session."]);
  });

  test("Claude Code's own \"continue\" in the prompt is typed over; words of yours are left alone", async () => {
    const world = night({ active: 3, prefill: "continue" });
    world.recovery.noteSwitch(3, 1);
    world.stopped("dashboard");
    await world.look(SWITCH_SETTLE_MS);
    expect(world.typed.map(([label]) => label)).toEqual(["dashboard"]);

    const typing = night({ active: 3, prefill: "hold on, I" });
    typing.recovery.noteSwitch(3, 1);
    typing.stopped("dashboard");
    await typing.look(SWITCH_SETTLE_MS);
    expect(typing.typed).toEqual([]);
    expect(typing.notices[0]!.text).toContain("dashboard (something was already typed in its prompt)");
  });

  test("a session that stops again on the account it was resumed onto isn't resumed again there; the account counts as out", async () => {
    const world = night({ active: 3, accounts: [account(1, 100), account(2, 30), account(3, 14)] });
    world.recovery.noteSwitch(3, 1);
    const session = world.stopped("dashboard");
    await world.look(SWITCH_SETTLE_MS);
    expect(world.typed).toHaveLength(1);
    // Its reading still says 14%, older than the stop: the stop is believed.
    world.stopsAgain(session);
    await world.look();
    expect(world.presses).toEqual(["dashboard:Enter"]);
    expect(world.switches).toEqual([2]);
    await world.look(SWITCH_SETTLE_MS);
    expect(world.presses).toEqual(["dashboard:Enter", "dashboard:Enter"]);
    expect(world.typed.map(([, text]) => text)).toEqual([resumeMessage(3, false), resumeMessage(2, true)]);
  });

  test("with nowhere else to go, a stop on the account it was resumed onto is said once, and a fresh reading is believed again", async () => {
    const world = night({ active: 3, accounts: [account(1, 100), account(3, 14)] });
    world.recovery.noteSwitch(3, 1);
    const session = world.stopped("dashboard");
    await world.look(SWITCH_SETTLE_MS);
    world.stopsAgain(session);
    await world.look();
    expect(world.notices.at(-1)!.text).toBe("Account 3 ran out and no other account has room: account 1: 100% of its 7 day limit used.");
    // claude-swap reads account 3 again after the stop and still says 14%: believed, but the session isn't resumed twice there.
    world.accounts = [account(1, 100), { ...account(3, 14, {}, world.now + 60_000), defaultLogin: true }];
    await world.look(5 * 60_000);
    await world.look();
    expect(world.presses).toEqual(["dashboard:Enter"]);
    expect(world.typed).toHaveLength(1);
    expect(world.notices.at(-1)!.text).toBe("Still on the limit menu: dashboard (it stopped at the limit again on account 3).");
    const told = world.notices.length;
    for (let i = 0; i < 3; i++) await world.look();
    expect(world.notices).toHaveLength(told);
  });

  test("a session on a sign-in of its own, and Codex's goal at its limits, are said, never touched", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    world.stopped("dashboard");
    world.stopped("billing", { rotation: false });
    const codex: LimitSession = { sessionId: "id-codex", label: "Codex review", backend: "codex", pid: 900, status: "idle", rotation: false };
    world.sessions.push(codex);
    const codexScreens: string[] = [];
    const deps = (world.recovery as unknown as { deps: LimitRecoveryDeps }).deps;
    const read = deps.readScreen;
    deps.readScreen = async (session) => {
      if (session.backend !== "codex") return read(session);
      codexScreens.push(session.label);
      return "› Ask Codex to do anything\n\n  Goal hit usage limits (/goal resume) · 2h 13m";
    };
    await world.look(SWITCH_SETTLE_MS);
    expect(world.presses).toEqual(["dashboard:Enter"]);
    expect(world.typed.map(([label]) => label)).toEqual(["dashboard"]);
    expect(codexScreens).toEqual(["Codex review"]);
    expect(world.notices).toHaveLength(1);
    expect(world.notices[0]!.text).toBe("Account 1 ran out; Claude is on account 3 now and resumed 1 session. "
      + "Still on the limit menu: billing (it's on a sign-in of its own, which rotation doesn't switch). "
      + "Codex: Codex review has hit usage limits (/goal resume); Codex's limits are its own, so conch leaves it alone.");
  });

  test("a session in a Terminal window waits for the Mac to be left alone", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    const session = world.stopped("terminal one");
    world.windows.add(session.sessionId);
    world.idle = 5;
    await world.look(SWITCH_SETTLE_MS);
    expect(world.presses).toEqual([]);
    world.idle = 75;
    await world.look();
    expect(world.presses).toEqual(["terminal one:Enter"]);
    expect(world.typed.map(([label]) => label)).toEqual(["terminal one"]);
    expect(world.notices.map((notice) => notice.text)).toEqual(["Account 1 ran out; Claude is on account 3 now and resumed 1 session."]);
  });

  test("a message that doesn't go in is said and filed", async () => {
    const world = night({ active: 3 });
    world.recovery.noteSwitch(3, 1);
    world.stopped("dashboard");
    world.typeAnswer = "front-window-changed";
    await world.look(SWITCH_SETTLE_MS);
    expect(world.notices[0]!.text).toContain("dashboard (the message didn't go in: front-window-changed)");
    expect(world.notices[0]!.failures).toHaveLength(1);
  });

  test("off, it looks at nothing", async () => {
    const world = night();
    world.stopped("dashboard");
    world.enabled = false;
    let read = 0;
    const deps = (world.recovery as unknown as { deps: LimitRecoveryDeps }).deps;
    deps.readScreen = async () => { read += 1; return null; };
    await world.look();
    expect(read).toBe(0);
    expect(world.switches).toEqual([]);
  });

  test("a session whose transcript doesn't end at a limit, or that isn't waiting on a dialog, isn't looked at", async () => {
    const world = night({ active: 3 });
    world.stopped("dashboard", { usageLimit: undefined });
    world.stopped("importer", { status: "busy" });
    await world.look(SWITCH_SETTLE_MS);
    expect(world.presses).toEqual([]);
    expect(world.notices).toEqual([]);
  });
});

// For real, on the suite's own tmux server (test/preload.ts), against a stand-in for Claude Code's usage-limit menu
// (fixtures/fake-claude-limit.ts) that takes Up, Down and Enter as its picker does and writes what it was told.
const tmux = resolveTmux().found;
const fixture = join(import.meta.dir, "fixtures", "fake-claude-limit.ts");

async function fakeClaude(rows = "stop,wait,funds", start = 0, deafMs = 0, prefill = ""): Promise<{ pane: string; out: string }> {
  const out = join(mkdtempSync(join(tmpdir(), "limit-")), "told");
  const { pane } = await startBackgroundProcess(
    `exec ${[process.execPath, fixture, out, rows, String(start), String(deafMs), prefill].map(shellQuote).join(" ")}`, tmpdir());
  return { pane, out };
}

async function screenOf(pane: string): Promise<string | null> {
  const target = paneTarget(pane)!;
  return probeCommand([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0]);
}
async function press(pane: string, ...keys: string[]): Promise<boolean> {
  const target = paneTarget(pane)!;
  return await probeCommand([...target.tmux, "send-keys", "-t", target.pane, ...keys], [0]) !== null;
}
async function told(out: string, lines: number): Promise<string[]> {
  for (let tries = 0; tries < 50; tries++) {
    try {
      const said = readFileSync(out, "utf8").trim().split("\n");
      if (said.length >= lines) return said;
    } catch {}
    await Bun.sleep(100);
  }
  try { return readFileSync(out, "utf8").trim().split("\n"); } catch { return []; }
}
async function drawn(pane: string): Promise<void> {
  for (let tries = 0; tries < 50 && !(await screenOf(pane))?.includes(CLAUDE_LIMIT_STOP); tries++) await Bun.sleep(100);
}
const io = (pane: string, sent: string[] = []) => ({
  look: () => screenOf(pane),
  press: (key: "Up" | "Down" | "Enter") => { sent.push(key); return press(pane, key); },
  gone: () => false,
});

describe.skipIf(!tmux)("choosing \"Stop and wait\" in a stand-in for Claude Code's menu", () => {
  test("chosen with one Enter when it is already highlighted, and answered once the menu has gone", async () => {
    const { pane, out } = await fakeClaude();
    await drawn(pane);
    const sent: string[] = [];
    expect(await answerLimitMenu(io(pane, sent))).toBe("answered");
    expect(sent).toEqual(["Enter"]);
    expect(await told(out, 1)).toEqual([`chose: ${CLAUDE_LIMIT_STOP}`]);
  }, 15_000);

  test("from the last row, Up until it is reached, never Enter on another row", async () => {
    const { pane, out } = await fakeClaude("funds,upgrade,stop,wait", 3);
    await drawn(pane);
    const sent: string[] = [];
    expect(await answerLimitMenu(io(pane, sent))).toBe("answered");
    expect(sent).toEqual(["Up", "Enter"]);
    expect(await told(out, 1)).toEqual([`chose: ${CLAUDE_LIMIT_STOP}`]);
  }, 15_000);

  test("keys the menu was too new to hear are pressed again", async () => {
    const { pane, out } = await fakeClaude("stop,wait,funds", 0, 1_500);
    await drawn(pane);
    expect(await answerLimitMenu(io(pane))).toBe("answered");
    expect(await told(out, 1)).toEqual([`chose: ${CLAUDE_LIMIT_STOP}`]);
  }, 15_000);

  test("a menu that never takes the keys is still asking, and nothing is chosen", async () => {
    const { pane, out } = await fakeClaude("stop,wait,funds", 0, 60_000);
    await drawn(pane);
    expect(await answerLimitMenu(io(pane), { waitMs: 1_500 })).toBe("still asking");
    expect(await told(out, 0)).toEqual([]);
  }, 15_000);

  test("two stopped sessions resumed end to end: the menu answered, Claude's \"continue\" typed over, one message each", async () => {
    const sessions = [await fakeClaude("stop,wait,funds", 0, 0, "continue"), await fakeClaude("stop,wait,funds", 1)];
    for (const { pane } of sessions) await drawn(pane);
    let clock = NIGHT;
    const rows: LimitSession[] = sessions.map(({ pane }, index) => ({
      sessionId: pane, label: `session ${index + 1}`, backend: "claude", pid: 1, status: "waiting", rotation: true, usageLimit: "weekly",
    }));
    const recovery = new LimitRecovery({
      enabled: () => true,
      sessions: () => rows,
      readScreen: (session) => screenOf(session.sessionId),
      inPane: async () => true,
      idleSeconds: async () => 0,
      pressKey: (session, key) => press(session.sessionId, key),
      alive: () => true,
      dashboard: async () => ({ source: "claude-swap", state: "ready", accounts: [account(1, 100), { ...account(3, 14), defaultLogin: true }] }),
      liveRunSlots: () => new Set(),
      switchTo: async () => { throw new Error("no switch: account 3 is in use and has room"); },
      typeBlocker: () => null,
      type: async (session, text) => await press(session.sessionId, "-l", text) && await press(session.sessionId, "Enter") || "send-keys failed",
      notify: () => {},
      log: () => {},
      now: () => clock,
    });
    recovery.noteSwitch(3, 1);
    clock += SWITCH_SETTLE_MS;
    await recovery.look();
    for (const { out } of sessions) {
      expect(await told(out, 2)).toEqual([`chose: ${CLAUDE_LIMIT_STOP}`, `said: ${resumeMessage(3, false)}`]);
    }
  }, 30_000);
});
