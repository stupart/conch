import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountModelCatalog, decodeProviderModels, discoverProviderModels } from "../src/provider-models.ts";
import { AGENT_SESSION_SETTINGS, planClaudePicker } from "../src/session-settings.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("redirected state keeps model discovery inside the provided files", () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-models-")); dirs.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "haiku" }));
  const catalog = accountModelCatalog({ claudeDir: dir, codexHome: null }, () => { throw new Error("No probe should be started"); });
  expect(catalog.claude.defaults.model).toBe("haiku");
  expect(catalog.codex.models).toEqual([]);
  expect(catalog.accounts).toBeUndefined();
});
test("native catalogs preserve exact IDs, resolved versions and supported efforts", () => {
  const rows = decodeProviderModels("claude", [
    { value: "default", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: ["high", "max"] },
    { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: ["low", "high"] },
    { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", supportedEffortLevels: ["max"] },
    { value: "haiku", supportsEffort: false }, { value: "haiku" }, { value: "bad\nname" },
  ]);
  expect(rows.map(x => x.id)).toEqual(["default", "opus[1m]", "claude-fable-5-1[1m]", "haiku"]);
  expect(rows[2]?.label).toBe("Fable 5.1");
  expect(rows[3]?.efforts).toEqual([]);
  const catalog = { models: rows, efforts: [], defaults: {} } as any;
  expect(AGENT_SESSION_SETTINGS.claude.modelChoice("claude-opus-5-5", catalog)).toBe("opus[1m]");
  expect(decodeProviderModels("codex", [{ model: "gpt-future", displayName: "Next model", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }] }, { model: "hidden", hidden: true }])).toEqual([{ id: "gpt-future", label: "Next model", efforts: ["ultra"] }]);
});

test("discovery initializes the selected account and never sends a model prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-models-")); dirs.push(dir);
  const executable = join(dir, "provider");
  const capture = join(dir, "captured.jsonl");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
 buffer += new TextDecoder().decode(chunk);
 while (buffer.includes("\\n")) {
  const end=buffer.indexOf("\\n"), line=buffer.slice(0,end); buffer=buffer.slice(end+1);
  const m=JSON.parse(line); appendFileSync(${JSON.stringify(capture)}, JSON.stringify({m,home:process.env.CLAUDE_CONFIG_DIR})+"\\n");
  if(m.request?.subtype !== "initialize") process.exit(2);
  console.log(JSON.stringify({type:"control_response",response:{request_id:m.request_id,response:{models:[{value:"future",displayName:"Future",supportsEffort:false}]}}}));
 }
}`, { mode: 0o700 });
  const result = await discoverProviderModels("claude", { id: "business", label: "Business", configDir: dir }, executable, 2000);
  expect(result[0]?.id).toBe("future");
  const requests = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(requests).toHaveLength(1);
  expect(requests[0].home).toBe(dir);
  expect(requests[0].m).toEqual({ type: "control_request", request_id: "conch-models", request: { subtype: "initialize" } });
});

test("a picker cannot substitute a different explicit model version", () => {
  const original = readFileSync(join(import.meta.dir, "fixtures/session-settings/claude-picker.txt"), "utf8");
  expect(planClaudePicker(original, { model: "claude-fable-5-1[1m]" }, false).kind).toBe("keys");
  const versioned = original.replace("3. Fable                    ", "3. Fable 5.0                ");
  expect(planClaudePicker(versioned, { model: "claude-fable-5-1[1m]" }, false).kind).toBe("fail");
});
