import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import {
  addBrowserProfile,
  DEFAULT_BROWSER_PROFILE,
  findBrowserProfile,
  isBrowserProfileId,
  type BrowserProfile,
} from "./browser-profiles.ts";
import type { CallerBinding } from "./caller-session.ts";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { conchHome } from "./home.ts";
import { ownCapture } from "./page-capture.ts";

/**
 * The Workbench: conch's in-app browser. Live browser tabs an agent drives and Tyler watches, and takes over by clicking
 * in them, in the Mac app's Workdesk, the pane beside the conversation that was the deliverables pane (Tyler,
 * 2026-10-09: "Agents's pages should live as tabs in the deliverables plane just like the deliverables"; 2026-10-16:
 * "deliverable is a type, browser is a type").
 *
 * Tyler opens tabs too (2026-10-16: "letting me sign-in in an in-conch browser session and letting agents use that
 * browser in the app so i can watch them work"): the Workdesk's + sends `browser-tab-open` for the session in view, and
 * the tab is the session's like any other, so its agents see it in `browser_tabs` and act in it, signed in with its
 * profile. "Pause agents" on a tab (`browser-tab-event` `paused`) refuses their commands there (`pausedRefusal`) until
 * he turns it off. The daemon keeps every tab, his included, across restarts (`fileTabStore`), and the app reloads each
 * at its last address on its profile when it first sees it.
 *
 * The daemon owns the tabs (which session's, what address, which profile) and the profiles (browser-profiles.ts); the
 * Mac app owns the pages, one live web view per tab, kept alive while it runs (Workbench.swift). An agent's command
 * goes the way `conch_capture`'s page does (page-capture.ts), since the daemon can't call the app: it is named on the
 * sessions file (`browserRequests`, with the tabs and the profiles), the app says at once that it has it (`ack`), runs
 * it against the page, and answers over the socket (`browser-answer`).
 *
 * Secrets never pass through here. The app's script never reads a password or a hidden field's value, and refuses to
 * type into a password field (ConchDesign `WorkbenchScript`); the answers are read field by field into the shapes
 * below, so nothing else the app might send (cookies, storage) has anywhere to go; and what an agent types travels
 * only in the reply to the app's own ack, never on the sessions file.
 *
 * Everything here is this Mac's alone: the sessions file is read by this Mac's app, never sent to the phone or a second
 * Mac, and a phone may not send any of these kinds (phone-bridge.ts `MAC_APP_ONLY_DECODERS`).
 */

/** Said, word for word, when the Mac app isn't there to hold the pages. */
export const BROWSER_APP_DOWN = "conch's Mac app isn't running, so its browser isn't open; open it and try again";

/** How long the Mac app has to say it has a command (it reads the sessions file every quarter second; App Nap stretches it). */
export const BROWSER_ACK_MS = 10_000;
/** How long the MCP server waits on the daemon: past the daemon's own deadline, so its words arrive first. */
export const BROWSER_REPLY_MS = 50_000;
/** Commands in flight at once, across every tab. The app runs one tab's in order. */
export const BROWSER_IN_FLIGHT = 6;
export const BROWSER_TABS_PER_SESSION = 8;
export const BROWSER_TABS_MAX = 32;
/** A tab of a session no longer live is dropped once nobody has used it for this long; any tab, after a week. */
export const BROWSER_ENDED_TAB_MS = 24 * 60 * 60 * 1000;
export const BROWSER_TAB_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
export const BROWSER_URL_MAX = 4096;
export const BROWSER_TEXT_MAX = 4000;
export const BROWSER_TARGET_MAX = 500;
/** What one `read` may bring back: well inside one control frame (64 KiB) with the rest of the reply round it. */
export const BROWSER_READ_TEXT_MAX = 12_000;
export const BROWSER_READ_LINKS_MAX = 150;
export const BROWSER_READ_BUTTONS_MAX = 100;
export const BROWSER_READ_FIELDS_MAX = 100;

/** The app's own deadline for each command, from the request; the daemon waits a few seconds past it. */
export const BROWSER_OP_MS = { open: 30_000, read: 12_000, click: 15_000, type: 12_000, screenshot: 15_000 } as const;
const DAEMON_SLACK_MS = 5_000;

/**
 * The kinds `decodeBrowserMessage` takes. `browser-open` is agent B's, decoded by its own `decodeBrowserOpenRequest`
 * (browser-open.ts) and answered by this service too (`createBrowserService`).
 */
export const BROWSER_KINDS = ["browser-profiles", "browser-command", "browser-answer", "browser-tab-event", "browser-tab-open"] as const;
/** How long `browser-open` gives the lookup of its caller: inside the 15 s the shim waits (`BROWSER_OPEN_REPLY_MS`). */
export const BROWSER_OPEN_RESOLVE_MS = 8_000;
export const BROWSER_OPS = ["open", "read", "click", "type", "screenshot", "tabs", "close"] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];
/** The commands the app runs against a page. */
export type BrowserAppOp = keyof typeof BROWSER_OP_MS;

export interface BrowserTab {
  id: string;
  sessionId: string;
  /** Where it is; "" for a tab Tyler opened and hasn't sent anywhere yet (its address field is waiting for him). */
  url: string;
  title?: string;
  profile: string;
  /** Epoch-ms it was opened: the app brings a tab this new to the front for the session in view. */
  openedAt: number;
  /**
   * Epoch-ms an agent last ran a command in it, or Tyler opened it: a command naming no tab runs in its session's most
   * recent, so the tab he just opened to sign in is the one an agent's next command reaches.
   */
  usedAt: number;
  /** Who opened it: "user" for Tyler's own, from the Workdesk's +; absent for an agent's (browser_open, `open`). */
  opener?: "user";
  /** Tyler paused agents in it: their commands there are refused (`pausedRefusal`) until he turns it off. */
  paused?: true;
  /** Epoch-ms the page last moved under anyone's hand (the app's report): with `usedAt`, what keeps a tab. */
  movedAt?: number;
}

