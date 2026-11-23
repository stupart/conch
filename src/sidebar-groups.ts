import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { conchHome } from "./home.ts";

/**
 * Tyler's own sidebar groups, and the order he dragged sessions and sections into (2026-11-12).
 *
 * Tyler: "would also love to drag and drop for organization." The sidebar grouped sessions by the folder each runs in,
 * and only the folders could be dragged, their order kept in the Mac app alone. Now he can make groups of his own (by
 * project, say), drag a session into one, and order sessions within any section. A session he hasn't placed stays
 * under its folder, as before.
 *
 * The daemon owns the file and publishes it with the sessions (`PublishedState.sidebarGroups`), so the phone draws the
 * same list; the Mac app works out each change (ConchDesign/SidebarLayout.swift, where the rules are tested) and sends
 * the whole layout back, which is checked here and saved as sent. Last write wins, which with one Mac editing it is
 * the only write.
 *
 * 2026-11-23, Tyler: "Can we also add the ability for me to group sessions in "faux groups" that are a conch-specific
 * construct on the sidebar? Maybe we call them "focus groups" … i can have certain ones have different priorities like
 * "top" "working" "shelf" and in that case it would always return me to any top ones first and then working if all top
 * is busy?" These groups are his focus groups: still organization only (a session never moves), and each has a
 * priority, which orders the hand-off (event-queue.ts `takeNextQueuedEvent`) and nothing else. "In the future the agent
 * can manage these groups": `conch agent groups` edits them here through the daemon (`editSidebarGroups`), as the Mac's
 * save does, so the Mac and the phone redraw at once.
 */
export interface SidebarGroups {
  v: 1;
  /** His focus groups, by id (`group:…`), the name he gave each and its priority: absent is working, the default. */
  groups: Array<{ id: string; name: string; priority?: FocusPriority }>;
  /** Which group each session was put in, by session id. A session in none is under its folder. */
  placements: Record<string, string>;
  /** Each section's sessions in the order he dragged them, by section: a group's id or a folder's path. */
  rows: Record<string, string[]>;
  /** The sections' order: group ids and folder paths. Those never placed follow, as they arrive. */
  sections: string[];
}

export const EMPTY_SIDEBAR_GROUPS: SidebarGroups = { v: 1, groups: [], placements: {}, rows: {}, sections: [] };

/**
 * A focus group's priority, in hand-off order: a queued top session is taken before a working one, and a working one
 * before a shelf one (`FOCUS_RANK`). Any number of groups may share one. Shelf is last, never silenced. A session in no
 * focus group is working, so a group left at the default changes nothing.
 */
export const FOCUS_PRIORITIES = ["top", "working", "shelf"] as const;
export type FocusPriority = (typeof FOCUS_PRIORITIES)[number];
export const FOCUS_RANK: Readonly<Record<FocusPriority, number>> = { top: 0, working: 1, shelf: 2 };
export const isFocusPriority = (value: unknown): value is FocusPriority =>
  typeof value === "string" && (FOCUS_PRIORITIES as readonly string[]).includes(value);

/**
 * ponytail: a placement or a section's order outlives its session on purpose (a session resumed tomorrow keeps its
 * place), so nothing prunes them by liveness; these caps keep a year of sessions from growing the file without bound.
 * The Mac drops the oldest placements first (SidebarLayout.capped).
 */
export const SIDEBAR_LIMITS = { groups: 64, name: 60, placements: 2_000, sections: 500, rowsPerSection: 500, id: 200, path: 4_096 } as const;

export function sidebarGroupsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "sidebar-groups.json");
}

