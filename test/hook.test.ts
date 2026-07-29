import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the internal-model recursion guard is the first hook action", () => {
  const source = readFileSync(join(import.meta.dir, "../src/hook.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function runHook"));
  const guard = body.indexOf("if (process.env.CONCH_INTERNAL) return");

  expect(guard).toBeGreaterThan(0);
  expect(guard).toBeLessThan(body.indexOf("Bun.stdin.stream()"));
  expect(guard).toBeLessThan(body.indexOf("findSession("));
  expect(guard).toBeLessThan(body.indexOf("sendToDaemon("));
  expect(guard).toBeLessThan(body.indexOf("await bell("));
  expect(guard).toBeLessThan(body.indexOf("await speak("));
});
