import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { breadcrumb } from "./loop-watchdog.ts";

/**
 * The iPhone's first-run setup, as the Mac follows it.
 *
 * The phone reports each stage of its own setup as it reaches it (`setup-stage`, over the same encrypted relay and
 * LAN routes as everything else it sends), and the transports say when a key exchange is under way and when one
 * completes. This keeps the furthest stage per device, on disk so a daemon restart keeps it, and publishes the
 * Mac's view of it as `phone` on the published state, which the Mac's setup window mirrors:
 *
 *   phone = { enabled, paired, device, setup: { stage, declined } }
 *
 * Nothing secret goes in it or on its disk: no token, no relay secret, no room, no code. Only the phone's own name
 * and how far it got.
 */

/** ConchDesign's `PhoneSetupStage`, in its order: a stage is further on than every stage before it. */
export const PHONE_SETUP_STAGES = ["waiting", "connecting", "paired", "notifications", "microphone", "tour", "finished"] as const;
export type PhoneSetupStage = (typeof PHONE_SETUP_STAGES)[number];

/** What a phone may report. `waiting` and `connecting` are the Mac's own: a phone that can report has got past both. */
export const PHONE_REPORTED_STAGES: readonly PhoneSetupStage[] = ["paired", "notifications", "microphone", "tour", "finished"];
/** What a phone may say no to on the way: the permissions it asks for. */
export const PHONE_DECLINABLE_STAGES: readonly PhoneSetupStage[] = ["notifications", "microphone"];
/** A phone's name as the Mac shows it ("Tyler's iPhone"). Longer is refused, which also keeps the publish small. */
export const PHONE_DEVICE_MAX_CHARS = 64;
/** The phones remembered, newest first; an older one past this is forgotten. */
export const PHONE_SETUP_MAX_DEVICES = 8;
/** A `setup-stage` body is a few dozen bytes; anything past this is not one. */
export const PHONE_SETUP_BODY_MAX_BYTES = 1024;

export interface PublishedPhone {
  /** The `phone` setting. */
  enabled: boolean;
  /** A phone has completed the key exchange with this Mac, at least once. */
  paired: boolean;
  /** The phone whose setup `setup` describes, once one has said its name. */
  device: string | null;
  setup: { stage: PhoneSetupStage; declined: PhoneSetupStage[] };
}

export interface SetupStageReport {
  stage: PhoneSetupStage;
  declined: PhoneSetupStage[];
  device: string;
}

export type SetupStageDecode = { ok: true; value: SetupStageReport } | { ok: false; err: string };

export type KeyExchangeEvent = "started" | "completed" | "abandoned";

export interface SetupStageAnswer {
  /** The furthest stage this device has reached, after this report. */
  stage: PhoneSetupStage;
  /** The report moved it on. False is a repeat or a late report, which never undoes a stage. */
  moved: boolean;
}

const rank = (stage: PhoneSetupStage): number => PHONE_SETUP_STAGES.indexOf(stage);
const isStage = (value: unknown): value is PhoneSetupStage =>
  typeof value === "string" && (PHONE_SETUP_STAGES as readonly string[]).includes(value);
const canonical = (stages: Iterable<PhoneSetupStage>): PhoneSetupStage[] =>
  PHONE_SETUP_STAGES.filter((stage) => [...stages].includes(stage));

/**
 * A phone's report, checked strictly: the stage is one of the enum's and one a phone may say, each refusal is a
 * permission the phone asks for and has reached, and the name is a short line of text.
 */