const GROUP_ID = /^group:[A-Za-z0-9-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const sessionKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= SIDEBAR_LIMITS.id && !CONTROL.test(value);
const sectionKey = (value: unknown): value is string =>
  typeof value === "string" && (GROUP_ID.test(value) || (value.startsWith("/") && value.length <= SIDEBAR_LIMITS.path && !CONTROL.test(value)));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A layout as the Mac sent it, checked field by field; the error names what was wrong. */
export function validateSidebarGroups(value: unknown): { ok: true; value: SidebarGroups } | { ok: false; error: string } {
  if (!object(value) || value.v !== 1) return { ok: false, error: "a sidebar layout is version 1" };
  const { groups, placements, rows, sections } = value;
  if (!Array.isArray(groups) || groups.length > SIDEBAR_LIMITS.groups) return { ok: false, error: `at most ${SIDEBAR_LIMITS.groups} focus groups` };
  const ids = new Set<string>();
  const names = new Set<string>();
  const kept: SidebarGroups["groups"] = [];
  for (const group of groups) {
    if (!object(group) || typeof group.id !== "string" || !GROUP_ID.test(group.id) || ids.has(group.id)) return { ok: false, error: "each focus group has an id of its own" };
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (!name || name.length > SIDEBAR_LIMITS.name || CONTROL.test(name)) return { ok: false, error: `a focus group's name is 1–${SIDEBAR_LIMITS.name} printable characters` };
    if (names.has(name.toLowerCase())) return { ok: false, error: `there is already a focus group called ${name}` };
    ids.add(group.id);
    names.add(name.toLowerCase());
    // Kept only when it isn't the default: a file says working by leaving it out. One this daemon doesn't know reads as
    // working, as an older daemon (which keeps no priority at all) reads every one: a group is never lost over it.
    const priority = isFocusPriority(group.priority) && group.priority !== "working" ? group.priority : undefined;
    kept.push({ id: group.id, name, ...(priority ? { priority } : {}) });
  }
  if (!object(placements) || Object.keys(placements).length > SIDEBAR_LIMITS.placements) return { ok: false, error: `at most ${SIDEBAR_LIMITS.placements} placements` };
  const placed: Record<string, string> = {};
  for (const [session, group] of Object.entries(placements)) {
    if (!sessionKey(session) || typeof group !== "string") return { ok: false, error: "a placement is a session id and a group id" };
    // A group deleted in the same change takes its placements with it.
    if (ids.has(group)) placed[session] = group;
  }
  if (!object(rows) || Object.keys(rows).length > SIDEBAR_LIMITS.sections) return { ok: false, error: `at most ${SIDEBAR_LIMITS.sections} ordered sections` };
  const ordered: Record<string, string[]> = {};
  for (const [section, order] of Object.entries(rows)) {
    if (!sectionKey(section) || !Array.isArray(order) || order.length > SIDEBAR_LIMITS.rowsPerSection || !order.every(sessionKey)) {
      return { ok: false, error: "a section's order is its id and its sessions' ids" };
    }
    if (GROUP_ID.test(section) && !ids.has(section)) continue;
    ordered[section] = [...new Set(order as string[])];
  }
  if (!Array.isArray(sections) || sections.length > SIDEBAR_LIMITS.sections || !sections.every(sectionKey)) {
    return { ok: false, error: "the sections' order is group ids and folder paths" };
  }
  const order = [...new Set(sections as string[])].filter((section) => !GROUP_ID.test(section) || ids.has(section));
  return { ok: true, value: { v: 1, groups: kept, placements: placed, rows: ordered, sections: order } };
}

/** The saved layout; the empty one when there is none yet, or it can't be read (it is never half-read). */
export function readSidebarGroups(path = sidebarGroupsPath()): SidebarGroups {
  try {
    const checked = validateSidebarGroups(JSON.parse(readFileSync(path, "utf8")));
    return checked.ok ? checked.value : EMPTY_SIDEBAR_GROUPS;
  } catch {
    return EMPTY_SIDEBAR_GROUPS;
  }
}

/** Saved whole, replaced atomically, readable by this user only. */
export function writeSidebarGroups(layout: SidebarGroups, path = sidebarGroupsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(layout, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed */ }
  }
}

