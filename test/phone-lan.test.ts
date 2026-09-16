import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createConfigController, phoneLanWanted, retainMatchingPhoneBridge } from "../src/daemon.ts";
import { createPhoneBridge, type PhoneBridgeHandle } from "../src/phone-bridge.ts";
import { parseSetting, validateControlResponse, writeSetting } from "../src/settings.ts";

/**
 * Daemon review finding 20: turning on the encrypted relay also left the
 * plaintext LAN server listening on 0.0.0.0. `phone-lan` decides that
 * independently — auto (closed once a relay is configured), on, off.
 *
 * The listener half is executed against a real Bun server; the daemon wiring
 * that `runDaemon` alone can reach is pinned as source, the way
 * daemon-config.test.ts does.
 */
const daemonSource = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

/** Both markers must exist: a missing one slices from -1 and a guard passes vacuously. */
function sliceOf(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`missing marker: ${start}`);
  const until = source.indexOf(end, at);
  if (until < 0) throw new Error(`missing marker: ${end}`);
  return source.slice(at, until);
}

const roots: string[] = [];
const bridges: Array<PhoneBridgeHandle | null> = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge?.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Enough of the daemon's side for the routes to answer; nothing here is reached. */
function bridgeDependencies() {
  return {
    getState: () => ({ kind: "sessions", ts: 1, sessions: [] }),
    forwardControl: async () => JSON.stringify({ kind: "ack" }),
    replyFor: async () => "",
    acceptUpload: async () => ({ error: "no uploads in this test" }),
    log: () => {},
  };
}

/** Loopback, not 0.0.0.0: this asserts the lifecycle, not the bind address. */
function listen(port = 0): PhoneBridgeHandle {
  const bridge = createPhoneBridge(bridgeDependencies(), {
    port,
    token: "0".repeat(32),
    hostname: "127.0.0.1",
  });
  bridges.push(bridge);
  return bridge;
}

