import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * The mic button's one job: press it when the mic is shut and the mic opens.
 *
 * It asked "is the state neither empty nor `idle`?" and sent `stop` for
 * everything else — so in manual mode, where the daemon publishes `paused`,
 * the button sent a stop that had nothing to stop. Tyler: "looks like the
 * microphone button is broken on the mac app? I just tried pressing ti and
 * nothing happened." Nothing happened is exactly right, and stopping is
 * silent, so it left no line in the daemon log to find it by.
 *
 * The daemon's vocabulary is the thing that decides this, so the test reads
 * BOTH sides: every state the daemon can publish, and the allowlist the app
 * actually branches on. A new state word in `panel.ts` fails here rather than
 * quietly becoming another dead press.
 */

/** Every state the daemon can publish, from the union type that defines them. */
function daemonStates(): string[] {
  const panel = read("src/panel.ts");
  const line = panel.match(/export type PanelConchState =([^;]+);/);
  expect(line).not.toBeNull();
  const states = [...line![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  expect(states.length).toBeGreaterThan(0);
  return states;
}

/** The states the app treats as "something is running that a press stops". */
function appStopsOn(): string[] {
  const models = read("mac-app/conch-mac/Models.swift");
  const fn = models.match(
    /static func isExchangeActive\(_ state: String\) -> Bool \{([\s\S]*?)\n {4}\}/,
  );
  expect(fn).not.toBeNull();
  return [...fn![1].matchAll(/state == "([a-z]+)"/g)].map((m) => m[1]);
}

test("a press while the mic is shut opens it, in every resting state", () => {
  const stops = appStopsOn();

  // The three ways of being at rest. `paused` is manual mode and `muted` is
  // the mic switched off — in both the mic is shut, so a press must OPEN it.
  // These are the two the old denylist got wrong.
  for (const resting of ["idle", "paused", "muted"]) {
    expect(daemonStates()).toContain(resting);
    expect(stops).not.toContain(resting);
  }

  // ...and the states where something really is running still stop it.
  for (const active of ["listening", "recording", "transcribing", "speaking"]) {
    expect(stops).toContain(active);
  }

  // Nothing invented: the app must not classify a word the daemon never sends.
  for (const state of stops) expect(daemonStates()).toContain(state);
});

test("every state the daemon publishes is classified by the app", () => {
  const stops = new Set(appStopsOn());
  // Anything not on the stop list falls through to "the mic is closed, open
  // it". That default is only safe while it is deliberate, so a new state has
  // to be looked at here rather than inheriting whichever branch it lands in.
  const resting = daemonStates().filter((s) => !stops.has(s));
  expect(resting.sort()).toEqual(["idle", "muted", "paused"]);
});

test("the button asks the shared predicate, not its own inline guess", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  // Scoped to the composer's own row, not the focused one — see
  // "the composer's mic is scoped to the row it belongs to".
  expect(dashboard).toContain("if LiveState.isExchangeActive(voiceState(for: row)) {");
  // The denylist that caused this, in either spelling.
  expect(dashboard).not.toContain('voiceStateForFocusedRow.isEmpty || voiceStateForFocusedRow == "idle"');

  // One vocabulary, one place. The instance property must route through the
  // same function the button calls, or they can drift apart again.
  const models = read("mac-app/conch-mac/Models.swift");
  expect(models).toContain("var isExchangeActive: Bool {\n        Self.isExchangeActive(state)");
});
