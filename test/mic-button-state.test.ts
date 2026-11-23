import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * The mic button sends `stop` for the states the app's `isExchangeActive` lists and opens the
 * mic for every other one. The daemon's state union and the app's list must agree: a new state
 * word in `panel.ts` that the app does not classify becomes a dead press (manual mode's `paused`
 * once sent a stop with nothing to stop).
 */
test("the app classifies every state the daemon publishes, and only those", () => {
  const panel = read("src/panel.ts").match(/export type PanelConchState =([^;]+);/);
  expect(panel).not.toBeNull();
  const daemon = [...panel![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  const models = read("mac-app/conch-mac/Models.swift").match(
    /static func isExchangeActive\(_ state: String\) -> Bool \{([\s\S]*?)\n {4}\}/,
  );
  expect(models).not.toBeNull();
  const stops = [...models![1].matchAll(/state == "([a-z]+)"/g)].map((m) => m[1]);
  for (const state of stops) expect(daemon).toContain(state);
  expect(daemon.filter((s) => !stops.includes(s)).sort()).toEqual(["idle", "muted", "paused"]);
});
