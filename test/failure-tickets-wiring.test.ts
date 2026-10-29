import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { APP_ERRORS_PATH } from "../src/app-errors.ts";
import { createControlServer, type ControlApplication, type ControlServer } from "../src/control-server.ts";
import type { FailureTicketList } from "../src/failure-tickets.ts";
import { deliverToDaemon, handOff, type TurnEvent } from "../src/hook.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";

// Where the failure loop meets the rest of conch (docs/failure-tickets.md): the daemon's catches that file what used to
// be one log line, the socket's routes, the hook's own record, and the fix session's first message.

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

describe("the daemon files what used to be only a log line", () => {
  const daemon = source("src/daemon.ts");

  /**
   * 2026-10-28: an Allow Tyler tapped threw `Account profiles must have separate directories` inside the inject's
   * handling, and the only trace was `error handling inject "…": Error: …` in /tmp/conch-daemon.log. Both of the
   * daemon's catches for a handled event now file it, under the event's own type.
   */
  test("an event that throws, queued or immediate, is filed as well as logged", () => {
    const queued = daemon.slice(daemon.indexOf("onError: (event, error) => {"), daemon.indexOf("onIdle:"));
    expect(queued).toContain("log(`error handling ${event.type} \"${event.label}\": ${error}`);");
    expect(queued).toContain("fileThrownEvent(event, error);");
    const immediate = daemon.slice(daemon.indexOf("return handle(event).catch((error) => {"));
    expect(immediate.slice(0, 300)).toContain("fileThrownEvent(event, error);");
    const filing = daemon.slice(daemon.indexOf("log(`error filing a publication from"));
    expect(filing.slice(0, 200)).toContain("fileThrownEvent(event, error, \"review-filing\");");
    // And it reaches the daemon's own recorder, once there is one.
    expect(daemon).toContain("fileDaemonFailure = recordDaemonError;");
  });

  test("the desk is built on the daemon's own session start: background, Claude, the Default account, the brief first", () => {
    const desk = daemon.slice(daemon.indexOf("const failureDesk = new FailureDesk({"), daemon.indexOf("failureDesk.start("));
    expect(desk).toContain("await launchSession({");
    expect(desk).toContain(`backend: "claude", host: "background", cwd, claudeAccountId: "default", initialPrompt: prompt,`);
    expect(desk).toContain("autoFix: () => cfg.failureAutofix,");
    expect(desk).toContain("errorsPath: APP_ERRORS_PATH,");
    expect(desk).toContain("mcpUsagePath: mcpUsagePath(),");
    // Every record the daemon writes, its own and the apps', is filed at once rather than at the next poll.
    expect(daemon.match(/fileRecordedFailures\(\);/g)?.length).toBe(2);
    const wiring = daemon.slice(daemon.indexOf("const controlServer = createControlServer({"));
    expect(wiring.slice(0, 4_000)).toContain("failureTickets: failureDesk,");
    expect(wiring.slice(0, 4_000)).toContain("onFailure: recordDaemonError,");
    expect(daemon).toContain("lastPublishedPanelState.failures = failureDesk.digest();");
    expect(daemon).toContain("failureDesk.stop();");
  });
});

describe("a fix session's first message", () => {
  test("is the last argument of a new Claude conversation, quoted whole", () => {
    const brief = "Fix conch failure ticket #3.\n\nIt's the user's 'words' $(not run)";
    expect(terminalSessionCommand({ backend: "claude", host: "background", cwd: "/work/conch", initialPrompt: brief }))
      .toBe(`cd -- '/work/conch' && exec claude 'Fix conch failure ticket #3.\n\nIt'\\''s the user'\\''s '\\''words'\\'' $(not run)'`);
  });

  test("is never given to a resumed conversation, and never comes from a client", () => {
    expect(() => terminalSessionCommand({ backend: "claude", resumeSessionId: "abc", cwd: "/w", initialPrompt: "x" })).toThrow("only given to a new conversation");
    expect(() => terminalSessionCommand({ backend: "claude", teleportSessionId: "session_01", cwd: "/w", initialPrompt: "x" })).toThrow();
    const wire = validateRuntimeControlMessage({ kind: "session-start", backend: "claude", cwd: "/w", initialPrompt: "rm -rf" });
    expect(wire).toEqual({ ok: true, value: { kind: "session-start", backend: "claude", cwd: "/w" } });
  });
});