async function answers(port: number): Promise<number | "refused"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/state`);
    return response.status;
  } catch {
    return "refused";
  }
}

function settingsFile(values: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "conch-phone-lan-test-"));
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify(values));
  return path;
}

describe("phone-lan decides the plaintext LAN bridge on its own", () => {
  test("auto listens only while no relay is configured", () => {
    expect(phoneLanWanted(true, "auto", "")).toBe(true);
    expect(phoneLanWanted(true, "auto", "   ")).toBe(true);
    // The finding: a relay is configured, so the plaintext port closes.
    expect(phoneLanWanted(true, "auto", "https://conch-relay.example.workers.dev")).toBe(false);
  });

  test("on always listens and off never does, relay or no relay", () => {
    expect(phoneLanWanted(true, "on", "")).toBe(true);
    expect(phoneLanWanted(true, "on", "https://conch-relay.example.workers.dev")).toBe(true);
    expect(phoneLanWanted(true, "off", "")).toBe(false);
    expect(phoneLanWanted(true, "off", "https://conch-relay.example.workers.dev")).toBe(false);
  });

  test("phone off closes the bridge whatever phone-lan says", () => {
    for (const mode of ["auto", "on", "off"] as const) {
      expect(phoneLanWanted(false, mode, "")).toBe(false);
      expect(phoneLanWanted(false, mode, "https://conch-relay.example.workers.dev")).toBe(false);
    }
  });

  test("the default is auto, and only the three values parse", () => {
    const fallback = loadConfig({ env: {}, settingsPath: settingsFile({}) });
    expect(fallback.phoneLan).toBe("auto");
    expect(parseSetting("phone-lan", " ON ")).toMatchObject({ ok: true, value: { value: "on" } });
    expect(parseSetting("phone-lan", "yes").ok).toBe(false);
    expect(parseSetting("phone-lan", true).ok).toBe(false);
  });
});

describe("the setting applies live to a real listener", () => {
  test("a relay arriving under auto stops the listener; on starts one again", async () => {
    let bridge: PhoneBridgeHandle | null = listen();
    const port = bridge.port;
    expect(port).toBeGreaterThan(0);
    // 401, not 404: it is listening AND still refusing an unauthenticated read.
    expect(await answers(port)).toBe(401);

    // What syncPhoneBridge does when `phone-relay-url` is set under auto.
    bridge = retainMatchingPhoneBridge(
      bridge,
      phoneLanWanted(true, "auto", "https://conch-relay.example.workers.dev"),
      port,
    );
    expect(bridge).toBeNull();
    expect(await answers(port)).toBe("refused");

    // ...and `conch set phone-lan on` brings a listener back.
    expect(phoneLanWanted(true, "on", "https://conch-relay.example.workers.dev")).toBe(true);
    const reopened = listen();
    expect(await answers(reopened.port)).toBe(401);
  });

  test("a live phone-lan change reaches the daemon's config and fires onLiveChange", () => {
    const path = settingsFile({ phone: true, "phone-relay-url": "https://conch-relay.example.workers.dev" });
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    expect(cfg.phoneLan).toBe("auto");
    expect(phoneLanWanted(cfg.phoneEnabled, cfg.phoneLan, cfg.phoneRelayURL)).toBe(false);

    const changes: Array<{ key: string; value: unknown }> = [];
    const controller = createConfigController(cfg, {
      env,
      settingsPath: path,
      onLiveChange: (key, value) => changes.push({ key, value }),
    });
    writeSetting(path, "phone-lan", "on");
    const reply = controller.handle({ kind: "set-config", key: "phone-lan", value: "on" });

    expect(cfg.phoneLan).toBe("on");
    expect(changes).toEqual([{ key: "phone-lan", value: "on" }]);
    expect(reply).toMatchObject({ kind: "config-ack", key: "phone-lan", status: "applied", effective: "on" });
    // The config the daemon closes over now wants a listener again.
    expect(phoneLanWanted(cfg.phoneEnabled, cfg.phoneLan, cfg.phoneRelayURL)).toBe(true);
  });

  test("the daemon re-syncs its transports when phone-lan changes", () => {
    const wiring = sliceOf(
      daemonSource,
      "const configController = createConfigController",
      "const enrichSocketAudioCommand",
    );
    expect(wiring).toContain('key === "phone-lan"');
    expect(sliceOf(wiring, 'key === "phone-lan"', "\n")).toContain("syncPhoneBridge()");
  });
});

describe("the daemon says which transports are live", () => {
  test("the sync decides the LAN bridge with phone-lan before creating one", () => {
    const apply = sliceOf(daemonSource, "function applyPhoneTransports(): void {", "Notice that this Mac was asleep");
    expect(apply).toContain("phoneLanWanted(wanted, cfg.phoneLan, relayEndpoint)");
    expect(apply).toContain("retainMatchingPhoneBridge(phoneBridge, lanWanted, cfg.phonePort)");
    expect(apply).toContain("if (!phoneBridge && lanWanted) {");
  });

  test("the startup line names the live transports, including relay-only", () => {
    const report = sliceOf(daemonSource, "function logPhoneTransports(): void {", "function syncPhoneBridge()");
    expect(report).toContain("phone bridge listening on 0.0.0.0:");
    expect(report).toContain("relay only (encrypted) — LAN closed by phone-lan=");
    expect(report).toContain("nothing listening — phone-lan=");
    expect(report).toContain("log(`phone: ${summary}`)");
  });
});

describe("pairing still works when the LAN bridge is closed", () => {
  test("the window opens on the shared application and reports whether LAN listens", () => {
    const pairing = sliceOf(daemonSource, 'if (message.kind === "open-pairing")', "const exhaustive: never = message;");
    // Guarding on the bridge would refuse to open a window — and hide the
    // relay QR — on a relay-only daemon.
    expect(pairing).toContain("if (!phoneApplication) {");
    expect(pairing).toContain("phoneApplication.offerPairingCode(code)");
    expect(pairing).toContain("lan: phoneBridge !== null");
    expect(pairing).toContain("port: phoneBridge?.port ?? cfg.phonePort");
  });

  test("`conch pair` prints the remedy instead of a host nothing answers on", () => {
    const pair = sliceOf(cliSource, 'case "pair": {', 'case "get": {');
    expect(pair).toContain("const lanClosed = window.lan === false;");
    expect(pair).toContain("conch set phone-lan on");
    // The relay QR is still printed when the LAN bridge is shut.
    expect(pair.indexOf("lanClosed")).toBeLessThan(pair.indexOf("relayPairingCode"));
  });

  test("a pairing reply carries the lan flag, and an older daemon's reply means listening", () => {
    const base = { kind: "pairing-open", code: "123456", expiresAt: Date.now() + 120_000, port: 8674 };
    expect(validateControlResponse({ ...base, lan: false })).toMatchObject({ ok: true, value: { lan: false } });
    expect(validateControlResponse(base)).toMatchObject({ ok: true, value: { lan: true } });
    expect(validateControlResponse({ ...base, lan: "no" }).ok).toBe(false);
  });
});
