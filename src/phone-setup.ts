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
 * Nothing secret goes in it or on its disk: no token, no relay secret, no room, no code. Only the phone's own name,
 * the random id its app keeps for this install, and how far it got.
 *
 * Each phone's progress is kept by that install id, never by its name: on iOS 16 and later every phone's name reads
 * "iPhone", so keyed by name a second phone, or this one reinstalled, took over the first's record, and was shown
 * finished from its first report with an old microphone refusal stuck on it. The name is only what the Mac shows.
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
/** An install id: the app's random UUID for this install (`PhoneSetupStore.install`), or anything as plain and short. */
const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;
/**
 * How long after a phone's key exchange the Mac waits for it to say where its setup is before deciding it won't: an app
 * with setup reports as soon as its link is up (four seconds' budget, then its retries). A phone that says nothing in
 * that time is one with nothing to report (paired before setup existed, or its app reinstalled without its setup), and
 * the Mac shows it paired, with nothing to mirror, rather than "setting itself up" for good.
 */
export const PHONE_SETUP_REPORT_GRACE_MS = 15_000;

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
  /** The phone's name, shown on the Mac and nothing else. */
  device: string;
  /** This install of the app: what its progress is kept by. Absent from the first setup build's reports, kept by name. */
  install?: string;
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
  if (body.install !== undefined && (typeof body.install !== "string" || !INSTALL_ID.test(body.install))) {
    return { ok: false, err: "install must be the app's install id" };
  }
  const install = body.install as string | undefined;
  return { ok: true, value: { stage, declined: canonical(declined), device, ...(install ? { install } : {}) } };
}

export function phoneSetupPath(home: string = conchHome()): string {
  return join(home, ".config", "conch", "phone-setup.json");
}

/** One install's setup, as the Mac keeps it: the name to show, and how far it got. */
interface PhoneRecord {
  name: string;
  stage: PhoneSetupStage;
  declined: PhoneSetupStage[];
  at: number;
}

interface PhoneSetupFile {
  version: 2;
  paired: boolean;
  /** The install whose report last moved on: the one `phone` shows. */
  current: string | null;
  /** By install (`install:<id>`), or by name for a report from before install ids (`name:<device>`). */
  phones: Record<string, PhoneRecord>;
}

const EMPTY: PhoneSetupFile = { version: 2, paired: false, current: null, phones: {} };

/** Where a report's progress is kept: its install, else (the first setup build) its name. */
const recordKey = (report: Pick<SetupStageReport, "device" | "install">): string =>
  report.install ? `install:${report.install}` : `name:${report.device}`;

/** A file from an earlier run, taken only as far as it is sound; one keyed by name (version 1) is kept by name. Anything else starts afresh. */
function readSetupFile(path: string): PhoneSetupFile {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if ((raw?.version !== 1 && raw?.version !== 2) || typeof raw.paired !== "boolean") throw new Error("unrecognised phone setup file");
  const entries = raw.version === 1 ? raw.devices : raw.phones;
  if (!entries || typeof entries !== "object") throw new Error("unrecognised phone setup file");
  const phones: Record<string, PhoneRecord> = {};
  for (const [key, entry] of Object.entries(entries as Record<string, Partial<PhoneRecord> | undefined>)) {
    const name = raw.version === 1 ? key : entry?.name;
    const decoded = decodeSetupStage({ stage: entry?.stage, declined: entry?.declined ?? [], device: name });
    if (!decoded.ok || decoded.value.device !== name) continue;
    if (raw.version === 2 && !/^(install|name):/.test(key)) continue;
    phones[raw.version === 1 ? `name:${key}` : key] = { name: decoded.value.device, stage: decoded.value.stage, declined: decoded.value.declined, at: Number(entry?.at) || 0 };
  }
  const wanted = raw.version === 1 ? (typeof raw.device === "string" ? `name:${raw.device}` : null) : (typeof raw.current === "string" ? raw.current : null);
  const current = wanted && phones[wanted] ? wanted : null;
  return { version: 2, paired: raw.paired, current, phones };
}

/** This Mac's host name, as a name: what stands in while its own name isn't known. */
function hostName(): string {
  return hostname().replace(/\.local$/, "").slice(0, PHONE_DEVICE_MAX_CHARS);
}

/** How long scutil gets to say the Mac's name before the host name stands in for it. */
export const COMPUTER_NAME_TIMEOUT_MS = 3_000;

