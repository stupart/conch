import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the internal-model recursion guard is the first hook action", () => {
  const source = readFileSync(join(import.meta.dir, "../src/hook.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function runHook"));
  const guard = body.indexOf("if (process.env.CONCH_INTERNAL) return");

  expect(guard).toBeGreaterThan(0);
  expect(guard).toBeLessThan(body.indexOf("Bun.stdin.stream()"));
  expect(guard).toBeLessThan(body.indexOf("findHookWindow("));
  expect(guard).toBeLessThan(body.indexOf("sendToDaemon("));
  expect(guard).toBeLessThan(body.indexOf("await bell("));
  expect(guard).toBeLessThan(body.indexOf("await speak("));
});

test("a daemonless hook checks manual mode before it speaks for itself", () => {
  // With no daemon, the hook falls back to announcing the turn itself — and
  // manual mode lived only in the daemon, so it announced on a Mac explicitly
  // set to silent. Tyler heard conch talking with the app shut and nothing
  // running. The guard has to sit inside the !handedOff branch, ahead of both
  // the bell and the speech.
  const source = readFileSync(join(import.meta.dir, "../src/hook.ts"), "utf8");
  const body = source.slice(source.indexOf("export async function runHook"));
  const fallback = body.indexOf("if (!handedOff) {");
  const guard = body.indexOf("readState().paused", fallback);

  expect(fallback).toBeGreaterThan(0);
  expect(guard).toBeGreaterThan(fallback);
  expect(guard).toBeLessThan(body.indexOf("await bell(", fallback));
  expect(guard).toBeLessThan(body.indexOf("await speak(", fallback));
});
