import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 */
export interface SidebarGroups {
  v: 1;
  /** His groups, by id (`group:…`) and the name he gave each. */
  groups: Array<{ id: string; name: string }>;
  /** Which group each session was put in, by session id. A session in none is under its folder. */
  placements: Record<string, string>;
  /** Each section's sessions in the order he dragged them, by section: a group's id or a folder's path. */
  rows: Record<string, string[]>;
  /** The sections' order: group ids and folder paths. Those never placed follow, as they arrive. */
  sections: string[];
}

export const EMPTY_SIDEBAR_GROUPS: SidebarGroups = { v: 1, groups: [], placements: {}, rows: {}, sections: [] };

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
  if (!Array.isArray(groups) || groups.length > SIDEBAR_LIMITS.groups) return { ok: false, error: `at most ${SIDEBAR_LIMITS.groups} groups` };
  const ids = new Set<string>();
  const names = new Set<string>();
  const kept: SidebarGroups["groups"] = [];
  for (const group of groups) {
    if (!object(group) || typeof group.id !== "string" || !GROUP_ID.test(group.id) || ids.has(group.id)) return { ok: false, error: "each group has an id of its own" };
    const name = typeof group.name === "string" ? group.name.trim() : "";
    if (!name || name.length > SIDEBAR_LIMITS.name || CONTROL.test(name)) return { ok: false, error: `a group's name is 1–${SIDEBAR_LIMITS.name} printable characters` };
    if (names.has(name.toLowerCase())) return { ok: false, error: `there is already a group called ${name}` };
    ids.add(group.id);
    names.add(name.toLowerCase());
    kept.push({ id: group.id, name });
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