export function decodeSetupStage(value: unknown): SetupStageDecode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, err: "setup-stage must be an object" };
  const body = value as Record<string, unknown>;
  if (body.kind !== undefined && body.kind !== "setup-stage") return { ok: false, err: "kind must be setup-stage" };
  if (!isStage(body.stage)) return { ok: false, err: `stage must be one of ${PHONE_SETUP_STAGES.join(", ")}` };
  const stage = body.stage;
  if (!PHONE_REPORTED_STAGES.includes(stage)) return { ok: false, err: `${stage} is the Mac's to say, not the phone's` };
  if (!Array.isArray(body.declined)) return { ok: false, err: "declined must be an array" };
  if (body.declined.length > PHONE_DECLINABLE_STAGES.length) return { ok: false, err: "declined has too many entries" };
  const declined = new Set<PhoneSetupStage>();
  for (const entry of body.declined) {
    if (!isStage(entry) || !PHONE_DECLINABLE_STAGES.includes(entry)) {
      return { ok: false, err: `declined may only name ${PHONE_DECLINABLE_STAGES.join(" or ")}` };
    }
    if (declined.has(entry)) return { ok: false, err: `declined names ${entry} twice` };
    // Said no to before it was asked: not something a phone following the flow can report.
    if (rank(entry) > rank(stage)) return { ok: false, err: `declined ${entry} before reaching it` };
    declined.add(entry);
  }
  if (typeof body.device !== "string") return { ok: false, err: "device must be a string" };
  const device = body.device.trim();
  if (!device) return { ok: false, err: "device must name the phone" };
  if ([...device].length > PHONE_DEVICE_MAX_CHARS) return { ok: false, err: `device must be at most ${PHONE_DEVICE_MAX_CHARS} characters` };
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(device)) return { ok: false, err: "device must be one line of text" };
  return { ok: true, value: { stage, declined: canonical(declined), device } };
}

export function phoneSetupPath(home: string = conchHome()): string {
  return join(home, ".config", "conch", "phone-setup.json");
}

interface DeviceSetup {
  stage: PhoneSetupStage;
  declined: PhoneSetupStage[];
  at: number;
}

interface PhoneSetupFile {
  version: 1;
  paired: boolean;
  /** The device whose report last moved on: the one `phone.device` names. */
  device: string | null;
  devices: Record<string, DeviceSetup>;
}

const EMPTY: PhoneSetupFile = { version: 1, paired: false, device: null, devices: {} };

/** A file from an earlier run, taken only as far as it is sound. Anything else starts afresh. */
function readSetupFile(path: string): PhoneSetupFile {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PhoneSetupFile>;
  if (raw?.version !== 1 || typeof raw.paired !== "boolean" || !raw.devices || typeof raw.devices !== "object") {
    throw new Error("unrecognised phone setup file");
  }
  const devices: Record<string, DeviceSetup> = {};
  for (const [name, entry] of Object.entries(raw.devices)) {
    const decoded = decodeSetupStage({ stage: entry?.stage, declined: entry?.declined ?? [], device: name });
    if (!decoded.ok || decoded.value.device !== name) continue;
    devices[name] = { stage: decoded.value.stage, declined: decoded.value.declined, at: Number(entry?.at) || 0 };
  }
  const device = typeof raw.device === "string" && devices[raw.device] ? raw.device : null;
  return { version: 1, paired: raw.paired, device, devices };
}

/**
 * The Mac's name as its owner set it ("Tyler's MacBook Pro"), which the phone shows while it sets itself up so the
 * wrong Mac is obvious. Asked once; the host name is the fallback.
 */
