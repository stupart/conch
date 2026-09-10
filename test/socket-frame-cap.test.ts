import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

/**
 * The frame cap has to see the chunk it is capping.
 *
 * It ran on the buffer BEFORE the incoming chunk was appended, so one
 * oversized chunk that ended in a newline was appended and parsed anyway; the
 * cap only ever caught a slow drip. This is a trust boundary — anything can
 * connect to the socket — so the order is asserted, with presence first.
 */
test("the socket frame cap checks the buffer after appending the chunk", () => {
  const at = daemon.indexOf("A peer that never sends a newline");
  expect(at).toBeGreaterThan(-1);
  const block = daemon.slice(at, at + 900);
  const append = block.indexOf("buf += data.toString();");
  const cap = block.indexOf("if (buf.length > 64_000) {");
  expect(append).toBeGreaterThan(-1);
  expect(cap).toBeGreaterThan(-1);
  expect(append).toBeLessThan(cap);
});