/**
 * Said to an agent whose command reaches a tab Tyler paused agents in: the reason first, in the words he would use, then
 * what to do. The Mac app refuses a command already on its way with the same words (ConchDesign `Workbench.pausedRefusal`).
 */
export function pausedRefusal(tab: string): string {
  return `the user has taken over this tab (${tab}): Pause agents is on there, so conch won't run your commands in it. Ask them to hand it back, or open a tab of your own with browser_open`;
}

/** What a click or a type is aimed at: a ref from `read`, a CSS selector, visible text, or any of them (`auto`). */
export type BrowserTarget = { ref: string } | { selector: string } | { text: string } | { auto: string };

/** A command the Mac app is to run, on the sessions file. What an agent types is not on it (`BrowserWorkbench.answer`). */
export interface BrowserAppRequest {
  id: string;
  tab: string;
  op: BrowserAppOp;
  /** open: where to go. */
  url?: string;
  /** open: the tab was made for this request, so the address it already loads is this one. */
  fresh?: true;
  /** click, type. */
  target?: BrowserTarget;
  /** type: press Return (submit the form) after typing. */
  submit?: boolean;
  /** screenshot: where to write `<id>.png`, conch's capture folder (ConchDesign `PageCapture.folder` checks it). */
  folder?: string;
  /** Epoch-ms by which the app gives up and says so. */
  deadline: number;
}

export type BrowserMessage =
  | { kind: "browser-profiles"; action: "list" }
  | { kind: "browser-profiles"; action: "add"; name: string }
  | { kind: "browser-open"; url: string; callerPid: number; profile?: string }
  | {
    kind: "browser-command";
    sessionId: string;
    op: BrowserOp;
    tab?: string;
    url?: string;
    profile?: string;
    target?: BrowserTarget;
    text?: string;
    submit?: boolean;
  }
  | { kind: "browser-answer"; request: string; ack?: true; error?: string; result?: Record<string, unknown> }
  | {
    kind: "browser-tab-event";
    tab: string;
    url?: string;
    title?: string;
    closed?: true;
    /** Tyler's "Pause agents in this tab", on or off. */
    paused?: boolean;
    /** A tab he opened and hasn't sent anywhere, moved to another profile (by id or name). */
    profile?: string;
  }
  /** Tyler's + in the Workdesk: a tab of his own for a session, blank (its address field waiting) or at `url`. */
  | { kind: "browser-tab-open"; sessionId: string; url?: string; profile?: string };

/** A tab as an agent is told of it. */
export interface BrowserTabView {
  id: string;
  url: string;
  title?: string;
  profile: string;
  profileName: string;
  /** The tab a command naming none runs in. */
  current?: true;
  /** The user opened it themselves (to sign in, often): theirs to use, and yours to act in once they say so. */
  openedBy?: "user";
  /** The user paused agents in it: commands there are refused until they turn it off. */
  paused?: true;
}

export type BrowserReply =
  | { kind: "browser-profiles"; profiles: BrowserProfile[]; created?: BrowserProfile }
  | { kind: "browser-opened"; tabId: string; sessionId: string }
  | { kind: "browser-result"; op: BrowserOp; tab?: BrowserTabView; tabs?: BrowserTabView[]; result?: Record<string, unknown> }
  | { kind: "browser-ack"; text?: string }
  | { kind: "browser-error"; error: string };

type Decoded<T> = T | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Typed text may hold a newline or a tab (a textarea); nothing else unprintable. */
const TYPED_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** An http(s) address with a host, as given; null for anything else. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > BROWSER_URL_MAX || CONTROL.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? value : null;
  } catch {
    return null;
  }
}

const TAB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const isBrowserTabId = (value: unknown): value is string => typeof value === "string" && TAB_ID.test(value);

function oneLine(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max && !CONTROL.test(value) ? value : null;
}

/** `target`: a string (any of ref, selector or text), or exactly one of `{ref}`, `{selector}`, `{text}`. */
export function parseBrowserTarget(value: unknown): Decoded<BrowserTarget> {
  if (typeof value === "string") {
    const what = oneLine(value.trim(), BROWSER_TARGET_MAX);
    return what ? { auto: what } : { error: `target must be 1 to ${BROWSER_TARGET_MAX} printable characters on one line` };
  }
  const keys = isRecord(value) ? Object.keys(value) : [];
  const how = keys.length === 1 && ["ref", "selector", "text", "auto"].includes(keys[0]!) ? keys[0] as "ref" | "selector" | "text" | "auto" : null;
  if (!how) return { error: "target must be a string, or exactly one of {ref}, {selector} or {text}" };
  const what = oneLine((value as Record<string, unknown>)[how], BROWSER_TARGET_MAX);
  if (!what) return { error: `target.${how} must be 1 to ${BROWSER_TARGET_MAX} printable characters on one line` };
  return { [how]: what.trim() } as BrowserTarget;
}

/**
 * Every kind the Workbench takes on the socket, checked field by field: the MCP server, the CLI, agent B's `open` shim
 * and the Mac app are its senders, but the socket takes any local writer. Null for anything that isn't one of these
 * kinds; `{refused}` for one that is, malformed (a phone's is refused before this, by the same decoder).
 */
