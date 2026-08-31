import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const store = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "StateStore.swift"),
  "utf8",
);

/**
 * One slow control must not swallow every press behind it.
 *
 * Controls are chained deliberately — each send opens its own socket, so
 * without ordering a stop could overtake the wake it was meant to end. The bug
 * was that the wait had no limit. The daemon log caught it exactly: a stop
 * pressed at ~19:13:56 and another at 19:14:15 both arrived in the SAME second,
 * nineteen seconds after the first press, with "it didn't stop listening after
 * I pressed so I'm pressing it again" transcribed in between — spoken into a
 * mic still open because the stop was still queued.
 *
 * A healthy send over a unix socket is sub-millisecond, so a quarter second is
 * far longer than ordering needs and still imperceptible when it is spent.
 */
test("a control waits for the previous delivery, but not forever", () => {
  const send = store.slice(store.indexOf("func send(_ event: ConchDaemonEvent)"));
  const body = send.slice(0, send.indexOf("\n    }"));

  expect(body).toContain("await Self.awaitDelivery(previousDelivery, within: .milliseconds(250))");
  // The unbounded form is the bug, in either spelling.
  expect(body).not.toContain("_ = await previousDelivery?.value");
  expect(body).not.toContain("await previousDelivery!.value");
});

/**
 * The bound must not cancel the delivery it stopped waiting for.
 *
 * Cancelling would turn "this press is late" into "this press never happened",
 * which is the failure it exists to prevent, one step further along.
 */
test("giving up on the wait does not abandon the send", () => {
  const helper = store.slice(store.indexOf("private static func awaitDelivery("));
  const body = helper.slice(0, helper.indexOf("\n    }\n"));

  // Raced, not cancelled: the delivery task itself is never touched.
  expect(body).toContain("group.addTask { _ = await delivery.value }");
  expect(body).toContain("Task.sleep(for: timeout)");
  expect(body).not.toContain("delivery.cancel()");
});
