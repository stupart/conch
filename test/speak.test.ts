import { test, expect } from "bun:test";
import { voiceFor } from "../src/speak.ts";
import { loadConfig } from "../src/config.ts";

function cfgWithVoices(voices: string[]) {
  const cfg = loadConfig();
  cfg.ttsVoices = voices;
  return cfg;
}

test("voiceFor is stable — same label, same voice, every time", () => {
  const cfg = cfgWithVoices(["a", "b", "c", "d"]);
  const first = voiceFor(cfg, "dayloop");
  for (let i = 0; i < 10; i++) expect(voiceFor(cfg, "dayloop")).toBe(first);
});

test("voiceFor spreads distinct labels across the ring", () => {
  const cfg = cfgWithVoices(["a", "b", "c", "d", "e", "f", "g", "h"]);
  const labels = ["dayloop", "tokenworks", "poaster", "conch", "blueprint", "arch"];
  const used = new Set(labels.map((l) => voiceFor(cfg, l)));
  expect(used.size).toBeGreaterThan(2); // not everyone lands on one voice
});

test("voiceFor falls back sanely with no label or no voices", () => {
  expect(voiceFor(cfgWithVoices(["x", "y"]), "")).toBe("x");
  expect(voiceFor(cfgWithVoices([]), "dayloop")).toBe("af_heart");
});

test("default voice ring parses from config", () => {
  const cfg = loadConfig();
  expect(cfg.ttsVoices.length).toBeGreaterThanOrEqual(4);
  expect(cfg.ttsVoices).toContain("af_heart");
});
