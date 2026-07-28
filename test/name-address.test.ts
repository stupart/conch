import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  resolveNameAddressRoute,
  type NameAddressRouteOptions,
} from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { SessionInfo } from "../src/sessions.ts";

const originalEvent = (): TurnEvent => ({
  type: "turn-end",
  sessionId: "origin",
  label: "origin-label",
  cwd: "/work/origin",
  pid: 101,
  announce: "origin-label: done",
  transcriptPath: "/transcripts/origin.jsonl",
  mark: 7,
});

const targetSession: SessionInfo = {
  sessionId: "target",
  name: "target",
  cwd: "/work/target",
  pid: 202,
  kind: "interactive",
  entrypoint: "cli",
};

function routeOptions(
  findSession: NameAddressRouteOptions["findSession"],
  transcriptCalls: string[] = [],
): NameAddressRouteOptions {
  return {
    findSession,
    labelFor: () => "target-label",
    transcriptFor(claudeDir, sessionId) {
      transcriptCalls.push(`${claudeDir}:${sessionId}`);
      return `/transcripts/${sessionId}.jsonl`;
    },
  };
}

describe("spoken name routing", () => {
  test("routes content to the first matching candidate with target metadata", async () => {
    const event = originalEvent();
    const before = { ...event };
    const lookups: string[] = [];
    const transcriptCalls: string[] = [];

    const route = await resolveNameAddressRoute(
      "/claude",
      event,
      "Hey Target ship it",
      routeOptions(async (_claudeDir, name) => {
        lookups.push(name);
        return name === "Target" ? targetSession : null;
      }, transcriptCalls),
    );

    expect(lookups).toEqual(["Target ship", "Target"]);
    expect(route).toEqual({
      kind: "deliver",
      addressed: { name: "Target", label: "target-label" },
      event: {
        ...event,
        sessionId: "target",
        label: "target-label",
        cwd: "/work/target",
        pid: 202,
        transcriptPath: "/transcripts/target.jsonl",
      },
      text: "ship it",
    });
    expect(route.kind === "deliver" && route.event).not.toBe(event);
    expect(transcriptCalls).toEqual(["/claude:target"]);
    expect(event).toEqual(before);
  });

  test("same-session address strips the prefix without replacing the held event", async () => {
    const event = originalEvent();
    const sameSession = { ...targetSession, sessionId: event.sessionId };
    const route = await resolveNameAddressRoute(
      "/claude",
      event,
      "hey origin-label, keep going",
      routeOptions(async () => sameSession),
    );

    expect(route.kind).toBe("deliver");
    if (route.kind !== "deliver") throw new Error("expected delivery route");
    expect(route.event).toBe(event);
    expect(route.text).toBe("keep going");
  });

  test("bare matching address becomes a clean targeted wake with no payload", async () => {
    const event = originalEvent();
    const route = await resolveNameAddressRoute(
      "/claude",
      event,
      "hey target.",
      routeOptions(async () => targetSession),
    );

    expect(route).toEqual({
      kind: "wake",
      addressed: { name: "target", label: "target-label" },
      event: {
        type: "wake",
        sessionId: "target",
        label: "target-label",
        cwd: "/work/target",
        pid: 202,
        announce: "",
        transcriptPath: "/transcripts/target.jsonl",
      },
    });
    expect(event).toEqual(originalEvent());
  });

  test("no match or lookup failure falls through byte-for-byte to normal delivery", async () => {
    const event = originalEvent();
    const text = "hey missing, keep every word.";
    const miss = await resolveNameAddressRoute(
      "/claude",
      event,
      text,
      routeOptions(async () => null),
    );
    const failure = await resolveNameAddressRoute(
      "/claude",
      event,
      text,
      routeOptions(async () => {
        throw new Error("registry unavailable");
      }),
    );

    expect(miss).toEqual({ kind: "deliver", event, text });
    expect(failure).toEqual({ kind: "deliver", event, text });
    expect(miss.kind === "deliver" && miss.event).toBe(event);
    expect(failure.kind === "deliver" && failure.event).toBe(event);
  });

  test("deliver guard applies the route before every target-dependent side effect", () => {
    const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    const deliver = source.slice(
      source.indexOf("async function deliver("),
      source.indexOf("/** Shared handling for anything heard while reading aloud"),
    );

    expect(deliver.indexOf("resolveNameAddressRoute(cfg.claudeDir, event, text)"))
      .toBeLessThan(deliver.indexOf("let committed = false"));
    expect(deliver).toContain("if (beforeInject && !(await beforeInject())) return false");
    expect(deliver).toContain("enqueue(addressed.event)");
    expect(deliver.indexOf("enqueue(addressed.event)"))
      .toBeLessThan(deliver.indexOf("let committed = false"));
    expect(deliver).toContain("event = addressed.event");
    expect(deliver).toContain("text = addressed.text");
    expect(deliver).toContain("markInjected(event.sessionId)");
    expect(deliver).toContain("const beforeCount = event.transcriptPath");
    expect(deliver).toContain("event.pid,\n      text,");
  });
});
