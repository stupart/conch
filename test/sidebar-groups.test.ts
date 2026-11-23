import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlApplication } from "../src/control-server.ts";
import type { ElsewhereRequest } from "../src/elsewhere.ts";
import {
  decodeFocusGroupsRequest, decodeSidebarGroupsRequest, editSidebarGroups, EMPTY_SIDEBAR_GROUPS, focusPriority, hasSidebarGroups,
  listFocusGroups, readSidebarGroups, validateSidebarGroups, writeSidebarGroups, type SidebarGroups,
} from "../src/sidebar-groups.ts";

// 2026-11-12, Tyler: "would also love to drag and drop for organization." His groups, which session is in which, and the
// order he dragged things into, owned by the daemon and published so the phone shows the same list.

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "conch-sidebar-groups-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const layout = {
  v: 1,
  groups: [{ id: "group:harbor", name: " Harbor " }, { id: "group:site", name: "Site" }],
  placements: { "s-1": "group:harbor", "s-2": "group:site" },
  rows: { "group:harbor": ["s-3", "s-1", "s-1"], "/Users/me/Projects/conch": ["s-4", "s-5"] },
  sections: ["group:site", "/Users/me/Projects/conch", "group:harbor", "group:site"],
};

test("a layout is checked field by field and saved as sent, trimmed and without repeats", () => {
  const checked = validateSidebarGroups(layout);
  expect(checked).toEqual({ ok: true, value: {
    v: 1,
    groups: [{ id: "group:harbor", name: "Harbor" }, { id: "group:site", name: "Site" }],
    placements: { "s-1": "group:harbor", "s-2": "group:site" },
    rows: { "group:harbor": ["s-3", "s-1"], "/Users/me/Projects/conch": ["s-4", "s-5"] },
    sections: ["group:site", "/Users/me/Projects/conch", "group:harbor"],
  } });
});

test("a group deleted in the same change takes its placements, order and slot with it", () => {
  const checked = validateSidebarGroups({ ...layout, groups: [{ id: "group:site", name: "Site" }] });
  expect(checked.ok && checked.value).toEqual({
    v: 1, groups: [{ id: "group:site", name: "Site" }], placements: { "s-2": "group:site" },
    rows: { "/Users/me/Projects/conch": ["s-4", "s-5"] }, sections: ["group:site", "/Users/me/Projects/conch"],
  });
});

test("what isn't a layout is refused", () => {
  for (const value of [
    { ...layout, v: 2 },
    { ...layout, groups: [{ id: "harbor", name: "Harbor" }] },
    { ...layout, groups: [{ id: "group:a", name: "Same" }, { id: "group:b", name: "same" }] },
    { ...layout, groups: [{ id: "group:a", name: "" }] },
    { ...layout, groups: [{ id: "group:a", name: "x".repeat(61) }] },
    { ...layout, sections: ["relative/path"] },
    { ...layout, rows: { "group:harbor": [7] } },
    { ...layout, placements: Object.fromEntries(Array.from({ length: 2_001 }, (_, i) => [`s-${i}`, "group:site"])) },
  ]) {
    expect(validateSidebarGroups(value).ok).toBe(false);
  }
});

test("the file is replaced whole, readable by this user only, and an unreadable one reads as empty", () => {
  const path = join(root, "conch", "sidebar-groups.json");
  expect(readSidebarGroups(path)).toEqual(EMPTY_SIDEBAR_GROUPS);
  const checked = validateSidebarGroups(layout);
  if (!checked.ok) throw new Error(checked.error);
  writeSidebarGroups(checked.value, path);
  expect(readSidebarGroups(path)).toEqual(checked.value);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  writeFileSync(path, "{ torn");
  expect(readSidebarGroups(path)).toEqual(EMPTY_SIDEBAR_GROUPS);
});

test("an empty layout isn't published; the request carries the whole layout", () => {
  expect(hasSidebarGroups(EMPTY_SIDEBAR_GROUPS)).toBe(false);
  expect(hasSidebarGroups({ ...EMPTY_SIDEBAR_GROUPS, sections: ["/a"] })).toBe(true);
  expect(decodeSidebarGroupsRequest({ kind: "sidebar-groups", layout })).toMatchObject({ kind: "sidebar-groups", layout: { v: 1 } });
  expect(decodeSidebarGroupsRequest({ kind: "sidebar-groups", layout: { v: 1 } })).toHaveProperty("error");
  expect(decodeSidebarGroupsRequest({ kind: "elsewhere" })).toBeNull();
});

// 2026-11-23, Tyler: "i can have certain ones have different priorities like "top" "working" "shelf" and in that case it
// would always return me to any top ones first and then working if all top is busy". His groups are focus groups now.

