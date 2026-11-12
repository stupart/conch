import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhoneBridgeApplication, type PhonePushHooks } from "../src/phone-bridge.ts";
import type { PushRegistration } from "../src/push-devices.ts";

// The phone's half of push (notify-user.ts, 2026-11-10): whether this Mac can push (`/push`), and its device token once
// its notifications are on (`/push-token`), on the LAN bridge. The relay drives the same handler (phone-relay.test.ts).

const TOKEN = "t0ken-t0ken-t0ken-t0ken-t0ken";
const INSTALL = "11111111-2222-3333-4444-555555555555";
const registration: PushRegistration = {
  install: INSTALL, device: "iPhone", token: "ab".repeat(32), environment: "development", topic: "com.example.conch.ios", alerts: true,
};

function bridge(push?: PhonePushHooks) {
  return createPhoneBridgeApplication({
    getState: () => ({ v: 1, rows: [] }),
    forwardControl: async () => { throw new Error("push never goes to the control socket"); },
    replyFor: async () => "",
    acceptUpload: async () => ({ error: "no" }),
    log: () => {},
    ...(push ? { push } : {}),
  }, { token: TOKEN });
}

const request = (path: string, init: { method?: string; body?: unknown; authorized?: boolean } = {}) => new Request(`https://conch.invalid${path}`, {
  method: init.method ?? "GET",
  headers: { ...(init.authorized === false ? {} : { authorization: `Bearer ${TOKEN}` }), "content-type": "application/json" },
  ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
});

describe("/push and /push-token", () => {
  test("an older Mac (no hooks) doesn't know them, so the phone offers nothing", async () => {
    const app = bridge();
    expect((await app.handle(request(`/push?install=${INSTALL}`))!).status).toBe(404);
    expect((await app.handle(request("/push-token", { method: "POST", body: registration }))!).status).toBe(404);
  });

  test("whether this Mac can push and has this phone, for the paired phone only", async () => {
    const asked: Array<string | null> = [];
    const app = bridge({ status: (install) => { asked.push(install); return { ready: true, registered: install === INSTALL }; }, register: () => ({ ready: true }) });
    expect((await app.handle(request("/push", { authorized: false }))!).status).toBe(401);
    expect(await (await app.handle(request(`/push?install=${INSTALL}`))!).json()).toEqual({ kind: "push-state", ready: true, registered: true });
    expect(await (await app.handle(request("/push?install=../x"))!).json()).toEqual({ kind: "push-state", ready: true, registered: false });
    expect(asked).toEqual([INSTALL, null]);
  });

  test("a registration is checked before the hooks see it; too large is 413", async () => {
    const seen: PushRegistration[] = [];
    const app = bridge({ status: () => ({ ready: false, registered: false }), register: (one) => { seen.push(one); return { ready: false }; } });
    expect((await app.handle(request("/push-token", { method: "POST", body: registration, authorized: false }))!).status).toBe(401);
    const bad = await app.handle(request("/push-token", { method: "POST", body: { ...registration, environment: "staging" } }))!;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ kind: "push-token-error", error: "environment must be development or production" });
    expect((await app.handle(request("/push-token", { method: "POST", body: "{" }))!).status).toBe(400);
    expect((await app.handle(request("/push-token", { method: "POST", body: { ...registration, device: "x".repeat(4_000) } }))!).status).toBe(413);
    const ok = await app.handle(request("/push-token", { method: "POST", body: registration }))!;
    expect(await ok.json()).toEqual({ kind: "push-token-ack", ready: false });
    expect(seen).toEqual([registration]);
  });

  test("the daemon wires them, and logs a token by its tail only", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    const wiring = daemon.slice(daemon.indexOf("push: {"), daemon.indexOf("requestPreview: createPreviewRequester"));
    expect(wiring).toContain("pushDevices.register(registration)");
    expect(wiring).toContain("tokenTail(registration.token)");
    expect(wiring).not.toMatch(/\$\{registration\.token\}/);
  });
});