async function askScutil(timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["/usr/sbin/scutil", "--get", "ComputerName"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Mac's name as its owner set it ("Tyler's MacBook Pro"), which the phone shows while it sets itself up so the
 * wrong Mac is obvious. Asked once, when the daemon starts, and never on a phone's request: the first `/setup-stage`
 * used to run scutil synchronously, with no timeout, holding the daemon's whole event loop while it answered. Until it
 * has answered, and whenever it can't, the host name stands in.
 */
export class ComputerName {
  #name: string | undefined;
  #asking: Promise<string> | undefined;
  readonly #fallback: () => string;

  constructor(fallback: () => string = hostName) {
    this.#fallback = fallback;
  }

  /** The name, from what's already known: never a process, never a wait. */
  current(): string {
    return this.#name ?? this.#fallback();
  }

  /** Ask for it, once, off every request's path: the host name if the answer is empty, fails or takes too long. */
  resolve(options: { timeoutMs?: number; ask?: (timeoutMs: number) => Promise<string> } = {}): Promise<string> {
    this.#asking ??= (async () => {
      breadcrumb("phone setup: asking scutil for the computer name");
      const timeoutMs = options.timeoutMs ?? COMPUTER_NAME_TIMEOUT_MS;
      let name = "";
      try {
        name = await Promise.race([(options.ask ?? askScutil)(timeoutMs), Bun.sleep(timeoutMs).then(() => "")]);
      } catch {}
      this.#name = (name.trim() || this.#fallback()).slice(0, PHONE_DEVICE_MAX_CHARS);
      return this.#name;
    })();
    return this.#asking;
  }
}

const thisMac = new ComputerName();
/** This Mac's name for the phone (`ComputerName.current`). */
export const computerName = (): string => thisMac.current();
/** Asked at daemon start (`ComputerName.resolve`). */
export const resolveComputerName = (): Promise<string> => thisMac.resolve();

export interface PhoneSetupOptions {
  path?: string;
  now?: () => number;
  /** The published block changed: publish it. */
  onChange?: () => void;
  log?: (message: string) => void;
  /** Scheduling, for tests: when the wait for a report after a key exchange is over. */
  setTimer?: (run: () => void, ms: number) => { clear(): void };
}

/**
 * The phone's setup as the Mac holds it. Stages only move forward, per install: a late report from a slow link never
 * undoes one already seen, and a second phone, or this one reinstalled, starts its own. `connecting` is never stored:
 * it is true only while a key exchange is in flight on a Mac no phone has paired with yet, and goes back to `waiting`
 * if that exchange dies.
 *
 * A phone that pairs and says nothing (`PHONE_SETUP_REPORT_GRACE_MS` after its key exchange) has nothing to mirror: it
 * is published paired with no name and `finished`, and the record of an earlier install that stopped part way is not
 * shown for it. What a phone reports is shown again as soon as it reports.
 */
export class PhoneSetup {
  readonly #path: string;
  readonly #now: () => number;
  readonly #onChange: () => void;
  readonly #log: (message: string) => void;
  readonly #setTimer: (run: () => void, ms: number) => { clear(): void };
  #file: PhoneSetupFile;
  #exchanges = 0;
  /** When the latest key exchange completed, and when the latest report came: 0 for none since this daemon started. */
  #exchangedAt = 0;
  #reportedAt = 0;
  #graceTimer: { clear(): void } | undefined;
  #last: string;