/** Whether a layout says anything: an empty one isn't published, and an app then groups by folder alone. */
export function hasSidebarGroups(layout: SidebarGroups): boolean {
  return layout.groups.length > 0 || layout.sections.length > 0 || Object.keys(layout.rows).length > 0;
}

export interface SidebarGroupsRequest {
  kind: "sidebar-groups";
  layout: SidebarGroups;
}

/** The Mac app's whole layout after a change. Null for any other body. */
export function decodeSidebarGroupsRequest(body: unknown): SidebarGroupsRequest | { error: string } | null {
  if (!object(body) || body.kind !== "sidebar-groups") return null;
  const checked = validateSidebarGroups(body.layout);
  return checked.ok ? { kind: "sidebar-groups", layout: checked.value } : { error: checked.error };
}

// ---- Focus groups' priority, for the hand-off ----

/**
 * The session a family is placed by: itself, or the session above it (a subagent's, or the one that started it),
 * followed up while that one is on the list, as the Mac's `SessionGrouping.roots` has it. A child is drawn wherever
 * its head is, so its hand-off is the head's too. A cycle stops at the first id seen twice.
 */
export function familyHead(sessionId: string, parentOf: (sessionId: string) => string | undefined): string {
  const seen = new Set([sessionId]);
  let current = sessionId;
  for (let above = parentOf(current); above !== undefined && !seen.has(above); above = parentOf(current)) {
    seen.add(above);
    current = above;
  }
  return current;
}

/** Which tier a session is handed off in: its family's focus group's priority, else working. */
export function focusPriority(layout: SidebarGroups, sessionId: string, parentOf: (sessionId: string) => string | undefined = () => undefined): FocusPriority {
  const placed = layout.placements[familyHead(sessionId, parentOf)];
  if (placed === undefined) return "working";
  return layout.groups.find((group) => group.id === placed)?.priority ?? "working";
}

// ---- `conch agent groups`: an agent's edit, applied by the daemon ----

/** What `conch agent groups` asks the daemon: a list, or one change, applied to the layout the daemon holds. */
export type FocusGroupsRequest = { kind: "focus-groups" } & (
  | { action: "list" }
  | { action: "new"; name: string; priority?: FocusPriority }
  | { action: "rename"; group: string; name: string }
  | { action: "priority"; group: string; priority: FocusPriority }
  | { action: "add"; group: string; sessions: string[] }
  | { action: "remove"; sessions: string[] }
);

const FOCUS_ACTIONS = new Set(["list", "new", "rename", "priority", "add", "remove"]);

/** An agent's focus-group request, checked field by field. Null for any other body. */
export function decodeFocusGroupsRequest(body: unknown): FocusGroupsRequest | { error: string } | null {
  if (!object(body) || body.kind !== "focus-groups") return null;
  const { action } = body;
  if (typeof action !== "string" || !FOCUS_ACTIONS.has(action)) return { error: "action is list, new, rename, priority, add or remove" };
  const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
  const sessions = Array.isArray(body.sessions) && body.sessions.length > 0 && body.sessions.length <= SIDEBAR_LIMITS.rowsPerSection
    && body.sessions.every(sessionKey) ? [...new Set(body.sessions as string[])] : undefined;
  if (action === "list") return { kind: "focus-groups", action };
  if ((action === "new" || action === "rename") && !text(body.name, SIDEBAR_LIMITS.name)) return { error: `a focus group's name is 1–${SIDEBAR_LIMITS.name} printable characters` };
  if (action !== "new" && action !== "remove" && !text(body.group, SIDEBAR_LIMITS.id)) return { error: "group is a focus group's name or id" };
  if (action === "new") {
    if (body.priority !== undefined && !isFocusPriority(body.priority)) return { error: "priority is top, working or shelf" };
    return { kind: "focus-groups", action, name: body.name as string, ...(body.priority ? { priority: body.priority as FocusPriority } : {}) };
  }
  if (action === "rename") return { kind: "focus-groups", action, group: body.group as string, name: body.name as string };
  if (action === "priority") {
    if (!isFocusPriority(body.priority)) return { error: "priority is top, working or shelf" };
    return { kind: "focus-groups", action, group: body.group as string, priority: body.priority };
  }
  if (!sessions) return { error: "sessions is a list of session ids" };
  return action === "add" ? { kind: "focus-groups", action, group: body.group as string, sessions } : { kind: "focus-groups", action: "remove", sessions };
}

