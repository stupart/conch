import { expect, test } from "bun:test";
import { openSessionApp } from "../src/session-app-open.ts";
import { applyRuntimeControlMessage, dispatchRuntimeControlMessage, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { isControlMessageCandidate, validateControlMessage, validateControlResponse } from "../src/settings.ts";

const id = "01a0ebc6-303d-7762-9df7-7406a1e1272b";
const session = { sessionId: id, backend: "codex", messageRoute: "codex-app" } as const;
const success = { text: "", stderr: "", exitCode: 0, timedOut: false };

test("opens the daemon's exact native chat, including a separately addressed window", async () => {
  const calls: string[][] = [];
  const open = async (argv: string[]) => { calls.push(argv); return success; };
  expect(await openSessionApp(id, session, open)).toEqual({ kind: "session-open-app", sessionId: id, opened: true });
  expect(await openSessionApp("window-id", { ...session, sessionId: "window-id", agentSessionId: id }, open))
    .toMatchObject({ sessionId: "window-id", opened: true });
  expect(calls).toEqual(Array(2).fill(["/usr/bin/open", `codex://threads/${id}`]));
});

test("unknown, stale, headless, terminal and subagent rows never run a command", async () => {
  let calls = 0;
  const open = async () => { calls++; return success; };
  const invalid = [undefined, { ...session, sessionId: "other" }, { ...session, messageRoute: undefined },
    { ...session, parentSessionId: "parent" }, { ...session, backend: "claude" as const },
    { ...session, agentSessionId: "https://example.com" }, { ...session, agentSessionId: `${id}?view=review` }];
  for (const row of invalid) expect(await openSessionApp(id, row, open)).toMatchObject({ opened: false, reason: expect.any(String) });
  expect(calls).toBe(0);
});

test("launch failure, timeout and exceptions are visible refusals", async () => {
  for (const result of [{ ...success, exitCode: 1 }, { ...success, timedOut: true }]) {
    expect(await openSessionApp(id, session, async () => result)).toMatchObject({ opened: false, reason: expect.any(String) });
  }
  expect(await openSessionApp(id, session, async () => { throw Error("spawn failed"); }))
    .toMatchObject({ opened: false, reason: expect.any(String) });
});

test("Mac socket and phone control boundary accept only a session id and validate replies", async () => {
  const request = { kind: "session-open-app", sessionId: id } as const;
  expect(isControlMessageCandidate(request)).toBe(true);
  expect(validateControlMessage({ ...request, url: "https://example.com", pid: 1 })).toEqual({ ok: true, value: request });
  expect(validateControlMessage({ ...request, sessionId: "" }).ok).toBe(false);
  const reply = { ...request, opened: true };
  expect(validateControlResponse(reply)).toEqual({ ok: true, value: reply });
  expect(validateControlResponse(request).ok).toBe(false);
  expect(validateControlResponse({ ...reply, opened: "yes" }).ok).toBe(false);
  expect(validateControlResponse({ ...reply, reason: 1 }).ok).toBe(false);
  const calls: unknown[] = [];
  const options = { openSessionApp: async (message: typeof request) => { calls.push(message); return reply; } } as RuntimeControlDispatchOptions;
  expect(await applyRuntimeControlMessage(request, options)).toEqual(reply);
  await dispatchRuntimeControlMessage(request, options);
  expect(calls).toEqual([request, request]);
  expect(await applyRuntimeControlMessage(request, {} as RuntimeControlDispatchOptions))
    .toMatchObject({ opened: false, reason: expect.any(String) });
});