export function decodeBrowserMessage(value: unknown): BrowserMessage | { refused: string } | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !(BROWSER_KINDS as readonly string[]).includes(value.kind)) return null;
  const no = (refused: string) => ({ refused });
  switch (value.kind) {
    case "browser-profiles": {
      if (value.action === "list") return { kind: "browser-profiles", action: "list" };
      if (value.action !== "add") return no('action must be "list" or "add"');
      if (typeof value.name !== "string") return no("add needs the profile's name");
      return { kind: "browser-profiles", action: "add", name: value.name };
    }
    case "browser-command": {
      const sessionId = oneLine(value.sessionId, 256);
      if (!sessionId) return no("browser-command needs its session");
      const op = BROWSER_OPS.find((known) => known === value.op);
      if (!op) return no(`op must be one of ${BROWSER_OPS.join(", ")}`);
      if (value.tab !== undefined && !isBrowserTabId(value.tab)) return no("tab must be a tab's id");
      if ((op === "close") && value.tab === undefined) return no("close names the tab it closes");
      let url: string | null | undefined;
      if (op === "open") {
        url = webUrl(value.url);
        if (!url) return no("url must be an http(s) URL");
      }
      if (value.profile !== undefined && !oneLine(value.profile, 80)) return no("profile must name a profile");
      let target: BrowserTarget | undefined;
      if (op === "click" || op === "type") {
        const parsed = parseBrowserTarget(value.target);
        if ("error" in parsed) return no(parsed.error);
        target = parsed;
      }
      let text: string | undefined;
      if (op === "type") {
        if (typeof value.text !== "string" || value.text.length > BROWSER_TEXT_MAX || TYPED_CONTROL.test(value.text)) {
          return no(`text must be up to ${BROWSER_TEXT_MAX} characters`);
        }
        if (value.submit !== undefined && typeof value.submit !== "boolean") return no("submit must be true or false");
        text = value.text;
      }
      return {
        kind: "browser-command",
        sessionId,
        op,
        ...(typeof value.tab === "string" ? { tab: value.tab } : {}),
        ...(url ? { url } : {}),
        ...(typeof value.profile === "string" ? { profile: value.profile } : {}),
        ...(target ? { target } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(op === "type" && value.submit === true ? { submit: true } : {}),
      };
    }
    case "browser-answer": {
      if (typeof value.request !== "string" || !value.request || value.request.length > 64) return no("an answer names its request");
      return {
        kind: "browser-answer",
        request: value.request,
        ...(value.ack === true ? { ack: true as const } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
        ...(isRecord(value.result) ? { result: value.result } : {}),
      };
    }
    case "browser-tab-event": {
      if (!isBrowserTabId(value.tab)) return no("a tab event names its tab");
      const url = value.url === undefined ? undefined : webUrl(value.url);
      if (value.paused !== undefined && typeof value.paused !== "boolean") return no("paused must be true or false");
      if (value.profile !== undefined && !oneLine(value.profile, 80)) return no("profile must name a profile");
      return {
        kind: "browser-tab-event",
        tab: value.tab,
        ...(url ? { url } : {}),
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        ...(value.closed === true ? { closed: true as const } : {}),
        ...(typeof value.paused === "boolean" ? { paused: value.paused } : {}),
        ...(typeof value.profile === "string" ? { profile: value.profile } : {}),
      };
    }
    case "browser-tab-open": {
      const sessionId = oneLine(value.sessionId, 256);
      if (!sessionId) return no("a new tab names its session");
      let url: string | null | undefined;
      if (value.url !== undefined && value.url !== "") {
        url = webUrl(value.url);
        if (!url) return no("url must be an http(s) URL");
      }
      if (value.profile !== undefined && !oneLine(value.profile, 80)) return no("profile must name a profile");
      return {
        kind: "browser-tab-open",
        sessionId,
        ...(url ? { url } : {}),
        ...(typeof value.profile === "string" ? { profile: value.profile } : {}),
      };
    }
  }
  return null;
}

/** A short line from the app (a title, a link's words), whitespace folded, cut to `max`; undefined when there is none. */
function said(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The page's words: line breaks kept (they are its layout), runs of blank lines and spaces folded, cut to `max`. */
function pageText(value: unknown, max: number): { text: string; cut: boolean } {
  if (typeof value !== "string") return { text: "", cut: false };
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, cut: true } : { text, cut: false };
}

const REF = /^e\d{1,6}$/;
/** Field types whose value is never returned, whatever the app sends: a password's, a hidden field's. */
const SECRET_TYPES = new Set(["password", "hidden"]);

/**
 * `read`'s answer, rebuilt from the fields it is allowed to have: the page's title and address, its words, its links
 * and buttons each with a ref, and its fields, never a password's or a hidden field's value (checked here again, after
 * the app's script, which already leaves them out).
 */
export function readPageResult(value: Record<string, unknown>): Record<string, unknown> {
  const { text, cut } = pageText(value.text, BROWSER_READ_TEXT_MAX);
  const list = (items: unknown, max: number) => (Array.isArray(items) ? items.filter(isRecord).slice(0, max) : []);
  const links = list(value.links, BROWSER_READ_LINKS_MAX).flatMap((link) => {
    if (typeof link.ref !== "string" || !REF.test(link.ref)) return [];
    const href = webUrl(link.href) ?? undefined;
    return [{ ref: link.ref, text: said(link.text, 120) ?? "", ...(href ? { href: href.length > 400 ? `${href.slice(0, 399)}…` : href } : {}) }];
  });
  const buttons = list(value.buttons, BROWSER_READ_BUTTONS_MAX).flatMap((button) =>
    typeof button.ref === "string" && REF.test(button.ref) ? [{ ref: button.ref, text: said(button.text, 120) ?? "" }] : []);
  const fields = list(value.fields, BROWSER_READ_FIELDS_MAX).flatMap((field) => {
    if (typeof field.ref !== "string" || !REF.test(field.ref)) return [];
    const type = said(field.type, 40)?.toLowerCase() ?? "text";
    const secret = SECRET_TYPES.has(type) || field.secret === true;
    return [{
      ref: field.ref,
      type,
      ...(said(field.label, 120) ? { label: said(field.label, 120) } : {}),
      ...(said(field.name, 120) ? { name: said(field.name, 120) } : {}),
      ...(!secret && typeof field.value === "string" ? { value: field.value.slice(0, 500) } : {}),
      ...(!secret && typeof field.checked === "boolean" ? { checked: field.checked } : {}),
      ...(field.disabled === true ? { disabled: true } : {}),
    }];
  });
  return {
    url: webUrl(value.url) ?? said(value.url, BROWSER_URL_MAX) ?? "",
    title: said(value.title, 300) ?? "",
    text,
    links,
    buttons,
    fields,
    ...(cut || value.truncated === true ? { truncated: true } : {}),
    ...(value.popup === true ? { popup: true } : {}),
  };
}

/** The page after a command: where it is now, what it is called, and whether the command's own words came back. */
function pageAfter(value: Record<string, unknown>): Record<string, unknown> {
  return {
    url: webUrl(value.url) ?? said(value.url, BROWSER_URL_MAX) ?? "",
    title: said(value.title, 300) ?? "",
    ...(value.loading === true ? { loading: true } : {}),
    ...(value.popup === true ? { popup: true } : {}),
  };
}

export type BrowserOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** When a tab was last of use to anyone: an agent's command, or its page moving (Tyler's hand, a redirect). */
function lastTouched(tab: Pick<BrowserTab, "usedAt" | "movedAt">): number {
  return Math.max(tab.usedAt, tab.movedAt ?? 0);
}