/** A group named by its id, or by its name in any case (names are one each, whatever the case). */
function findGroup(layout: SidebarGroups, ref: string): SidebarGroups["groups"][number] | undefined {
  const wanted = ref.trim();
  return layout.groups.find((group) => group.id === wanted) ?? layout.groups.find((group) => group.name.toLowerCase() === wanted.toLowerCase());
}

function noSuchGroup(layout: SidebarGroups, ref: string): { ok: false; error: string } {
  const names = layout.groups.map((group) => group.name);
  return { ok: false, error: `no focus group called ${JSON.stringify(ref.trim())}; ${names.length ? `there are ${names.join(", ")}` : "there are none yet (groups new makes one)"}` };
}

/**
 * One change from `conch agent groups`, applied to the layout the daemon holds; what it did, in a line, or why not.
 * The result is checked again as a save is (`validateSidebarGroups`) before it is kept.
 *
 * - **new**: at the top of the list, as the Mac's New focus group puts one, when the list has an order of its own;
 *   when it has none yet (`sections` empty: Tyler never arranged anything) it follows the folders, so the Mac's own
 *   folder order, which only it keeps until then, isn't replaced by one the daemon can't see.
 * - **add**: only a session at the top of its family, as the Mac moves only those; a subagent or a started session
 *   goes wherever the session above it goes (`headOf` names it). A session not running now may be placed, for when it
 *   is back, as the Mac keeps one's place.
 * - **remove**: back under its folder; one in no group is left as it is.
 */
export function editSidebarGroups(
  layout: SidebarGroups,
  request: Exclude<FocusGroupsRequest, { action: "list" }>,
  options: { newId(): string; headOf(sessionId: string): string },
): { ok: true; value: SidebarGroups; said: string } | { ok: false; error: string } {
  const next: SidebarGroups = { ...layout, groups: layout.groups.map((group) => ({ ...group })), placements: { ...layout.placements }, sections: [...layout.sections] };
  const nameProblem = (name: string, renaming?: string): string | undefined => {
    const trimmed = name.trim();
    const other = layout.groups.find((group) => group.id !== renaming && group.name.toLowerCase() === trimmed.toLowerCase());
    return other ? `there is already a focus group called ${other.name}` : undefined;
  };
  switch (request.action) {
    case "new": {
      const name = request.name.trim();
      const problem = nameProblem(name);
      if (problem) return { ok: false, error: problem };
      if (layout.groups.length >= SIDEBAR_LIMITS.groups) return { ok: false, error: `that's as many focus groups as conch keeps (${SIDEBAR_LIMITS.groups})` };
      const id = options.newId();
      const priority = request.priority && request.priority !== "working" ? request.priority : undefined;
      next.groups.push({ id, name, ...(priority ? { priority } : {}) });
      if (next.sections.length) next.sections.unshift(id);
      return { ok: true, value: next, said: `made ${name} (${request.priority ?? "working"})` };
    }
    case "rename": {
      const group = findGroup(next, request.group);
      if (!group) return noSuchGroup(layout, request.group);
      const name = request.name.trim();
      const problem = nameProblem(name, group.id);
      if (problem) return { ok: false, error: problem };
      const was = group.name;
      group.name = name;
      return { ok: true, value: next, said: `renamed ${was} to ${name}` };
    }
    case "priority": {
      const group = findGroup(next, request.group);
      if (!group) return noSuchGroup(layout, request.group);
      if (request.priority === "working") delete group.priority;
      else group.priority = request.priority;
      return { ok: true, value: next, said: `${group.name} is ${request.priority}` };
    }
    case "add": {
      const group = findGroup(next, request.group);
      if (!group) return noSuchGroup(layout, request.group);
      for (const session of request.sessions) {
        const head = options.headOf(session);
        if (head !== session) return { ok: false, error: `${session} goes with the session above it, ${head}: put that one in instead` };
      }
      for (const session of request.sessions) next.placements[session] = group.id;
      if (Object.keys(next.placements).length > SIDEBAR_LIMITS.placements) return { ok: false, error: `that's as many placements as conch keeps (${SIDEBAR_LIMITS.placements})` };
      return { ok: true, value: next, said: `put ${request.sessions.join(", ")} in ${group.name}` };
    }
    case "remove": {
      const out = request.sessions.filter((session) => next.placements[session] !== undefined);
      for (const session of out) delete next.placements[session];
      const stayed = request.sessions.filter((session) => !out.includes(session));
      return {
        ok: true,
        value: next,
        said: [out.length ? `took ${out.join(", ")} out of their focus groups` : "", stayed.length ? `${stayed.join(", ")} ${stayed.length === 1 ? "was" : "were"} in none` : ""].filter(Boolean).join("; "),
      };
    }
  }
}

