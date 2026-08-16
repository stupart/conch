import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The phone must survive being backgrounded.
 *
 * Backgrounding stops the transport on purpose — an idle socket the Mac
 * expires costs an encrypted handshake on every return, and 496 of those
 * turned up in one day's log. Foregrounding calls reconnectNow(). But both
 * transports refused to reconnect after a stop, so the FIRST background
 * disconnected the phone until it was relaunched or re-paired. A Codex audit
 * of all three surfaces found it; it had shipped hours earlier as a fix.
 */
describe("a stopped transport can be revived", () => {
  const root = new URL("../mobile/conch-ios/conch-ios/", import.meta.url);

  for (const file of ["DirectHTTPTransport.swift", "RelayTransport.swift"]) {
    test(`${file} reconnects after stop`, () => {
      // The LAST declaration, because these types split a protocol, a thin
      // wrapper and the actor that does the work — and only the last one has a
      // body. `stop()` keeps its own `guard !stopped`, which is correct: a
      // second stop should do nothing.
      const source = readFileSync(new URL(file, root), "utf8");
      const body = source.slice(source.lastIndexOf("func reconnectNow()"), source.length)
        .slice(0, 900);
      expect(body).not.toContain("guard !stopped");
      // An explicit reconnect means "be running again".
      expect(body).toContain("stopped = false");
    });
  }
});
