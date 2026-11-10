import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApnsEnvironment } from "./apns.ts";
import { conchHome } from "./home.ts";
import { PHONE_DEVICE_MAX_CHARS } from "./phone-setup.ts";

/**
 * The phones conch can push to (apns.ts): each one's APNs device token, as its app sends it over the paired bridge or
 * relay (`/push-token`, phone-bridge.ts) once you've turned its notifications on. Kept by the app's install id, as the
 * phone's setup is (phone-setup.ts): on iOS 16 and later every phone's name reads "iPhone", so a name can't tell two
 * apart, and a reinstall is a new install with a new token.
 *
 * A token is how Apple finds the app, not a credential anyone can push with: that takes the key (push-key.ts). It's
 * still nobody else's business, so the file is 0600, and the log and the Mac's Settings show only its last characters.
 */

export const PUSH_DEVICES_MAX = 8;
/** A `/push-token` body is a few hundred bytes. */
export const PUSH_REGISTRATION_MAX_BYTES = 2_048;
const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;
/** An APNs device token in hex: 32 bytes today, and Apple says it may grow, so up to 100. */
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
/** The app's bundle id, which is the push's topic. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){1,10}$/;

export interface PushRegistration {
  install: string;
  /** The phone's name, shown on the Mac and nothing else. */
  device: string;
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  /** Whether iOS will show conch's notices (the app's authorization). A phone that said no is listed, and nothing is pushed to it. */
  alerts: boolean;
}

export interface PushDevice extends PushRegistration {
  /** Epoch ms. */
  registeredAt: number;
  /** When a notice last went to Apple for it, and what Apple said last when it refused one. */
  lastSentAt?: number;
  lastError?: string;
}

export type PushRegistrationDecode = { ok: true; value: PushRegistration } | { ok: false; err: string };

/** The phone's registration, checked strictly: every field a short, plain value of its own shape. */
export function decodePushRegistration(value: unknown): PushRegistrationDecode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, err: "push-token must be an object" };
  const body = value as Record<string, unknown>;
  if (body.kind !== undefined && body.kind !== "push-token") return { ok: false, err: "kind must be push-token" };
  if (typeof body.install !== "string" || !INSTALL_ID.test(body.install)) return { ok: false, err: "install must be the app's install id" };
  if (typeof body.device !== "string") return { ok: false, err: "device must be a string" };
  const device = body.device.trim();
  if (!device || [...device].length > PHONE_DEVICE_MAX_CHARS || /[\u0000-\u001f\u007f\u2028\u2029]/.test(device)) {
    return { ok: false, err: "device must be the phone's name, on one line" };
  }
  const token = typeof body.token === "string" ? body.token.toLowerCase() : "";
  if (!DEVICE_TOKEN.test(token)) return { ok: false, err: "token must be the APNs device token, in hex" };
  if (body.environment !== "development" && body.environment !== "production") return { ok: false, err: "environment must be development or production" };
  if (typeof body.topic !== "string" || body.topic.length > 155 || !BUNDLE_ID.test(body.topic)) return { ok: false, err: "topic must be the app's bundle id" };
  if (typeof body.alerts !== "boolean") return { ok: false, err: "alerts must be true or false" };
  return { ok: true, value: { install: body.install, device, token, environment: body.environment, topic: body.topic, alerts: body.alerts } };
}

/** A token as the log and Settings show it: its last six characters. */
export const tokenTail = (token: string): string => `…${token.slice(-6)}`;

export function pushDevicesPath(home = conchHome()): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch"), "push-devices.json");
}

export class PushDevices {
  readonly #file: string;
  #devices: PushDevice[] = [];

  constructor(file = pushDevicesPath()) {
    this.#file = file;
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown };
      if (Array.isArray(stored.devices)) {
        for (const entry of stored.devices.slice(0, PUSH_DEVICES_MAX)) {
          const decoded = decodePushRegistration(entry);
          const at = (entry as { registeredAt?: unknown }).registeredAt;
          if (!decoded.ok || !Number.isSafeInteger(at)) continue;
          const { lastSentAt, lastError } = entry as { lastSentAt?: unknown; lastError?: unknown };
          this.#devices.push({
            ...decoded.value, registeredAt: at as number,
            ...(Number.isSafeInteger(lastSentAt) ? { lastSentAt: lastSentAt as number } : {}),
            ...(typeof lastError === "string" ? { lastError: lastError.slice(0, 300) } : {}),
          });
        }
      }
    } catch {}
  }

  list(): readonly PushDevice[] {
    return this.#devices;
  }

  /**
   * A phone's registration, newest first. The same install again replaces its record; a token another install held
   * (a reinstall that kept its token) leaves that install. True when anything changed, which a re-registration on
   * every connect usually doesn't.
   */
  register(registration: PushRegistration, now = Date.now()): boolean {
    const held = this.#devices.find((one) => one.install === registration.install);
    const same = held && held.token === registration.token && held.environment === registration.environment
      && held.topic === registration.topic && held.alerts === registration.alerts && held.device === registration.device;
    if (same) return false;
    const others = this.#devices.filter((one) => one.install !== registration.install && one.token !== registration.token);
    // A new token clears what Apple said of the old one.
    const kept = held && held.token === registration.token ? { ...(held.lastSentAt ? { lastSentAt: held.lastSentAt } : {}) } : {};
    this.#devices = [{ ...registration, registeredAt: now, ...kept }, ...others].slice(0, PUSH_DEVICES_MAX);
    this.#save();
    return true;
  }

  /** What became of a push to one install. */
  update(install: string, change: { sentAt?: number; error?: string | null; environment?: ApnsEnvironment }): void {
    const device = this.#devices.find((one) => one.install === install);
    if (!device) return;
    if (change.sentAt !== undefined) device.lastSentAt = change.sentAt;
    if (change.error === null) delete device.lastError;
    else if (change.error !== undefined) device.lastError = change.error.slice(0, 300);
    if (change.environment) device.environment = change.environment;
    this.#save();
  }

  /** An install whose token Apple says is dead: the app was deleted, or it registers again with a new one. */
  forget(install: string): PushDevice | undefined {
    const device = this.#devices.find((one) => one.install === install);
    if (!device) return undefined;
    this.#devices = this.#devices.filter((one) => one !== device);
    this.#save();
    return device;
  }

  #save(): void {
    try {
      if (!this.#devices.length) {
        if (existsSync(this.#file)) unlinkSync(this.#file);
        return;
      }
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ devices: this.#devices }, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {}
  }
}