describe("the hook files a hand-off a live socket didn't take", () => {
  const event: TurnEvent = { type: "turn-end", sessionId: "s-hook", label: "A session", announce: "done" };
  const lines = () => existsSync(APP_ERRORS_PATH) ? readFileSync(APP_ERRORS_PATH, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

  test("refused or too slow is filed as the hook's; no socket at all is conch switched off, and files nothing", async () => {
    const before = lines().length;
    expect(await handOff("/nowhere", event, async () => "absent")).toBe(false);
    expect(lines()).toHaveLength(before);
    expect(await handOff("/nowhere", event, async () => "refused")).toBe(false);
    expect(await handOff("/nowhere", event, async () => "timeout")).toBe(false);
    const filed = lines().slice(before);
    expect(filed.map((record) => [record.source, record.operation, record.sessionId, record.state.event])).toEqual([
      ["hook", "hook", "s-hook", "turn-end"],
      ["hook", "hook", "s-hook", "turn-end"],
    ]);
    expect(filed[0].message).toContain("refused");
    expect(filed[1].message).toContain("500 ms");
    expect(await handOff("/nowhere", event, async () => true)).toBe(true);
  });

  test("a socket path with nothing there is absent; a file nobody listens on is refused", async () => {
    const dir = mkdtempSync("/tmp/conch-hook-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(await deliverToDaemon(join(dir, "none.sock"), event)).toBe("absent");
    // A daemon killed outright leaves its socket behind with nobody listening: connecting to that is refused.
    const stale = join(dir, "stale.sock");
    const daemon = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(stale)}, socket: { data() {} } }); setInterval(() => {}, 1000)`], { stdout: "ignore", stderr: "ignore" });
    for (let waited = 0; !existsSync(stale) && waited < 5_000; waited += 50) await Bun.sleep(50);
    daemon.kill("SIGKILL");
    await daemon.exited;
    expect(existsSync(stale)).toBe(true);
    expect(await deliverToDaemon(stale, event)).toBe("refused");
    // Something at the path that isn't a socket at all isn't a daemon either.
    writeFileSync(join(dir, "plain"), "");
    expect(await deliverToDaemon(join(dir, "plain"), event)).toBe("absent");
  });
});

describe("the socket", () => {
  async function server(onFailure: (...args: unknown[]) => void, published = true) {
    const dir = mkdtempSync("/tmp/conch-tickets-");
    const socketPath = join(dir, "c.sock");
    const list: FailureTicketList = { kind: "failure-tickets", tickets: [], autoFix: { on: false, today: 0, cap: 3 }, fix: { available: true, folder: "/c" } };
    const acted: Array<[string, string]> = [];
    const application: ControlApplication = {
      configuration: () => ({ kind: "config-error", error: "stub" }),
      session: () => ({ kind: "session-error", error: "stub" }),
      runtime: () => ({ kind: "app-error-ack" }),
      turn: () => {},
      device: () => ({ kind: "ack" }),
    };
    const control: ControlServer = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      application,
      sessions: { resolve: (value) => value, current: () => published ? { published: true, label: "x" } : { published: false } },
      failureTickets: {
        list: () => list,
        act: async (id, action) => { acted.push([id, action]); return { kind: "failure-ticket-ack" }; },
      },
      onFailure,
    });
    expect(await control.start()).toBe(true);
    cleanups.push(async () => { await control.close(); rmSync(dir, { recursive: true, force: true }); });
    const ask = (body: unknown) => new Promise<string>((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write(`${JSON.stringify(body)}\n`));
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    return { ask, acted, list };
  }

  test("answers Settings › Failures' list and its actions", async () => {
    const { ask, acted, list } = await server(() => {});
    expect(JSON.parse(await ask({ kind: "failure-tickets" }))).toEqual(list);
    expect(JSON.parse(await ask({ kind: "failure-ticket", id: "0123456789ab", action: "ignore" }))).toEqual({ kind: "failure-ticket-ack" });
    expect(acted).toEqual([["0123456789ab", "ignore"]]);
    expect(JSON.parse(await ask({ kind: "failure-ticket", id: "nope", action: "ignore" }))).toEqual({ kind: "failure-ticket-error", error: "a ticket id is 12 hex characters, or all" });
  });

  test("files an inject it refuses before delivery, which the Mac app never shows", async () => {
    const filed: unknown[][] = [];
    const { ask } = await server((...args) => filed.push(args), false);
    const reply = JSON.parse(await ask({ type: "inject", sessionId: "gone-session", label: "Old work", announce: "the words" }));
    expect(reply.kind).toBe("session-error");
    expect(filed).toEqual([["inject", "Refused before delivery: inject target is not a live published session", "gone-session", { label: "Old work", refused: true }]]);
    // The words themselves are never in the record.
    expect(JSON.stringify(filed)).not.toContain("the words");
  });
});