interface PendingCommand {
  request: BrowserAppRequest;
  /** What an agent types: handed over in the reply to the app's ack, never published. */
  text?: string;
  started: boolean;
  ackTimer: ReturnType<typeof setTimeout>;
  done(outcome: BrowserOutcome): void;
}

/** Where the tabs are kept between daemon starts. */
export function browserTabsPath(): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "browser-tabs.json");
}

export interface BrowserTabStore {
  load(): unknown;
  save(tabs: readonly BrowserTab[]): void;
}

/** The tabs on disk, readable by their owner alone: a tab's address may carry what a page put in it. */
export function fileTabStore(file: string = browserTabsPath()): BrowserTabStore {
  return {
    load() {
      try {
        return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      } catch {
        return [];
      }
    },
    save(tabs) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(tabs) + "\n", { mode: 0o600 });
        renameSync(temp, file);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    },
  };
}

export interface BrowserWorkbenchOptions {
  /** Write the sessions file again: a tab, a profile or a request appeared or went. */
  publish(): void;
  /** conch's capture folder, made if it isn't there (`captureFolder`): where screenshots are written. */
  folder(): string;
  now(): number;
  /** The profiles as they are now (`readBrowserProfiles`). */
  profiles(): BrowserProfile[];
  /** Whether the Mac app has been heard from lately (surfaces.ts `MacAppPresence`); absent, the ack alone says. */
  appRunning?(): boolean;
  store?: BrowserTabStore;
  ackMs?: number;
  /** Overrides every command's own wait (tests). */
  timeoutMs?: number;
  limit?: number;
}

/**
 * The tabs, and the broker between an agent waiting and the Mac app running its command. Modelled on `PageCaptures`:
 * the daemon names what it wants (`published`, written to the sessions file) and the app answers over the socket
 * (`answer`): an `ack` at once, then what the page said, or why not.
 */
export class BrowserWorkbench {
  readonly #options: BrowserWorkbenchOptions;
  #tabs: BrowserTab[] = [];
  readonly #pending = new Map<string, PendingCommand>();

  constructor(options: BrowserWorkbenchOptions) {
    this.#options = options;
    this.#tabs = this.#loaded(options.store?.load());
  }

