import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlApplication } from "../src/control-server.ts";
import type { ElsewhereRequest } from "../src/elsewhere.ts";
import {
  decodeSidebarGroupsRequest, EMPTY_SIDEBAR_GROUPS, hasSidebarGroups, readSidebarGroups, validateSidebarGroups, writeSidebarGroups,
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

test("what isn't a layout is refused with what was wrong", () => {
  const refused = (value: unknown) => { const checked = validateSidebarGroups(value); return checked.ok ? "" : checked.error; };
  expect(refused({ ...layout, v: 2 })).toContain("version 1");
  expect(refused({ ...layout, groups: [{ id: "harbor", name: "Harbor" }] })).toContain("id of its own");
  expect(refused({ ...layout, groups: [{ id: "group:a", name: "Same" }, { id: "group:b", name: "same" }] })).toContain("already a group");
  expect(refused({ ...layout, groups: [{ id: "group:a", name: "" }] })).toContain("printable");
  expect(refused({ ...layout, groups: [{ id: "group:a", name: "x".repeat(61) }] })).toContain("printable");
  expect(refused({ ...layout, sections: ["relative/path"] })).toContain("sections' order");
  expect(refused({ ...layout, rows: { "group:harbor": [7] } })).toContain("section's order");
  expect(refused({ ...layout, placements: Object.fromEntries(Array.from({ length: 2_001 }, (_, i) => [`s-${i}`, "group:site"])) })).toContain("2000");
});

test("the file is replaced whole, readable by this user only, and an unreadable one reads as empty", () => {
  const path = join(root, "conch", "sidebar-groups.json");
  expect(readSidebarGroups(path)).toEqual(EMPTY_SIDEBAR_GROUPS);
  const checked = validateSidebarGroups(layout);
  if (!checked.ok) throw new Error(checked.error);
  writeSidebarGroups(checked.value, path);
  expect(readSidebarGroups(path)).toEqual(checked.value);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
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

test("the socket saves a layout and acts on an agent, and says what was wrong with either", async () => {
  const socketPath = join(mkdtempSync("/tmp/conch-sidebar-"), "c.sock");
  const saved: unknown[] = [];
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
    sidebarGroups: { save: (layout) => { saved.push(layout); return { kind: "sidebar-groups", layout }; } },
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
    expect(await ask({ kind: "elsewhere", action: "resume", id: "claude:4927", host: "terminal" })).toEqual({ kind: "elsewhere-done", id: "claude:4927", resumed: true });
    expect(await ask({ kind: "elsewhere", action: "add-account", id: "claude:4927" })).toEqual({ kind: "elsewhere-error", error: "Only a Claude profile conch doesn't read can be added as an account." });
    expect(await ask({ kind: "elsewhere", action: "resume", id: "~/.claude" })).toMatchObject({ kind: "elsewhere-error" });
    expect(acted.map((one) => one.action)).toEqual(["resume", "add-account"]);
  } finally {
    await control.close();
    rmSync(join(socketPath, ".."), { recursive: true, force: true });
  }
});