  constructor(options: PhoneSetupOptions = {}) {
    this.#path = options.path ?? phoneSetupPath();
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => {});
    this.#log = options.log ?? (() => {});
    this.#setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return { clear: () => clearTimeout(timer) };
    });
    try {
      this.#file = readSetupFile(this.#path);
    } catch (error) {
      this.#log(`phone setup: starting afresh (${error instanceof Error ? error.message : String(error)})`);
      this.#file = structuredClone(EMPTY);
    }
    this.#last = JSON.stringify(this.published(true));
  }

  /** The block published as `phone`: exactly the contract, nothing more. */
  published(enabled: boolean): PublishedPhone {
    const shown = this.#shown();
    if (shown) {
      return { enabled, paired: this.#file.paired, device: shown.name, setup: { stage: shown.stage, declined: [...shown.declined] } };
    }
    if (!this.#file.paired) {
      return { enabled, paired: false, device: null, setup: { stage: this.#exchanges > 0 ? "connecting" : "waiting", declined: [] } };
    }
    // Paired, and nothing reported to mirror: while a phone that has just connected may still say, paired; after, it has
    // nothing more to set up, and the Mac moves on.
    return { enabled, paired: true, device: null, setup: { stage: this.#awaitingReport() ? "paired" : "finished", declined: [] } };
  }

  /** A key exchange completed, and no report has come since. */
  #unreportedExchange(): boolean {
    return this.#exchangedAt > 0 && this.#reportedAt < this.#exchangedAt;
  }

  #awaitingReport(): boolean {
    return this.#unreportedExchange() && this.#now() - this.#exchangedAt < PHONE_SETUP_REPORT_GRACE_MS;
  }

  /**
   * The record the Mac shows: the latest install to move on. Not once a phone has connected since and said nothing: that
   * record is another install's, stopped part way, and the phone here has nothing to mirror. A finished one is still
   * true whoever is connected.
   */
  #shown(): PhoneRecord | undefined {
    const record = this.#file.current ? this.#file.phones[this.#file.current] : undefined;
    if (!record) return undefined;
    if (record.stage !== "finished" && this.#unreportedExchange() && !this.#awaitingReport()) return undefined;
    return record;
  }

  /** A transport's key exchange: a phone hello accepted, its first authenticated frame, or the link dying first. */
  exchange(event: KeyExchangeEvent): void {
    breadcrumb(`phone setup: key exchange ${event}`);
    this.#changing(() => {
      if (event === "started") this.#exchanges += 1;
      else this.#exchanges = Math.max(0, this.#exchanges - 1);
      if (event !== "completed") return;
      this.#exchangedAt = this.#now();
      if (!this.#file.paired) {
        this.#file.paired = true;
        this.#save();
      }
      // The wait for its report ends by itself: what's published moves then, with nothing else happening.
      this.#graceTimer?.clear();
      this.#graceTimer = this.#setTimer(() => this.#changing(() => {}), PHONE_SETUP_REPORT_GRACE_MS + 1);
    });
  }

  /** A phone's report. Only an authenticated phone can make one, so it also means paired. */
  report(report: SetupStageReport): SetupStageAnswer {
    breadcrumb(`phone setup: ${report.stage} reported`);
    let answer!: SetupStageAnswer;
    this.#changing(() => {
      this.#reportedAt = Math.max(this.#now(), this.#exchangedAt);
      const key = recordKey(report);
      const known = this.#file.phones[key];
      const forward = !known || rank(report.stage) > rank(known.stage);
      // A refusal is kept once said: a later report that leaves it out is a phone that lost track, not a yes.
      const declined = canonical(new Set([...(known?.declined ?? []), ...report.declined]));
      // The same stage again with a new refusal: said no on the screen it had already reported.
      const newlyDeclined = !forward && report.stage === known!.stage && declined.length > known!.declined.length;
      const wasPaired = this.#file.paired;
      this.#file.paired = true;
      if (forward || newlyDeclined) {
        this.#file.phones[key] = { name: report.device, stage: report.stage, declined, at: this.#now() };
        this.#file.current = key;
        this.#forgetOldest();
        answer = { stage: report.stage, moved: true };
        this.#log(`phone setup: ${report.device} → ${report.stage}${declined.length ? ` (declined ${declined.join(", ")})` : ""}`);
        this.#save();
      } else {
        answer = { stage: known!.stage, moved: false };
        // Renamed in Settings since: shown by its new name.
        const renamed = known!.name !== report.device;
        if (renamed) known!.name = report.device;
        if (renamed || !wasPaired) this.#save();
      }
    });
    return answer;
  }

  #forgetOldest(): void {
    const keys = Object.keys(this.#file.phones);
    if (keys.length <= PHONE_SETUP_MAX_DEVICES) return;
    keys.sort((a, b) => this.#file.phones[b]!.at - this.#file.phones[a]!.at);
    for (const key of keys.slice(PHONE_SETUP_MAX_DEVICES)) delete this.#file.phones[key];
  }

  /** Run a change, and say so only when what is published moved since it was last said. */
  #changing(change: () => void): void {
    change();
    const now = JSON.stringify(this.published(true));
    if (now === this.#last) return;
    this.#last = now;
    this.#onChange();
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
