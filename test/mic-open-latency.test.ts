import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Pressing the composer's mic must open the mic, not narrate.
 *
 * Tyler: "clicking it turns it on (but it says reading first for some reason)".
 * It did. The wake announced "Mic open for <label>." before opening anything,
 * and while that plays the live state is `speaking`, which the composer renders
 * with the caption "reading" — the control you pressed to TALK reporting that
 * conch is reading to you. It also cost real time: the daemon log has the wake
 * at 22:56:45 and `listening` at 22:56:50, because TTS had fallen back to `say`.
 *
 * A dictation into the composer is a visual exchange — you clicked a mic beside
 * a text field and you are watching it. A voice wake still announces, because
 * there the speech IS the interface. So the discriminator is `compose`.
 */
test("a voice wake's courtesy line stays bounded, so a sick TTS cannot hold the mic shut", () => {
  // The composer half — no announcement, no cue — is executed in voice-loop.test.ts.
  // Waiting three seconds on a TTS that never returns is not worth a test run,
  // so the bound stays pinned as text, inside the guard it belongs to.
  const voice = read("src/voice-loop.ts");
  const at = voice.indexOf('log(`wake -> "${target.label}"');
  expect(at).toBeGreaterThan(-1);
  const wake = voice.slice(at);
  const end = wake.indexOf("conversationLoop(");
  expect(end).toBeGreaterThan(-1);
  const announce = wake.slice(0, end);
  const guardAt = announce.indexOf("if (!target.compose) {");
  expect(guardAt).toBeGreaterThan(-1);
  const guard = announce.slice(guardAt, announce.indexOf("\n        }", guardAt));
  expect(guard).toContain("Mic open for ${target.label}");
  expect(guard).toContain("Bun.sleep(3_000)");
});

/**
 * A stop that finds nothing to stop has to leave a trace.
 *
 * The socket path returned in silence, which makes a dead control look exactly
 * like a working one — and that is precisely why the dead mic button took two
 * reports to find. Note the asymmetry this guards: the physical key is a
 * toggle (`if (busy) stopReciting(...)` else it opens the mic), so only the
 * socket path can no-op at all.
 */
test("a stop with nothing running is logged, not swallowed", () => {
  const daemon = read("src/daemon.ts");
  const control = read("src/control-server.ts");
  const start = control.indexOf('if (event.type === "spacebar") {');
  expect(start).toBeGreaterThan(-1);
  const branch = control.slice(start);
  const end = branch.indexOf("\n  }");
  expect(end).toBeGreaterThan(-1);
  const body = branch.slice(0, end);
  expect(body).toContain("callbacks.droppedStop?.()");
  expect(daemon).toContain('droppedStop: () => log("stop arrived with nothing running — ignored")');
});

/**
 * The composer's mic reads and acts on ITS OWN row.
 *
 * It used to take the focused row's voice state — a value that can name a
 * different session than the composer it is drawn in. Whenever those differ the
 * button shows one session's state while its click addresses another's, which
 * is the same shape as the denylist that made it dead in manual mode: a control
 * that can disagree with itself about what pressing it does.
 */
test("the composer's mic is scoped to the row it belongs to", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const composer = dashboard.slice(dashboard.indexOf("private func composer(for row: SessionRow)"));
  const body = composer.slice(0, composer.indexOf("\n    }"));

  expect(body).toContain("voiceState: voiceState(for: row)");
  expect(body).toContain("LiveState.isExchangeActive(voiceState(for: row))");
  // The focused-row reading must not be what a per-row control consults.
  expect(body).not.toContain("voiceStateForFocusedRow");
});
