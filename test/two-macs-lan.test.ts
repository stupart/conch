import { describe, test, expect, afterEach } from "bun:test";
import { createPhoneBridge, createPhoneBridgeApplication, type PhoneBridgeHandle } from "../src/phone-bridge.ts";
import { AudioSinkLease } from "../src/daemon.ts";

const token = "observer-test-token".repeat(2);
const bridges: PhoneBridgeHandle[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const bridge of bridges.splice(0)) bridge.stop();
});
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture() {
  const counts: number[] = [];
  const lease = new AudioSinkLease();
  let fallbacks = 0;
  let revision = 1;
  const dependencies = {
    getState: () => ({ v: 1, ownerDeviceId: "owner-a", ts: revision, rows: [{ id: "same-key#123", detail: `turn ${revision}` }] }),
    forwardControl: async () => "", replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log: () => {},
    onClientsChanged(count: number) { counts.push(count); if (lease.clientsChanged(count)) fallbacks++; },
  };
  return { dependencies, counts, lease, fallbacks: () => fallbacks, advance: () => revision++ };
}

describe("A1 observer subscriptions", () => {
  test("LAN observer receives snapshots without presence; dropping the phone falls back with observer still alive", async () => {
    const f = fixture();
    const bridge = createPhoneBridge(f.dependencies, { port: 0, token, hostname: "127.0.0.1" });
    bridges.push(bridge);
    const observerFrames: string[] = [];
    const observer = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${token}&role=observer`);
    sockets.push(observer);
    observer.onmessage = (event) => observerFrames.push(String(event.data));
    await until(() => observerFrames.length === 1);
    expect(JSON.parse(observerFrames[0]!)).toMatchObject({ ownerDeviceId: "owner-a", rows: [{ id: "same-key#123" }] });
    expect(bridge.clientCount()).toBe(0);
    expect(f.counts).toEqual([]);
    expect(f.lease.request("phone", bridge.clientCount())).toBe("mac");
    f.advance(); bridge.publish();
    await until(() => observerFrames.length === 2);
    expect(JSON.parse(observerFrames[1]!).rows[0].detail).toBe("turn 2");

    // Missing role is the existing phone contract, not a new required parameter.
    const phone = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws?token=${token}`);
    sockets.push(phone);
    await until(() => bridge.clientCount() === 1);
    expect(f.counts).toEqual([1]);
    expect(f.lease.request("phone", bridge.clientCount())).toBe("phone");
    phone.close();
    await until(() => bridge.clientCount() === 0);
    expect(f.counts).toEqual([1, 0]);
    expect(f.fallbacks()).toBe(1);
    expect(f.lease.sink).toBe("mac");
    f.advance(); bridge.publish();
    await until(() => observerFrames.length === 3);
    expect(JSON.parse(observerFrames[2]!).rows[0].detail).toBe("turn 3");
    observer.close();
    await until(() => observer.readyState === WebSocket.CLOSED);
    expect(f.counts).toEqual([1, 0]);
  });

  test("shared hub excludes observers on failed writes and explicit phone role keeps presence", () => {
    const f = fixture();
    const app = createPhoneBridgeApplication(f.dependencies, { token });
    let observerAlive = true;
    let phoneAlive = true;
    const observerFrames: string[] = [];
    const observer = { send(frame: string) { observerFrames.push(frame); return observerAlive ? 1 : 0; } };
    const phone = { send: () => phoneAlive ? 1 : 0 };
    for (const [role, sink] of [["observer", observer], ["phone", phone]] as const) {
      const result = app.handle(new Request(`http://bridge/ws?role=${role}`, { headers: { authorization: `Bearer ${token}` } }), {
        upgradeState(_req, subscribe) { subscribe(sink); return true; },
      });
      expect(result).toBeUndefined();
    }
    expect(f.counts).toEqual([1]);
    expect(app.clientCount()).toBe(1);
    f.lease.request("phone", app.clientCount());
    phoneAlive = false;
    f.advance(); app.publish();
    expect(app.clientCount()).toBe(0);
    expect(f.fallbacks()).toBe(1);
    expect(f.lease.sink).toBe("mac");
    expect(observerFrames).toHaveLength(2);
    observerAlive = false;
    f.advance(); app.publish();
    expect(f.counts).toEqual([1, 0]);
    app.unsubscribeState(observer);
    expect(f.counts).toEqual([1, 0]);
  });

  test("joining observers cannot consume a pending publish to existing subscribers", () => {
    const f = fixture();
    const app = createPhoneBridgeApplication(f.dependencies, { token });
    const phoneFrames: string[] = [];
    const observerFrames: string[] = [];
    app.subscribeState({ send(frame) { phoneFrames.push(frame); return 1; } });
    f.advance();
    app.subscribeState({ send(frame) { observerFrames.push(frame); return 1; } }, "observer");
    app.publish();
    expect(phoneFrames.map(frame => JSON.parse(frame).rows[0].detail)).toEqual(["turn 1", "turn 2"]);
    expect(JSON.parse(observerFrames[0]!).rows[0].detail).toBe("turn 2");
    expect(app.clientCount()).toBe(1);
  });

  test("authenticated state advertises observer support; unknown roles cannot become phones", async () => {
    const app = createPhoneBridgeApplication(fixture().dependencies, { token });
    const response = await app.handle(new Request("http://bridge/state", { headers: { authorization: `Bearer ${token}` } }));
    expect(response?.headers.get("X-Conch-Observer")).toBe("1");
    let upgraded = false;
    const unknown = await app.handle(new Request("http://bridge/ws?role=typo", { headers: { authorization: `Bearer ${token}` } }), {
      upgradeState() { upgraded = true; return true; },
    });
    expect(unknown?.status).toBe(400);
    expect(upgraded).toBe(false);
    const unauthorized = await app.handle(new Request("http://bridge/ws?role=observer"), {
      upgradeState() { upgraded = true; return true; },
    });
    expect(unauthorized?.status).toBe(401);
    expect(upgraded).toBe(false);
  });
});