let cachedComputerName: string | undefined;
export function computerName(): string {
  if (cachedComputerName !== undefined) return cachedComputerName;
  breadcrumb("phone setup: asking scutil for the computer name");
  let name = "";
  try {
    const result = Bun.spawnSync(["/usr/sbin/scutil", "--get", "ComputerName"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode === 0) name = result.stdout.toString().trim();
  } catch {}
  if (!name) name = hostname().replace(/\.local$/, "");
  cachedComputerName = name.slice(0, PHONE_DEVICE_MAX_CHARS);
  return cachedComputerName;
}

export interface PhoneSetupOptions {
  path?: string;
  now?: () => number;
  /** The published block changed: publish it. */
  onChange?: () => void;
  log?: (message: string) => void;
}

/**
 * The phone's setup as the Mac holds it. Stages only move forward, per device: a late report from a slow link never
 * undoes one already seen, and a second phone starts its own. `connecting` is never stored: it is true only while a
 * key exchange is in flight on a Mac no phone has paired with yet, and goes back to `waiting` if that exchange dies.
 */
export class PhoneSetup {
  readonly #path: string;
  readonly #now: () => number;
  readonly #onChange: () => void;
  readonly #log: (message: string) => void;
  #file: PhoneSetupFile;
  #exchanges = 0;

  constructor(options: PhoneSetupOptions = {}) {
    this.#path = options.path ?? phoneSetupPath();
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => {});
    this.#log = options.log ?? (() => {});
    try {
      this.#file = readSetupFile(this.#path);
    } catch (error) {
      this.#log(`phone setup: starting afresh (${error instanceof Error ? error.message : String(error)})`);
      this.#file = structuredClone(EMPTY);
    }
  }

  /** The block published as `phone`: exactly the contract, nothing more. */
  published(enabled: boolean): PublishedPhone {
    const device = this.#file.device;
    const current = device ? this.#file.devices[device] : undefined;
    const base: PhoneSetupStage = this.#file.paired ? "paired" : "waiting";
    const stage = current?.stage ?? (base === "waiting" && this.#exchanges > 0 ? "connecting" : base);
    return {
      enabled,
      paired: this.#file.paired,
      device: current ? device : null,
      setup: { stage, declined: [...(current?.declined ?? [])] },
    };
  }

  /** A transport's key exchange: a phone hello accepted, its first authenticated frame, or the link dying first. */
  exchange(event: KeyExchangeEvent): void {
    breadcrumb(`phone setup: key exchange ${event}`);
    this.#changing(() => {
      if (event === "started") this.#exchanges += 1;
      else this.#exchanges = Math.max(0, this.#exchanges - 1);
      if (event === "completed" && !this.#file.paired) {
        this.#file.paired = true;
        this.#save();
      }
    });
  }

  /** A phone's report. Only an authenticated phone can make one, so it also means paired. */
  report(report: SetupStageReport): SetupStageAnswer {
    breadcrumb(`phone setup: ${report.stage} reported`);
    let answer!: SetupStageAnswer;
    this.#changing(() => {
      const known = this.#file.devices[report.device];
      const forward = !known || rank(report.stage) > rank(known.stage);
      // A refusal is kept once said: a later report that leaves it out is a phone that lost track, not a yes.
      const declined = canonical(new Set([...(known?.declined ?? []), ...report.declined]));
      // The same stage again with a new refusal: said no on the screen it had already reported.
      const newlyDeclined = !forward && report.stage === known!.stage && declined.length > known!.declined.length;
      const wasPaired = this.#file.paired;
      this.#file.paired = true;
      if (forward || newlyDeclined) {
        this.#file.devices[report.device] = { stage: report.stage, declined, at: this.#now() };
        this.#file.device = report.device;
        this.#forgetOldest();
        answer = { stage: report.stage, moved: true };
        this.#log(`phone setup: ${report.device} → ${report.stage}${declined.length ? ` (declined ${declined.join(", ")})` : ""}`);
        this.#save();
      } else {
        answer = { stage: known!.stage, moved: false };
        if (!wasPaired) this.#save();
      }
    });
    return answer;
  }

  #forgetOldest(): void {
    const names = Object.keys(this.#file.devices);
    if (names.length <= PHONE_SETUP_MAX_DEVICES) return;
    names.sort((a, b) => this.#file.devices[b]!.at - this.#file.devices[a]!.at);
    for (const name of names.slice(PHONE_SETUP_MAX_DEVICES)) delete this.#file.devices[name];
  }

  /** Run a change, and say so only when what is published moved. */
  #changing(change: () => void): void {
    const before = JSON.stringify(this.published(true));
    change();
    if (JSON.stringify(this.published(true)) !== before) this.#onChange();
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
    } catch (error) {
      this.#log(`phone setup: couldn't save (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}
