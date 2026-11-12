import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePushRegistration, PushDevices, PUSH_DEVICES_MAX, tokenTail, type PushRegistration } from "../src/push-devices.ts";

// The phones conch pushes to (push-devices.ts): each one's device token as its app sends it, kept by install id.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-push-devices-"));
  roots.push(root);
  return join(root, "push-devices.json");
}

const registration = (overrides: Partial<PushRegistration> = {}): PushRegistration => ({
  install: "11111111-2222-3333-4444-555555555555",
  device: "iPhone",
  token: "ab".repeat(32),
  environment: "production",
  topic: "com.example.conch.ios",
  alerts: true,
  ...overrides,
});

describe("a phone's registration", () => {
  test("taken when every field is its own shape; the token lower-cased", () => {
    expect(decodePushRegistration({ kind: "push-token", ...registration(), token: "AB".repeat(32) }))
      .toEqual({ ok: true, value: registration() });
  });

  test("refused for anything else", () => {
    const bad: Array<Partial<Record<keyof PushRegistration | "kind", unknown>>> = [
      { install: "short" },
      { install: "../../etc" },
      { device: "" },
      { device: "two\nlines" },
      { device: "x".repeat(65) },
      { token: "not hex".repeat(10) },
      { token: "ab".repeat(10) },
      { environment: "staging" },
      { topic: "nodots" },
      { topic: "com.example/../x" },
      { alerts: "yes" },
      { kind: "push-setup" },
    ];
    for (const change of bad) {
      expect(decodePushRegistration({ ...registration(), ...change }).ok, JSON.stringify(change)).toBe(false);
    }
    expect(decodePushRegistration(null).ok).toBe(false);
    expect(decodePushRegistration([registration()]).ok).toBe(false);
  });
});

describe("the list", () => {
  test("kept by install (0600, newest first); the same registration again changes nothing", () => {
    const file = scratch();
    const devices = new PushDevices(file);
    expect(devices.register(registration(), 1)).toBe(true);
    expect(devices.register(registration(), 2)).toBe(false);
    expect(devices.register(registration({ install: "22222222-2222-3333-4444-555555555555", token: "cd".repeat(32), device: "Work iPhone" }), 3)).toBe(true);
    expect(devices.list().map((one) => one.device)).toEqual(["Work iPhone", "iPhone"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A daemon restart reads it back.
    expect(new PushDevices(file).list()).toEqual(devices.list());
  });

  test("a new token for an install replaces its old one and what Apple said of it; a token another install held leaves it", () => {
    const devices = new PushDevices(scratch());
    devices.register(registration(), 1);
    devices.update(registration().install, { sentAt: 5, error: "BadDeviceToken" });
    devices.register(registration({ token: "ef".repeat(32) }), 6);
    expect(devices.list()).toEqual([{ ...registration({ token: "ef".repeat(32) }), registeredAt: 6 }]);
    // Reinstalled: a new install id, and iOS kept the token.
    devices.register(registration({ install: "33333333-2222-3333-4444-555555555555", token: "ef".repeat(32) }), 7);
    expect(devices.list().map((one) => one.install)).toEqual(["33333333-2222-3333-4444-555555555555"]);
  });

  test("forgetting an install, and at most eight phones", () => {
    const file = scratch();
    const devices = new PushDevices(file);
    for (let index = 0; index < PUSH_DEVICES_MAX + 2; index++) {
      devices.register(registration({ install: `install-${String(index).padStart(4, "0")}`, token: index.toString(16).padStart(2, "0").repeat(32) }), index);
    }
    expect(devices.list()).toHaveLength(PUSH_DEVICES_MAX);
    expect(devices.list()[0]!.install).toBe("install-0009");
    expect(devices.forget("install-0009")?.install).toBe("install-0009");
    expect(devices.forget("install-0009")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).devices).toHaveLength(PUSH_DEVICES_MAX - 1);
  });

  test("a token is shown by its tail", () => {
    expect(tokenTail("ab".repeat(31) + "c0ffee")).toBe("…c0ffee");
  });
});