test("a focus group's priority is kept unless it is working, the default; one this daemon doesn't know reads as working", () => {
  const checked = validateSidebarGroups({
    ...layout,
    groups: [{ id: "group:harbor", name: "Harbor", priority: "top" }, { id: "group:site", name: "Site", priority: "working" }, { id: "group:later", name: "Later", priority: "urgent" }],
  });
  expect(checked.ok && checked.value.groups).toEqual([
    { id: "group:harbor", name: "Harbor", priority: "top" },
    { id: "group:site", name: "Site" },
    { id: "group:later", name: "Later" },
  ]);
});

const focus: SidebarGroups = {
  v: 1,
  groups: [{ id: "group:top", name: "Ship", priority: "top" }, { id: "group:mid", name: "Harbor" }, { id: "group:shelf", name: "Later", priority: "shelf" }],
  placements: { lead: "group:top", parked: "group:shelf", plain: "group:mid", stale: "group:gone" },
  rows: {},
  sections: ["/Users/me/Projects/conch", "group:shelf", "group:top"],
};

test("a session's tier is its family's focus group's priority; in no group, or one since deleted, it is working", () => {
  // `helper` was started by `lead`, and `agent` is helper's subagent: both are drawn under lead, in its group.
  const above: Record<string, string> = { helper: "lead", agent: "helper" };
  const parentOf = (id: string) => above[id];
  expect(["lead", "agent", "parked", "plain", "loose", "stale"].map((id) => focusPriority(focus, id, parentOf)))
    .toEqual(["top", "top", "shelf", "working", "working", "working"]);
});

test("an agent's change: a new group, a rename, a priority, a session in and out, each said in a line", () => {
  const edit = (layout: SidebarGroups, request: Parameters<typeof editSidebarGroups>[1]) =>
    editSidebarGroups(layout, request, { newId: () => "group:new", headOf: (id) => (id === "helper" ? "lead" : id) });
  const made = edit(focus, { kind: "focus-groups", action: "new", name: " Site ", priority: "shelf" });
  expect(made).toEqual({ ok: true, said: "made Site (shelf)", value: {
    ...focus,
    groups: [...focus.groups, { id: "group:new", name: "Site", priority: "shelf" }],
    // At the top of a list that has an order of its own, as the Mac's New focus group puts one.
    sections: ["group:new", "/Users/me/Projects/conch", "group:shelf", "group:top"],
  } });
  // A list never arranged keeps no order for the daemon to replace: the Mac's own folder order still stands.
  expect(edit({ ...focus, sections: [] }, { kind: "focus-groups", action: "new", name: "Site" })).toMatchObject({ ok: true, said: "made Site (working)", value: { sections: [] } });
  expect(edit(focus, { kind: "focus-groups", action: "rename", group: "harbor", name: "Harbor site" })).toMatchObject({ ok: true, value: { groups: [focus.groups[0], { id: "group:mid", name: "Harbor site" }, focus.groups[2]] } });
  expect(edit(focus, { kind: "focus-groups", action: "priority", group: "group:top", priority: "working" })).toMatchObject({ ok: true, said: "Ship is working", value: { groups: [{ id: "group:top", name: "Ship" }, focus.groups[1], focus.groups[2]] } });
  expect(edit(focus, { kind: "focus-groups", action: "add", group: "Later", sessions: ["plain", "new-one"] })).toMatchObject({ ok: true, value: { placements: { lead: "group:top", parked: "group:shelf", plain: "group:shelf", "new-one": "group:shelf", stale: "group:gone" } } });
  const out = edit(focus, { kind: "focus-groups", action: "remove", sessions: ["parked", "loose"] });
  expect(out).toEqual({ ok: true, said: "took parked out of their focus groups; loose was in none", value: { ...focus, placements: { lead: "group:top", plain: "group:mid", stale: "group:gone" } } });
});

test("an agent's change that can't be made says why: a group no one has, a name taken, a session that goes with another", () => {
  const edit = (request: Parameters<typeof editSidebarGroups>[1]) =>
    editSidebarGroups(focus, request, { newId: () => "group:new", headOf: (id) => (id === "helper" ? "lead" : id) });
  expect(edit({ kind: "focus-groups", action: "priority", group: "Nowhere", priority: "top" })).toEqual({ ok: false, error: "no focus group called \"Nowhere\"; there are Ship, Harbor, Later" });
  expect(edit({ kind: "focus-groups", action: "new", name: "ship" })).toEqual({ ok: false, error: "there is already a focus group called Ship" });
  expect(edit({ kind: "focus-groups", action: "rename", group: "Ship", name: "SHIP" })).toMatchObject({ ok: true });
  expect(edit({ kind: "focus-groups", action: "add", group: "Ship", sessions: ["helper"] })).toEqual({ ok: false, error: "helper goes with the session above it, lead: put that one in instead" });
  for (const body of [
    { kind: "focus-groups", action: "delete", group: "Ship" },
    { kind: "focus-groups", action: "new", name: "" },
    { kind: "focus-groups", action: "new", name: "Site", priority: "urgent" },
    { kind: "focus-groups", action: "add", group: "Ship", sessions: [] },
    { kind: "focus-groups", action: "remove", sessions: ["a\u0007b"] },
  ]) {
    expect(decodeFocusGroupsRequest(body)).toHaveProperty("error");
  }
  expect(decodeFocusGroupsRequest({ kind: "sidebar-groups" })).toBeNull();
});