/** One focus group as `conch agent groups` lists it: its running sessions by id and label, and how many others it holds. */
export interface FocusGroupListing {
  id: string;
  name: string;
  priority: FocusPriority;
  sessions: Array<{ id: string; label: string }>;
  notRunning: number;
}

/**
 * The focus groups in Tyler's order (the sidebar's sections, then any not placed in it), each with the sessions running
 * in it; and how many running sessions are in none, which are handed off as working. `running` is the live sessions at
 * the top of their families, as the sidebar lists them.
 */
export function listFocusGroups(layout: SidebarGroups, running: ReadonlyArray<{ id: string; label: string }>): { groups: FocusGroupListing[]; ungrouped: number } {
  const slot = new Map(layout.sections.map((section, index) => [section, index]));
  const ordered = [...layout.groups].sort((a, b) => (slot.get(a.id) ?? Infinity) - (slot.get(b.id) ?? Infinity));
  const live = new Set(running.map((session) => session.id));
  const groups = ordered.map((group) => {
    const placed = Object.entries(layout.placements).filter(([, id]) => id === group.id).map(([session]) => session);
    return {
      id: group.id,
      name: group.name,
      priority: group.priority ?? "working",
      sessions: running.filter((session) => layout.placements[session.id] === group.id),
      notRunning: placed.filter((session) => !live.has(session)).length,
    };
  });
  const grouped = new Set(layout.groups.map((group) => group.id));
  return { groups, ungrouped: running.filter((session) => !grouped.has(layout.placements[session.id] ?? "")).length };
}

/** How long `conch agent groups` waits for the daemon. An edit is a write of a small file; a list is a read. */
export const FOCUS_GROUPS_REPLY_MS = 5_000;

/** A `focus-groups` request and the daemon's one-line answer, over the socket. */
export function requestFocusGroups(
  socketPath: string,
  request: FocusGroupsRequest,
  timeoutMs = FOCUS_GROUPS_REPLY_MS,
): Promise<{ ok: true; reply: Record<string, unknown> } | { ok: false; reason: "daemon-down" | "no-reply" | "older"; diagnostic?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (result: Awaited<ReturnType<typeof requestFocusGroups>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: "timed out" }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(encodeControlFrame(JSON.stringify(request)));
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply = JSON.parse(line) as Record<string, unknown>;
        // A daemon from before focus groups reads the request as a malformed turn and says so (`session-error`).
        finish(object(reply) && (reply.kind === "focus-groups" || reply.kind === "focus-groups-error")
          ? { ok: true, reply }
          : { ok: false, reason: "older", diagnostic: "the daemon's answer wasn't a focus group's" });
      } catch (error) {
        finish({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: error.message }));
    socket.on("close", () => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down" }));
  });
}
