import { describe, expect, test } from "bun:test";
import type { PanelModel } from "../src/panel.ts";
import {
  answerableTerminalQuestion,
  TerminalQuestionController,
} from "../src/terminal-question.ts";

function questionModel(multiSelect: boolean): PanelModel {
  return {
    rows: [{
      sessionId: "one",
      label: "project-one",
      backend: "claude",
      status: "needs",
      paused: false,
      muted: false,
      liveGlyph: null,
      active: false,
      navSelected: true,
    }],
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "", partial: "" },
    reply: null,
    panelOpen: true,
    conversations: {
      one: {
        sessionId: "one",
        truncated: false,
        items: [{
          id: "ask-1",
          rev: 1,
          kind: "tool",
          text: "",
          tool: { name: "question", kind: "question", status: "running" },
          question: {
            header: "Destination",
            question: "Where should it go?",
            options: [
              { label: "Linear" },
              { label: "Export PDF" },
              { label: "Save to wiki" },
            ],
            multiSelect,
          },
        }],
      },
    },
  };
}

describe("terminal structured questions", () => {
  test("finds the running question for the parked content row", () => {
    expect(answerableTerminalQuestion(questionModel(false))).toMatchObject({
      sessionId: "one",
      label: "project-one",
      itemId: "ask-1",
    });
  });

  test("a number submits one single-choice label immediately", () => {
    const answers: string[] = [];
    const controller = new TerminalQuestionController(() => {});
    const question = answerableTerminalQuestion(questionModel(false));
    expect(controller.handleKey("2", question, (text) => { answers.push(text); })).toBeTrue();
    expect(answers).toEqual(["Export PDF"]);
    expect(controller.model(question)).toMatchObject({ submitted: true });
  });

  test("multi-select numbers toggle and Enter submits the ordered set", () => {
    const answers: string[] = [];
    const controller = new TerminalQuestionController(() => {});
    const question = answerableTerminalQuestion(questionModel(true));
    controller.handleKey("3", question, (text) => { answers.push(text); });
    controller.handleKey("1", question, (text) => { answers.push(text); });
    expect(controller.model(question)?.selectedIndices).toEqual([0, 2]);
    expect(answers).toEqual([]);
    controller.handleKey("\r", question, (text) => { answers.push(text); });
    expect(answers).toEqual(["Linear, Save to wiki"]);
    expect(controller.model(question)?.submitted).toBeTrue();
  });
});