test("the list is the groups in his order, each with its running sessions, and how many run in none", () => {
  const running = [{ id: "lead", label: "Ship it" }, { id: "plain", label: "Docs" }, { id: "loose", label: "Scratch" }];
  expect(listFocusGroups(focus, running)).toEqual({
    groups: [
      { id: "group:shelf", name: "Later", priority: "shelf", sessions: [], notRunning: 1 },
      { id: "group:top", name: "Ship", priority: "top", sessions: [{ id: "lead", label: "Ship it" }], notRunning: 0 },
      // Not in the sections' order yet: it follows, as the sidebar draws it.
      { id: "group:mid", name: "Harbor", priority: "working", sessions: [{ id: "plain", label: "Docs" }], notRunning: 0 },
    ],
    ungrouped: 1,
  });
});

test("the socket saves a layout and acts on an agent, and says what was wrong with either", async () => {
  const socketPath = join(mkdtempSync("/tmp/conch-sidebar-"), "c.sock");
  const saved: unknown[] = [];
  const edits: unknown[] = [];
  const acted: ElsewhereRequest[] = [];
  const application: ControlApplication = {
    configuration: () => ({ kind: "config-error", error: "stub" }),
    session: () => ({ kind: "session-error", error: "stub" }),
    runtime: () => ({ kind: "app-error-ack" }),
    turn: () => {},
    device: () => ({ kind: "ack" }),
  };
  const control = createControlServer({
    socketPath, ownerDeviceId: "this-mac", log: () => {}, application,
    sessions: { resolve: (value) => value, current: () => ({ published: false }) },
    sidebarGroups: {
      save: (layout) => { saved.push(layout); return { kind: "sidebar-groups", layout }; },
      edit: (request) => { edits.push(request); return { kind: "focus-groups", done: "made Harbor (top)", groups: [], ungrouped: 0 }; },
    },
    elsewhere: { act: async (request) => { acted.push(request); if (request.action === "add-account") throw new Error("Only a Claude profile conch doesn't read can be added as an account."); return { kind: "elsewhere-done", id: request.id, resumed: true }; } },
  });
  expect(await control.start()).toBe(true);
  const ask = (body: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(socketPath, () => socket.write(`${JSON.stringify(body)}\n`));
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
  });
  try {
    expect(await ask({ kind: "sidebar-groups", layout })).toMatchObject({ kind: "sidebar-groups", layout: { groups: [{ name: "Harbor" }, { name: "Site" }] } });
    expect(saved).toHaveLength(1);
    expect(await ask({ kind: "sidebar-groups", layout: { v: 1 } })).toMatchObject({ kind: "sidebar-groups-error" });
    expect(saved).toHaveLength(1);
    // An agent's focus-group change (`conch agent groups`), checked before the daemon sees it.
    expect(await ask({ kind: "focus-groups", action: "new", name: "Harbor", priority: "top" })).toEqual({ kind: "focus-groups", done: "made Harbor (top)", groups: [], ungrouped: 0 });
    expect(await ask({ kind: "focus-groups", action: "priority", group: "Harbor", priority: "urgent" })).toEqual({ kind: "focus-groups-error", error: "priority is top, working or shelf" });
    expect(edits).toEqual([{ kind: "focus-groups", action: "new", name: "Harbor", priority: "top" }]);
    expect(await ask({ kind: "elsewhere", action: "resume", id: "claude:4927", host: "terminal" })).toEqual({ kind: "elsewhere-done", id: "claude:4927", resumed: true });
    expect(await ask({ kind: "elsewhere", action: "add-account", id: "claude:4927" })).toEqual({ kind: "elsewhere-error", error: "Only a Claude profile conch doesn't read can be added as an account." });
    expect(await ask({ kind: "elsewhere", action: "resume", id: "~/.claude" })).toMatchObject({ kind: "elsewhere-error" });
    expect(acted.map((one) => one.action)).toEqual(["resume", "add-account"]);
  } finally {
    await control.close();
    rmSync(join(socketPath, ".."), { recursive: true, force: true });
  }
});
