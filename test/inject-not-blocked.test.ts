import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Answering one session must not wait for another to stop talking.
 *
 * The queue drains one event at a time, which is right for anything that
 * speaks — two turns talking over each other is unusable. But an inject and an
 * interrupt make no sound, and both are someone waiting with a finger still on
 * the key. Behind the barrier they inherited the full length of an unrelated
 * session's spoken announcement, which Tyler read, correctly, as the sessions
 * blocking each other.
 */
describe("silent user actions bypass the audio barrier", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  test("inject and interrupt are handled immediately", () => {
    const guard = source.slice(source.indexOf("if (!eventOrder.accept(event)) return;"));
    const window = guard.slice(0, 1600);
    expect(window).toContain('event.type === "inject" || event.type === "interrupt"');
    expect(window).toContain("immediate ");
  });

  // The exemption holds only while these stay silent. Anything that speaks
  // must go back through the queue or it will talk over another session.
  test("nothing that speaks is exempted", () => {
    const guard = source.slice(source.indexOf("if (!eventOrder.accept(event)) return;"));
    const branch = guard.slice(0, guard.indexOf("const forgetOnArrival"));
    for (const speaking of ["turn-end", "needs-you", "recite", "speak"]) {
      expect(branch).not.toContain(`"${speaking}"`);
    }
  });

  // Sending is itself the interruption: you have moved on, and no answer to the
  // previous turn is worth hearing over your own next question.
  test("sending a message stops whatever is being read", () => {
    const handler = source.slice(source.indexOf('if (event.type === "inject") {'));
    expect(handler.slice(0, 1200)).toContain("speech.cancelCurrent()");
  });
});

describe("conch never talks over you", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  // conch has always guarded the other direction — the mic must not open while
  // TTS is speaking, or the loop hears itself. Nothing stopped speech STARTING
  // while a mic was already open: Tyler was mid-dictation when another
  // session's turn ended and conch read it over the top of him.
  test("speech does not start while a mic is open", () => {
    const speak = source.slice(source.indexOf("const speak = async ("));
    const body = speak.slice(0, speak.indexOf("await speech.speak("));
    expect(body).toContain("normalMicOpen()");
    // Before the state is set, or the dashboard claims to be reading while silent.
    expect(body.indexOf("normalMicOpen()")).toBeLessThan(body.indexOf('setState("speaking"'));
  });
});
