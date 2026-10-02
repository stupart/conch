import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelDrifted, RelabelHints, relabelHint, topicWords } from "../src/label-drift.ts";
import { sessionLabelSource } from "../src/sessions.ts";

/**
 * A session stayed "Remove Jaidon from blueprintstudio.ai" in the sidebar after its work had moved on to a headline and
 * a photo edit (2026-10-03). conch never renames it: `review_to_front` tells the agent, once per label, and only for a
 * label the agent's side chose.
 */

const LABEL = "Remove Jaidon from blueprintstudio.ai";

describe("whether the work drifted from the label", () => {
  test("the words that count: lower case, three letters or more, no grammar and no words every deliverable uses", () => {
    expect([...topicWords(LABEL)]).toEqual(["jaidon", "blueprintstudio"]);
    expect([...topicWords("Updated the new pricing page, fixed the hero")]).toEqual(["pricing", "hero"]);
  });

  test("no hint on a match: one recent summary sharing a topic with the label is enough", () => {
    expect(labelDrifted(LABEL, ["Jaidon removed from the team grid", "Headline rewrite"])).toBe(false);
    expect(labelDrifted(LABEL, ["Headline rewrite", "Team photo swapped", "blueprintstudio.ai deploy preview"])).toBe(false);
    // One word for one topic, whatever its ending.
    expect(labelDrifted("Photo edits", ["Swapped the photos", "Cropped the hero"])).toBe(false);
  });

  test("a hint on drift: none of the last two or three summaries shares a meaningful word with it", () => {
    expect(labelDrifted(LABEL, ["Team photo swapped on the about section", "Hero with the new headline"])).toBe(true);
    // Only the newest three are read: an old match doesn't hold the label up.
    expect(labelDrifted(LABEL, ["Headline", "Team photo", "About section copy", "Jaidon removed"])).toBe(true);
  });

  test("one publication is not a trend, and a label with nothing in it to drift from is not judged", () => {
    expect(labelDrifted(LABEL, ["Hero with the new headline"])).toBe(false);
    expect(labelDrifted("Fix it", ["Hero headline", "Team photo"])).toBe(false);
    expect(labelDrifted("the new page", ["Hero headline", "Team photo"])).toBe(false);
  });
});

describe("the hint review_to_front returns", () => {
  const drifted = ["Team photo swapped on the about section", "Hero with the new headline"];

  test("names the label and the newest work, and suggests conch_rename, never renaming", () => {
    expect(relabelHint(LABEL, "agent", drifted)).toEqual({
      label: LABEL,
      hint: `Your session is still labelled '${LABEL}' but your recent work is about 'Team photo swapped on the about section'. If the focus has moved, call conch_rename with a short new label.`,
    });
  });

  test("only for a label the agent's side chose: never a person's, never a folder's name", () => {
    expect(relabelHint(LABEL, "user", drifted)).toBeUndefined();
    expect(relabelHint("Conch", "folder", drifted)).toBeUndefined();
  });

  test("once per label, and again after a rename when the new label drifts in its turn", () => {
    const hints = new RelabelHints();
    expect(hints.take("s1", LABEL, "agent", drifted)?.label).toBe(LABEL);
    expect(hints.take("s1", LABEL, "agent", ["Hero copy final", ...drifted])).toBeUndefined();
    // Another session is its own.
    expect(hints.take("s2", LABEL, "agent", drifted)?.label).toBe(LABEL);
    // Renamed by Claude Code's own new title: matching work says nothing, drifting work says it again.
    expect(hints.take("s1", "Hero headline", "agent", ["Hero copy final", "Headline final"])).toBeUndefined();
    expect(hints.take("s1", "Hero headline", "agent", ["Invoice export", "Billing CSV"])?.label).toBe("Hero headline");
    expect(hints.take("s1", "Hero headline", "agent", ["Invoice export", "Billing CSV"])).toBeUndefined();
  });
});

describe("who chose a session's label", () => {
  test("a person: a conch override, a /rename Claude Code marks as the user's, conch's own help session", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-label-source-"));
    try {
      const labelsPath = join(dir, "labels.json");
      writeFileSync(labelsPath, JSON.stringify({ "s-override": "the api work", native: "by its agent id" }));
      expect(sessionLabelSource({ sessionId: "s-override", name: LABEL }, "/work", { labelsPath })).toBe("user");
      expect(sessionLabelSource({ sessionId: "window@1", agentSessionId: "native" }, "/work", { labelsPath })).toBe("user");
      expect(sessionLabelSource({ sessionId: "s", name: "hero", nameSource: "user" }, "/work", { labelsPath })).toBe("user");
      // The agent's: a generated title, a Codex thread's name, or a registry name from before nameSource.
      expect(sessionLabelSource({ sessionId: "s", name: LABEL }, "/work", { labelsPath })).toBe("agent");
      expect(sessionLabelSource({ sessionId: "s", name: LABEL, nameSource: "derived" }, "/work", { labelsPath })).toBe("agent");
      // Nobody's: the folder's name.
      expect(sessionLabelSource({ sessionId: "s" }, "/work/conch", { labelsPath })).toBe("folder");
      // A prototype name is not an override.
      expect(sessionLabelSource({ sessionId: "constructor", name: LABEL }, "/work", { labelsPath })).toBe("agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
