import { describe, expect, test } from "bun:test";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";

/**
 * A redundant state frame is not free.
 *
 * The phone decodes every frame as a COMPLETE state on the main actor and
 * republishes it, invalidating the whole view tree and rebuilding every
 * markdown body on screen. A Codex audit measured the live snapshot at ~112KB
 * across six conversations, publishable at up to 10Hz — so re-sending an
 * identical frame is a full re-render of a busy screen for no new information.
 */
describe("state frames", () => {
  const app = (getState: () => unknown) => {
    const sent: string[] = [];
    const application = createPhoneBridgeApplication(
      {
        log: () => {},
        getState,
        replyFor: async () => "",
        forwardControl: async () => "{}",
      } as any,
      { token: "t" },
    );
    application.subscribeState({ send: (data: string) => (sent.push(data), 1) });
    return { application, sent };
  };

  test("an unchanged state is sent once, not on every publish", () => {
    const { application, sent } = app(() => ({ v: 1, ts: 100, rows: [{ id: "a" }] }));
    application.publish();
    application.publish();
    application.publish();
    expect(sent.length).toBe(1);
  });

  // The timestamp moves on every publish by definition; comparing it would
  // defeat the check entirely.
  test("a moving timestamp alone is not a change", () => {
    let ts = 0;
    const { application, sent } = app(() => ({ v: 1, ts: (ts += 100), rows: [{ id: "a" }] }));
    application.publish();
    application.publish();
    expect(sent.length).toBe(1);
  });

  test("anything a viewer could see moving is still sent", () => {
    let status = "working";
    const { application, sent } = app(() => ({ v: 1, ts: 1, rows: [{ id: "a", status }] }));
    application.publish();
    status = "waiting";
    application.publish();
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("waiting");
  });
});
