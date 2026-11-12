import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import {
  CLAUDE_LIMIT_LINE, CLAUDE_LIMIT_OTHER_ROWS, CLAUDE_LIMIT_PREFILL, CLAUDE_LIMIT_STOP, CODEX_GOAL_LIMIT,
  claudePromptReady, codexGoalLimited, limitMenuKey, readClaudeLimitMenu,
} from "../src/claude-limit-menu.ts";

/**
 * Claude Code's usage-limit menu, as it stopped every Default session on 2026-11-12, drawn the way Claude Code draws
 * every picker (test/fixtures/session-settings/claude-picker.txt, captured from 2.1.280): a rule, the question, the
 * numbered rows with ❯ on the highlighted one, the footer, and no prompt under it. The rows are Claude Code 2.1.322's
 * words; Tyler's screen read "1. Stop and wait for limit to reset / 2. Wait here, then continue automatically at <reset
 * time> / 3. Add funds to continue with usage credits".
 */
const rule = "─".repeat(100);
const conversation = [
  "❯ keep going on the importer",
  "",
  "⏺ Agent(Port the importer)",
  "  ⎿  Agent terminated early due to an API error: You've hit your weekly limit · resets Nov 14 at 10pm",
  "",
  "  ⎿  You've hit your weekly limit · resets Nov 14 at 10pm",
  "",
];
function menu(rows: string[], highlighted = 0): string {
  return [
    ...conversation,
    rule,
    "  What do you want to do?",
    "",
    ...rows.map((label, index) => `  ${index === highlighted ? "❯" : " "} ${index + 1}. ${label}`),
    "",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");
}
const TYLERS = ["Stop and wait for limit to reset", "Wait here, then continue automatically at 10pm", "Add funds to continue with usage credits"];

describe("Claude Code's usage-limit menu, word for word", () => {
  test("the words conch looks for are the ones on the screen that night", () => {
    expect(CLAUDE_LIMIT_STOP).toBe("Stop and wait for limit to reset");
    expect(CLAUDE_LIMIT_OTHER_ROWS).toContain("Wait here, then continue automatically");
    expect(CLAUDE_LIMIT_OTHER_ROWS).toContain("Add funds to continue with");
    expect(CLAUDE_LIMIT_PREFILL).toBe("continue");
    expect(CODEX_GOAL_LIMIT).toBe("Goal hit usage limits (/goal resume)");
    expect(CLAUDE_LIMIT_LINE.exec("You've hit your weekly limit · resets Nov 14 at 10pm")?.[1]).toBe("weekly");
    expect(CLAUDE_LIMIT_LINE.exec("You’ve reached your Fable limit.")?.[1]).toBe("Fable");
  });

  test("Tyler's menu is read: three rows, the stop row first and highlighted, a weekly limit", () => {
    const read = readClaudeLimitMenu(menu(TYLERS));
    expect(read).toEqual({
      rows: TYLERS.map((label, index) => ({ number: index + 1, label, highlighted: index === 0 })),
      stop: 0,
      highlighted: 0,
      limit: "weekly",
    });
  });

  test("the stop row is found by its words wherever it sits, never by its number", () => {
    const read = readClaudeLimitMenu(menu(["Add funds to continue with usage credits", "Upgrade your plan", "Stop and wait for limit to reset"], 1));
    expect(read?.stop).toBe(2);
    expect(read?.highlighted).toBe(1);
  });

  test("a reply that quotes the menu above the prompt is not the menu", () => {
    const quoted = [menu(TYLERS), "", rule, "❯ ", rule, "  ? for shortcuts"].join("\n");
    expect(readClaudeLimitMenu(quoted)).toBeNull();
  });

  test("anything else on screen is left alone", () => {
    // The stop row with none of the menu's others: a list someone wrote.
    expect(readClaudeLimitMenu(menu(["Stop and wait for limit to reset", "Keep going"]))).toBeNull();
    // Rows that don't count 1, 2, 3, or two highlighted.
    expect(readClaudeLimitMenu(menu(TYLERS).replace("2. Wait", "4. Wait"))).toBeNull();
    expect(readClaudeLimitMenu(menu(TYLERS).replace("   2. Wait", " ❯ 2. Wait"))).toBeNull();
    // A permission prompt, and Claude's prompt.
    expect(readClaudeLimitMenu([rule, " Bash command", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n"))).toBeNull();
    expect(readClaudeLimitMenu([...conversation, rule, "❯ ", rule].join("\n"))).toBeNull();
  });

  test("one key at a time toward the stop row, and Enter only on two looks at it running", () => {
    const tylers = readClaudeLimitMenu(menu(TYLERS))!;
    expect(limitMenuKey(tylers, 1)).toBeUndefined();
    expect(limitMenuKey(tylers, 2)).toBe("Enter");
    const below = readClaudeLimitMenu(menu(TYLERS, 2))!;
    expect(limitMenuKey(below, 5)).toBe("Up");
    const above = readClaudeLimitMenu(menu(["Add funds to continue with usage credits", "Stop and wait for limit to reset"], 0))!;
    expect(limitMenuKey(above, 5)).toBe("Down");
  });

  test("the prompt after the menu: empty, or holding only Claude Code's own \"continue\", is ready", () => {
    expect(claudePromptReady([...conversation, rule, "❯ ", rule].join("\n"))).toBe("empty");
    expect(claudePromptReady([...conversation, rule, "❯ continue", rule].join("\n"))).toBe("empty");
    expect(claudePromptReady([...conversation, rule, "❯ actually wait", rule].join("\n"))).toBe("holds words");
    expect(claudePromptReady(menu(TYLERS))).toBe("not shown");
  });

  test("Codex's goal stopped on its limits", () => {
    expect(codexGoalLimited("› Ask Codex to do anything\n\n  Goal hit usage limits (/goal resume) · 2h 13m")).toBe(true);
    expect(codexGoalLimited("  Pursuing goal · 2h 13m")).toBe(false);
  });
});

// Opt-in (`CONCH_AGENT_WORDING=1`): the installed Claude Code and Codex still carry these words. Not in the gate, where a
// Claude Code update would stop every push at once; run it after one, or when a stopped session wasn't resumed.
const claude = Bun.which("claude");
const codex = Bun.which("codex");
describe.skipIf(!process.env.CONCH_AGENT_WORDING)("the installed agents still say these words", () => {
  const holds = async (binary: string, words: string) => {
    const bytes = new Uint8Array(await Bun.file(realpathSync(binary)).arrayBuffer());
    return Buffer.from(bytes.buffer).indexOf(words) >= 0;
  };
  test.skipIf(!claude || !existsSync(claude))("Claude Code", async () => {
    for (const words of [CLAUDE_LIMIT_STOP, "Wait here, then continue automatically", "Add funds to continue with", 'wje="continue"']) {
      expect(await holds(claude!, words)).toBe(true);
    }
  }, 60_000);
  test.skipIf(!codex || !existsSync(codex))("Codex", async () => {
    expect(await holds(codex!, CODEX_GOAL_LIMIT)).toBe(true);
  }, 60_000);
});
