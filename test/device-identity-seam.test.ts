import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPublishedState, refreshPublishedConversationState, type PanelModel } from "../src/panel.ts";

const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("daemon loads identity before publication and passes that id to both boundaries", () => {
  const daemon = source("src/daemon.ts");
  const run = daemon.indexOf("export async function runDaemon(");
  const load = daemon.indexOf("const ownerDeviceId = await loadDeviceId(dirname(daemonSettingsPath), log);", run);
  const settings = daemon.indexOf("const daemonSettingsPath = settingsPathFor();", run);
  const publish = daemon.indexOf("lastPublishedPanelState = buildDaemonPublishedState(", run);
  const server = daemon.indexOf("const controlServer = createControlServer({", run);
  // Presence first: a missing marker is -1 and would otherwise pass ordering.
  for (const position of [run, load, settings, publish, server]) expect(position).toBeGreaterThan(-1);
  expect(settings).toBeLessThan(load);
  expect(load).toBeLessThan(publish);
  expect(load).toBeLessThan(server);
  expect(daemon.slice(server, daemon.indexOf("\n  });", server))).toContain("    ownerDeviceId,");
  expect(daemon.slice(publish, publish + 120)).toContain("        ownerDeviceId,");
  const builder = daemon.slice(daemon.indexOf("export function buildDaemonPublishedState("), run);
  expect(builder).toContain("return buildPublishedState(\n    ownerDeviceId,");
});

test("publisher declares and emits ownerDeviceId", () => {
  const panel = source("src/panel.ts");
  const declaration = panel.slice(panel.indexOf("export interface PublishedState {"));
  expect(declaration).toContain("ownerDeviceId: string;");
  const builder = panel.slice(panel.indexOf("export function buildPublishedState("));
  expect(builder).toContain("    ownerDeviceId,");
});

test("complete documents retain their owner through empty rows and live refreshes", () => {
  const model: PanelModel = {
    rows: [], mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "", partial: "" }, reply: null, panelOpen: false,
  };
  const initial = buildPublishedState("owner-a", model, new Map(), new Set(["dismissed#12"]), 1);
  expect(initial.ownerDeviceId).toBe("owner-a");
  expect(initial.rows).toEqual([]);
  const next = refreshPublishedConversationState(initial, model.live, null, 2);
  expect(next.ownerDeviceId).toBe("owner-a");
  expect(next.dismissed).toEqual(["dismissed#12"]);
});

test.each([
  ["Mac", "mac-app/conch-mac/Models.swift", "container"],
  ["iOS", "mobile/conch-ios/conch-ios/Models.swift", "c"],
])("%s model decodes optional owner identity with an empty default", (_name, path, container) => {
  const models = source(path!);
  expect(models).toMatch(/(?:let ownerDeviceId: String|var ownerDeviceId = "")/);
  expect(models).toMatch(/case [^\n]*\bownerDeviceId\b/);
  expect(models).toContain(`ownerDeviceId = (try? ${container}.decodeIfPresent(String.self, forKey: .ownerDeviceId)) ?? ""`);
});

test("Mac snapshot reconstruction and comparison preserve owner changes", () => {
  expect(source("mac-app/conch-mac/StateStore.swift")).toContain("ownerDeviceId: sourceState.ownerDeviceId,");
  const models = source("mac-app/conch-mac/Models.swift");
  expect(models).toContain("self.ownerDeviceId = ownerDeviceId");
  expect(models.slice(models.indexOf("func hasSamePresentation"))).toContain("ownerDeviceId == other.ownerDeviceId");
});
