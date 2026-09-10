import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pane = readFileSync(join(root, "mac-app", "conch-mac", "PairingView.swift"), "utf8");
const daemon = readFileSync(join(root, "src", "daemon.ts"), "utf8");

/**
 * The pairing tab must show the daemon's refusal, not "Could not read the
 * daemon's pairing reply".
 *
 * A fresh install has `phone` off, so `open-pairing` answers with a
 * `session-error` — a different shape from a pairing. The tab decoded only the
 * pairing shape, so the one reply every new machine gets was reported as a
 * decode failure, over text that said exactly what to do (2026-09-10, the new
 * laptop). The refusal is an ordinary outcome and must read as one.
 */
test("the pairing tab shows a session-error's text verbatim", () => {
  const open = pane.slice(pane.indexOf("func open(force: Bool = false) async {"));
  const body = open.slice(0, open.indexOf("\n    }\n"));
  expect(body).toContain("JSONDecoder().decode(ConchSessionError.self, from: data)");
  expect(body).toContain('refusal.kind == "session-error"');
  expect(body).toContain("self.error = refusal.error");
  // ...and the generic message stays for replies that are neither shape.
  expect(body).toContain('self.error = "Could not read the daemon\'s pairing reply."');
});

/**
 * Because the tab shows it verbatim, the daemon's refusal is the remedy. It
 * names the setting and the command, so neither the app nor `conch pair`
 * (which prints the same text) leaves someone at a dead end.
 */
test("the daemon's bridge-off refusal names the phone setting and the fix", () => {
  const handler = daemon.slice(daemon.indexOf('.kind === "open-pairing"'));
  const refusal = handler.slice(0, handler.indexOf("} else {"));
  expect(refusal).toContain('kind: "session-error"');
  expect(refusal).toContain('Turn on \\"phone\\" in Settings');
  expect(refusal).toContain("conch set phone true");
});

/**
 * The no-relay copy must point at a place that exists. It said "Advanced",
 * a tab renamed to "Settings" — and names the setting and the command, since
 * the relay URL is the second thing a fresh machine lacks.
 */
test("the no-relay copy names the setting, the tab that exists, and the command", () => {
  const section = pane.slice(pane.indexOf("private var noRelaySection"));
  const body = section.slice(0, section.indexOf("\n    }\n"));
  expect(body).toContain("phone-relay-url in Settings");
  expect(body).toContain("conch set phone-relay-url https://<worker>.workers.dev");
  expect(body).not.toContain("Advanced");
});