  /**
   * Tabs from disk, each checked; a week untouched, or past the caps, and it is gone. A tab Tyler opened keeps who opened
   * it, whether he paused agents in it, and may be blank (he never sent it anywhere); an agent's always has an address.
   */
  #loaded(value: unknown): BrowserTab[] {
    if (!Array.isArray(value)) return [];
    const now = this.#options.now();
    const tabs: BrowserTab[] = [];
    const epoch = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    for (const entry of value) {
      if (!isRecord(entry) || !isBrowserTabId(entry.id) || tabs.some((tab) => tab.id === entry.id)) continue;
      const opener = entry.opener === "user" ? "user" as const : undefined;
      const url = webUrl(entry.url) ?? (opener && entry.url === "" ? "" : null);
      const sessionId = oneLine(entry.sessionId, 256);
      const usedAt = epoch(entry.usedAt) ?? 0;
      const openedAt = epoch(entry.openedAt) ?? usedAt;
      const movedAt = epoch(entry.movedAt);
      const tab: BrowserTab = {
        id: entry.id,
        sessionId: sessionId ?? "",
        url: url ?? "",
        ...(said(entry.title, 300) ? { title: said(entry.title, 300) } : {}),
        profile: typeof entry.profile === "string" ? entry.profile : "",
        openedAt,
        usedAt,
        ...(opener ? { opener } : {}),
        ...(entry.paused === true ? { paused: true as const } : {}),
        ...(movedAt !== undefined ? { movedAt } : {}),
      };
      if (url === null || !sessionId || !isBrowserProfileId(entry.profile) || now - lastTouched(tab) > BROWSER_TAB_KEPT_MS) continue;
      if (tabs.filter((kept) => kept.sessionId === sessionId).length >= BROWSER_TABS_PER_SESSION) continue;
      tabs.push(tab);
      if (tabs.length >= BROWSER_TABS_MAX) break;
    }
    return tabs;
  }

  #changed(): void {
    try {
      this.#options.store?.save(this.#tabs);
    } catch {
      // Keeping them across a restart is a convenience; the tabs still work.
    }
    this.#options.publish();
  }

  /** What the sessions file carries: the profiles and the tabs always (so the app knows this daemon has a browser), and the commands waiting. */
  published(): { browserProfiles: BrowserProfile[]; browserTabs: BrowserTab[]; browserRequests?: BrowserAppRequest[] } {
    const requests = [...this.#pending.values()].map((pending) => pending.request);
    return {
      browserProfiles: this.#options.profiles(),
      browserTabs: this.#tabs.map((tab) => ({ ...tab })),
      ...(requests.length ? { browserRequests: requests } : {}),
    };
  }

  tabs(): BrowserTab[] {
    return this.#tabs.map((tab) => ({ ...tab }));
  }

  tab(id: string): BrowserTab | undefined {
    return this.#tabs.find((tab) => tab.id === id);
  }

  /** A session's tabs, oldest first. */
  tabsOf(sessionId: string): BrowserTab[] {
    return this.#tabs.filter((tab) => tab.sessionId === sessionId);
  }

  /** The tab a command naming none runs in: the one its session used last. */
  current(sessionId: string): BrowserTab | undefined {
    return this.tabsOf(sessionId).reduce<BrowserTab | undefined>((best, tab) => (!best || tab.usedAt >= best.usedAt ? tab : best), undefined);
  }

  /**
   * A new tab for a session, at an address, on a profile; refused past the caps. Tyler's own (`opener` "user") may be
   * blank, `url` "", for him to type an address into.
   */
  open(sessionId: string, url: string, profile: string, opener?: "user"): { ok: true; tab: BrowserTab } | { ok: false; error: string } {
    if (this.tabsOf(sessionId).length >= BROWSER_TABS_PER_SESSION) {
      return {
        ok: false,
        error: opener
          ? `this session has ${BROWSER_TABS_PER_SESSION} tabs open; close one first`
          : `this session has ${BROWSER_TABS_PER_SESSION} tabs open; close one (browser_close) first`,
      };
    }
    if (this.#tabs.length >= BROWSER_TABS_MAX) return { ok: false, error: `conch has ${BROWSER_TABS_MAX} browser tabs open; close some first` };
    if (url === "" && opener !== "user") return { ok: false, error: "an agent's tab opens at an address" };
    let id: string;
    do id = `tab-${crypto.randomUUID().slice(0, 8)}`; while (this.tab(id));
    const now = this.#options.now();
    const tab: BrowserTab = { id, sessionId, url, profile, openedAt: now, usedAt: now, ...(opener ? { opener, movedAt: now } : {}) };
    this.#tabs.push(tab);
    this.#changed();
    return { ok: true, tab: { ...tab } };
  }

  /** Tyler's "Pause agents in this tab": on, his agents' commands there are refused; off, they run again. */
  setPaused(id: string, paused: boolean): boolean {
    const tab = this.tab(id);
    if (!tab) return false;
    if ((tab.paused === true) === paused) return true;
    if (paused) tab.paused = true;
    else delete tab.paused;
    this.#changed();
    return true;
  }

  /**
   * A blank tab of Tyler's, moved to another profile before he sends it anywhere: the app makes its page again on that
   * profile's store. A tab that has been somewhere keeps its profile, as an agent's does.
   */
  setProfile(id: string, profile: string): { ok: true } | { ok: false; error: string } {
    const tab = this.tab(id);
    if (!tab) return { ok: false, error: "no such tab" };
    if (tab.profile === profile) return { ok: true };
    if (tab.url !== "") return { ok: false, error: "a tab keeps its profile once it has been somewhere; open a new tab for another" };
    tab.profile = profile;
    this.#changed();
    return { ok: true };
  }

  /** Take a tab away: the app closes its page when it is gone from the sessions file. */
  close(id: string): boolean {
    const before = this.#tabs.length;
    this.#tabs = this.#tabs.filter((tab) => tab.id !== id);
    if (this.#tabs.length === before) return false;
    this.#changed();
    return true;
  }

  /** Where a tab is now and what it is called, from the app; `used` when an agent's command took it there. */
  update(id: string, page: { url?: unknown; title?: unknown }, used = false): void {
    const tab = this.tab(id);
    if (!tab) return;
    const url = webUrl(page.url);
    const title = said(page.title, 300);
    const moved = (url && url !== tab.url) || (title !== undefined && title !== tab.title);
    if (url) tab.url = url;
    if (title !== undefined) tab.title = title;
    if (moved) tab.movedAt = this.#options.now();
    if (used) tab.usedAt = this.#options.now();
    if (moved || used) this.#changed();
  }

  /** Drop the tabs of sessions that ended a day ago and more: nobody can reach them from a row any more. */
  pruneEnded(live: ReadonlySet<string>): void {
    const now = this.#options.now();
    const kept = this.#tabs.filter((tab) => live.has(tab.sessionId) || now - lastTouched(tab) < BROWSER_ENDED_TAB_MS);
    if (kept.length === this.#tabs.length) return;
    this.#tabs = kept;
    this.#changed();
  }

  /** The Mac app's word that a tab moved, closed, or was paused under Tyler's own hand. A profile is the service's. */
  tabEvent(message: Extract<BrowserMessage, { kind: "browser-tab-event" }>): boolean {
    if (!this.tab(message.tab)) return false;
    if (message.closed) return this.close(message.tab);
    if (message.paused !== undefined) this.setPaused(message.tab, message.paused);
    this.update(message.tab, message);
    return true;
  }

  /** Ask the Mac app to run a command against a tab's page: what the page said, or why there is nothing. */
  ask(
    tab: BrowserTab,
    command: { op: BrowserAppOp; url?: string; fresh?: true; target?: BrowserTarget; text?: string; submit?: boolean },
  ): Promise<BrowserOutcome> {
    if (this.#options.appRunning && !this.#options.appRunning()) return Promise.resolve({ ok: false, error: BROWSER_APP_DOWN });
    const limit = this.#options.limit ?? BROWSER_IN_FLIGHT;
    if (this.#pending.size >= limit) {
      return Promise.resolve({ ok: false, error: `conch's browser is already running ${this.#pending.size} commands; wait for them, then try again` });
    }
    let folder: string | undefined;
    if (command.op === "screenshot") {
      try {
        folder = this.#options.folder();
      } catch (error) {
        return Promise.resolve({ ok: false, error: `conch couldn't make its capture folder: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const now = this.#options.now();
    const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const ms = BROWSER_OP_MS[command.op];
    const request: BrowserAppRequest = {
      id,
      tab: tab.id,
      op: command.op,
      ...(command.url ? { url: command.url } : {}),
      ...(command.fresh ? { fresh: true as const } : {}),
      ...(command.target ? { target: command.target } : {}),
      ...(command.op === "type" ? { submit: command.submit === true } : {}),
      ...(folder ? { folder } : {}),
      deadline: now + ms,
    };
    const timeoutMs = this.#options.timeoutMs ?? ms + DAEMON_SLACK_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({
        ok: false,
        error: `conch's browser didn't finish the ${command.op} in ${Math.round(timeoutMs / 1000)} s; the page may still be loading, so read it again`,
      }), timeoutMs);
      const ackTimer = setTimeout(() => {
        if (!this.#pending.get(id)?.started) finish({ ok: false, error: BROWSER_APP_DOWN });
      }, this.#options.ackMs ?? BROWSER_ACK_MS);
      const finish = (outcome: BrowserOutcome) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        clearTimeout(ackTimer);
        this.#options.publish();
        resolve(outcome);
      };
      this.#pending.set(id, { request, ...(command.text !== undefined ? { text: command.text } : {}), started: false, ackTimer, done: finish });
      this.#options.publish();
    });
  }

  /**
   * The app's answer to one command: that it has it (`ack`, answered with what to type, when it is a type), what the
   * page said, or why not. Each answer is read into its command's own shape; nothing else in it goes anywhere.
   */
  async answer(message: Extract<BrowserMessage, { kind: "browser-answer" }>): Promise<{ ok: true; text?: string } | { ok: false; error: string }> {
    const waiting = this.#pending.get(message.request);
    if (!waiting) return { ok: false, error: "no browser command is waiting on that request" };
    const { request } = waiting;
    if (message.ack) {
      waiting.started = true;
      clearTimeout(waiting.ackTimer);
      return { ok: true, ...(waiting.text !== undefined ? { text: waiting.text } : {}) };
    }
    if (message.error !== undefined) {
      const page = isRecord(message.result) ? pageAfter(message.result) : undefined;
      if (page) this.update(request.tab, page);
      waiting.done({ ok: false, error: said(message.error, 400) ?? "conch's browser couldn't do that" });
      return { ok: true };
    }
    const result = message.result ?? {};
    let outcome: Record<string, unknown>;
    switch (request.op) {
      case "read":
        outcome = readPageResult(result);
        break;
      case "screenshot": {
        const file = await ownCapture(result.path, request.folder ?? "", `${request.id}.png`);
        if (!file.ok) {
          waiting.done({ ok: false, error: "the Mac app's screenshot was refused" });
          return { ok: false, error: file.why };
        }
        outcome = { path: file.path, width: file.width, height: file.height, ...pageAfter(result) };
        break;
      }
      case "click":
        outcome = { ...pageAfter(result), ...(said(result.clicked, 200) ? { clicked: said(result.clicked, 200) } : {}) };
        break;
      case "type":
        outcome = {
          ...pageAfter(result),
          ...(said(result.typed, 200) ? { typed: said(result.typed, 200) } : {}),
          ...(result.submitted === true ? { submitted: true } : {}),
        };
        break;
      case "open":
        outcome = pageAfter(result);
        break;
    }
    this.update(request.tab, result, true);
    waiting.done({ ok: true, result: outcome });
    return { ok: true };
  }
}

export interface BrowserServiceDependencies {
  workbench: BrowserWorkbench;
  /** The profiles as they are now. */
  profiles(): BrowserProfile[];
  /** Add a profile by name (`addBrowserProfile`); the default writes `browser-profiles.json`. */
  addProfile?(name: string): { profile: BrowserProfile; profiles: BrowserProfile[]; added: boolean };
  /** The session a process was started by (caller-session.ts `sessionForCallerPid`), for `browser-open`. */
  resolveCaller(pid: number): Promise<CallerBinding>;
  /** How long that lookup may take (`BROWSER_OPEN_RESOLVE_MS`; tests shorten it). */
  resolveMs?: number;
  /** Write the sessions file again: the profiles changed. */
  publish(): void;
  /** Whether the Mac app has been heard from lately; absent, it is taken to be, and the ack decides. */
  appRunning?(): boolean;
  /** Whether a session is one conch is showing now, for a tab Tyler opens in it; absent, any session is. */
  liveSession?(sessionId: string): boolean;
  log?(line: string): void;
}

export interface BrowserService {
  handle(message: BrowserMessage): Promise<BrowserReply>;
}

/** Every Workbench kind, answered: the profiles, agent B's `open`, an agent's command, the app's answers and its tabs' news. */
export function createBrowserService(deps: BrowserServiceDependencies): BrowserService {
  const { workbench } = deps;
  const fail = (error: string): BrowserReply => ({ kind: "browser-error", error });
  const view = (tab: BrowserTab, current?: BrowserTab): BrowserTabView => {
    const profile = deps.profiles().find((known) => known.id === tab.profile);
    return {
      id: tab.id,
      url: tab.url,
      ...(tab.title ? { title: tab.title } : {}),
      profile: tab.profile,
      profileName: profile?.name ?? tab.profile,
      ...(current && current.id === tab.id ? { current: true as const } : {}),
      ...(tab.opener === "user" ? { openedBy: "user" as const } : {}),
      ...(tab.paused ? { paused: true as const } : {}),
    };
  };
  const profileFor = (named: string | undefined): BrowserProfile | string => {
    const profiles = deps.profiles();
    if (named === undefined) return profiles.find((profile) => profile.id === DEFAULT_BROWSER_PROFILE.id) ?? { ...DEFAULT_BROWSER_PROFILE };
    return findBrowserProfile(profiles, named)
      ?? `there's no browser profile "${named}"; conch has ${profiles.map((profile) => `"${profile.name}"`).join(", ")}`;
  };

  return {
    async handle(message) {
      switch (message.kind) {
        case "browser-profiles": {
          if (message.action === "list") return { kind: "browser-profiles", profiles: deps.profiles() };
          try {
            const added = (deps.addProfile ?? ((name) => addBrowserProfile(name)))(message.name);
            if (added.added) deps.publish();
            return { kind: "browser-profiles", profiles: added.profiles, created: added.profile };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        }
        case "browser-open": {
          // Agent B's `open`, redirected: a page an agent opened comes up as a tab of its session, or `open` does what it
          // always did. Only with the app there to show it, and only for a session conch can name.
          if (deps.appRunning && !deps.appRunning()) return fail(BROWSER_APP_DOWN);
          if (!webUrl(message.url)) return fail("url must be an http(s) URL");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const binding = await Promise.race([
            deps.resolveCaller(message.callerPid),
            new Promise<CallerBinding>((resolve) => {
              timer = setTimeout(() => resolve({ status: "unverified", reason: "finding its session took too long" }), deps.resolveMs ?? BROWSER_OPEN_RESOLVE_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (binding.status !== "verified") return fail(`conch can't tell which session opened it: ${binding.reason}`);
          const profile = profileFor(message.profile);
          if (typeof profile === "string") return fail(profile);
          const opened = workbench.open(binding.session.sessionId, message.url, profile.id);
          if (!opened.ok) return fail(opened.error);
          deps.log?.(`browser: ${opened.tab.id} opened for ${binding.session.sessionId} by pid ${message.callerPid}`);
          return { kind: "browser-opened", tabId: opened.tab.id, sessionId: binding.session.sessionId };
        }
        case "browser-command":
          return command(message);
        case "browser-answer": {
          const answered = await workbench.answer(message);
          if (!answered.ok) return fail(answered.error);
          return { kind: "browser-ack", ...(answered.text !== undefined ? { text: answered.text } : {}) };
        }
        case "browser-tab-event": {
          // A blank tab of Tyler's moved to another profile first: refused whole when it can't be, so nothing in the
          // event half-happens.
          if (message.profile !== undefined && !message.closed) {
            if (!workbench.tab(message.tab)) return fail("no such tab");
            const profile = profileFor(message.profile);
            if (typeof profile === "string") return fail(profile);
            const moved = workbench.setProfile(message.tab, profile.id);
            if (!moved.ok) return fail(moved.error);
          }
          return workbench.tabEvent(message) ? { kind: "browser-ack" } : fail("no such tab");
        }
        case "browser-tab-open": {
          // Tyler's +: a tab of his own in the session he is looking at, on the profile he picked, blank unless he gave
          // an address. Its session's agents see it in browser_tabs and may act in it, as in any tab of theirs.
          if (deps.liveSession && !deps.liveSession(message.sessionId)) return fail("that session isn't one conch is showing now");
          const profile = profileFor(message.profile);
          if (typeof profile === "string") return fail(profile);
          const opened = workbench.open(message.sessionId, message.url ?? "", profile.id, "user");
          if (!opened.ok) return fail(opened.error);
          deps.log?.(`browser: ${opened.tab.id} opened by the user for ${message.sessionId} on profile ${profile.id}`);
          return { kind: "browser-opened", tabId: opened.tab.id, sessionId: message.sessionId };
        }
      }
    },
  };

  async function command(message: Extract<BrowserMessage, { kind: "browser-command" }>): Promise<BrowserReply> {
    const { sessionId, op } = message;
    const own = message.tab === undefined ? undefined : workbench.tab(message.tab);
    if (message.tab !== undefined && own?.sessionId !== sessionId) {
      return fail(`there's no tab ${message.tab} in this session; browser_tabs lists yours`);
    }
    if (op === "tabs") {
      const current = workbench.current(sessionId);
      return { kind: "browser-result", op, tabs: workbench.tabsOf(sessionId).map((tab) => view(tab, current)) };
    }
    // Tyler's hand on it: nothing an agent sends reaches a tab he paused agents in, closing it included.
    if (own?.paused) return fail(pausedRefusal(own.id));
    if (op === "close") {
      workbench.close(own!.id);
      return { kind: "browser-result", op, result: { closed: own!.id } };
    }
    if (op === "open") {
      const named = message.profile === undefined ? undefined : profileFor(message.profile);
      if (typeof named === "string") return fail(named);
      if (own) {
        if (named && named.id !== own.profile) {
          return fail(`tab ${own.id} is on another profile; a tab keeps its profile, so open a new tab for ${named.name}`);
        }
        return run(own, { op: "open", url: message.url! });
      }
      if (deps.appRunning && !deps.appRunning()) return fail(BROWSER_APP_DOWN);
      const profile = named ?? profileFor(undefined) as BrowserProfile;
      const opened = workbench.open(sessionId, message.url!, profile.id);
      if (!opened.ok) return fail(opened.error);
      const reply = await run(opened.tab, { op: "open", url: message.url!, fresh: true });
      // A tab nobody could show is no tab: the agent hears why, and nothing is left behind for later.
      if (reply.kind === "browser-error" && reply.error === BROWSER_APP_DOWN) workbench.close(opened.tab.id);
      return reply;
    }
    const tab = own ?? workbench.current(sessionId);
    if (!tab) return fail("this session has no browser tab yet; open one with browser_open");
    if (tab.paused) return fail(pausedRefusal(tab.id));
    return run(tab, {
      op,
      ...(message.target ? { target: message.target } : {}),
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.submit ? { submit: true } : {}),
    });
  }

  async function run(tab: BrowserTab, spec: Parameters<BrowserWorkbench["ask"]>[1]): Promise<BrowserReply> {
    const outcome = await workbench.ask(tab, spec);
    if (!outcome.ok) return fail(outcome.error);
    const now = workbench.tab(tab.id) ?? tab;
    return { kind: "browser-result", op: spec.op, tab: view(now, workbench.current(tab.sessionId)), result: outcome.result };
  }
}

/** The sessions file's state, with the Workbench's. Never the phone's or another Mac's (see the top). */
export function withBrowserState<State extends object>(state: State, workbench: Pick<BrowserWorkbench, "published">): State & ReturnType<BrowserWorkbench["published"]> {
  return { ...state, ...workbench.published() };
}

export type BrowserSend =
  | { ok: true; reply: BrowserReply }
  | { ok: false; reason: "daemon-down" | "no-reply"; diagnostic?: string };

/** The daemon's reply, read defensively: one of the shapes `createBrowserService` writes, or nothing. */
export function readBrowserReply(value: unknown): BrowserReply | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "browser-error":
      return typeof value.error === "string" ? { kind: "browser-error", error: value.error } : null;
    case "browser-opened":
      return typeof value.tabId === "string" && typeof value.sessionId === "string"
        ? { kind: "browser-opened", tabId: value.tabId, sessionId: value.sessionId }
        : null;
    case "browser-profiles":
      return Array.isArray(value.profiles) ? value as unknown as BrowserReply : null;
    case "browser-result":
      return BROWSER_OPS.includes(value.op as BrowserOp) ? value as unknown as BrowserReply : null;
    case "browser-ack":
      return value as unknown as BrowserReply;
  }
  return null;
}

/** The MCP server's and the CLI's side of the socket: one message, held open for the daemon's answer. */
export function requestBrowser(
  socketPath: string,
  message: BrowserMessage,
  timeoutMs = BROWSER_REPLY_MS,
): Promise<BrowserSend> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify(message));
    } catch (error) {
      resolve({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      return;
    }
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (result: BrowserSend) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: "timed out" }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply = readBrowserReply(JSON.parse(line));
        finish(reply ? { ok: true, reply } : { ok: false, reason: "no-reply", diagnostic: "the daemon's answer wasn't the browser's" });
      } catch (error) {
        finish({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: error.message }));
    socket.on("close", () => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down" }));
  });
}

/** `conch browser`'s usage. */
export const BROWSER_CLI_USAGE = "usage: conch browser profiles [add <name>] | conch browser open <url> [--profile <name>]";

/**
 * `conch browser`: the profiles, listed or added (what the Mac app's Settings sends), and `open`, which opens a page as a
 * tab of the session that ran it, by this process's pid, as agent B's `open` shim does. Lines to print, and the exit code.
 */
export async function runBrowserCli(
  args: readonly string[],
  socketPath: string,
  send: (socketPath: string, message: BrowserMessage, timeoutMs?: number) => Promise<BrowserSend> = requestBrowser,
  pid: number = process.pid,
): Promise<{ code: number; lines: string[] }> {
  const [what, ...rest] = args;
  let message: BrowserMessage;
  if (what === "profiles" && rest.length === 0) message = { kind: "browser-profiles", action: "list" };
  else if (what === "profiles" && rest[0] === "add" && rest.length > 1) message = { kind: "browser-profiles", action: "add", name: rest.slice(1).join(" ") };
  else if (what === "open" && rest.length >= 1) {
    const at = rest.indexOf("--profile");
    const profile = at >= 0 ? rest[at + 1] : undefined;
    const url = rest.find((_, index) => at < 0 || (index !== at && index !== at + 1));
    if (!url || (at >= 0 && !profile)) return { code: 2, lines: [BROWSER_CLI_USAGE] };
    message = { kind: "browser-open", url, callerPid: pid, ...(profile ? { profile } : {}) };
  } else {
    return { code: 2, lines: [BROWSER_CLI_USAGE] };
  }
  const sent = await send(socketPath, message, 10_000);
  if (!sent.ok) return { code: 1, lines: [sent.reason === "daemon-down" ? "[conch] daemon not running" : "[conch] the daemon didn't answer"] };
  const reply = sent.reply;
  switch (reply.kind) {
    case "browser-error":
      return { code: 1, lines: [`[conch] ${reply.error}`] };
    case "browser-profiles":
      return {
        code: 0,
        lines: [
          ...(reply.created ? [`[conch] ${reply.created.name} (${reply.created.id})`] : []),
          ...reply.profiles.map((profile) => `${profile.name.padEnd(24)} ${profile.id}`),
        ],
      };
    case "browser-opened":
      return { code: 0, lines: [`[conch] opened ${reply.tabId} for session ${reply.sessionId}`] };
    default:
      return { code: 1, lines: ["[conch] the daemon's answer wasn't the browser's"] };
  }
}
