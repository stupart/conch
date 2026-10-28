import { expect, test } from "bun:test";
import { CodexTurnsSaid } from "../src/codex-threads.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";

test("a Codex turn is said once, whichever of its Stop hook and the rollout watch reports it first", () => {
  const said = new CodexTurnsSaid();
  expect(said.first("thread-a", "turn-1")).toBe(true);
  // The rollout watch, five seconds behind the hook, on the same turn.
  expect(said.first("thread-a", "turn-1")).toBe(false);
  expect(said.first("thread-b", "turn-1")).toBe(true);
  expect(said.first("thread-a", "turn-2")).toBe(true);
  expect(said.first("thread-a", "turn-2")).toBe(false);
});

test("the report that was said may come through again, as a dismissed session's held turn does when restored", () => {
  const said = new CodexTurnsSaid();
  const hook = { type: "turn-end" };
  expect(said.first("thread-a", "turn-1", hook)).toBe(true);
  expect(said.first("thread-a", "turn-1", hook)).toBe(true);
  // The rollout watch's own report of that turn is a second one.
  expect(said.first("thread-a", "turn-1", { type: "turn-end" })).toBe(false);
});

test("it remembers a bounded number of sessions, the longest quiet forgotten first", () => {
  const said = new CodexTurnsSaid(2);
  said.first("a", "1");
  said.first("b", "1");
  said.first("a", "2");
  said.first("c", "1");
  // "a" spoke since "b" did, so it is still remembered; "b" was the quietest, forgotten, and its turn would be said again
  // rather than never.
  expect(said.first("a", "2")).toBe(false);
  expect(said.first("c", "1")).toBe(false);
  expect(said.first("b", "1")).toBe(true);
});

test("a turn id crosses the socket on a turn-end only, and only shaped as an id", () => {
  const event = { type: "turn-end", sessionId: "s", label: "l", announce: "a" };
  expect(validateSocketTurnEvent({ ...event, turnId: "01a16ae2-32a5-7261-848c-1986bafd1e96" }).ok).toBe(true);
  expect(validateSocketTurnEvent({ ...event, turnId: "two words" }).ok).toBe(false);
  expect(validateSocketTurnEvent({ ...event, turnId: 7 }).ok).toBe(false);
  expect(validateSocketTurnEvent({ ...event, turnId: "x".repeat(129) }).ok).toBe(false);
  expect(validateSocketTurnEvent({ ...event, type: "working", turnId: "turn-1" }).ok).toBe(false);
});
