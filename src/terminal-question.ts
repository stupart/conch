import type { AgentQuestion } from "./conversation.ts";
import type { PanelModel, TerminalQuestionState } from "./panel.ts";

export interface TerminalQuestion {
  sessionId: string;
  label: string;
  itemId: string;
  rev: number;
  question: AgentQuestion;
}

/** The question belonging to the same row the theater content pane is showing. */
export function answerableTerminalQuestion(model: PanelModel | null): TerminalQuestion | null {
  if (!model) return null;
  const row = model.rows.find((candidate) => candidate.navSelected)
    ?? model.rows.find((candidate) => candidate.active)
    ?? model.rows.find((candidate) => candidate.status === "needs")
    ?? model.rows[0];
  if (!row) return null;
  const conversation = model.conversations?.[row.sessionId]
    ?? (model.conversation?.sessionId === row.sessionId ? model.conversation : null);
  if (!conversation) return null;
  for (let index = conversation.items.length - 1; index >= 0; index -= 1) {
    const item = conversation.items[index];
    if (item?.question && item.tool?.status === "running") {
      return {
        sessionId: row.sessionId,
        label: row.label,
        itemId: item.id,
        rev: item.rev,
        question: item.question,
      };
    }
  }
  return null;
}

/** Number-key selection state shared by terminal rendering and raw-key routing. */
export class TerminalQuestionController {
  readonly #onChange: () => void;
  #identity = "";
  #selected = new Set<number>();
  #submitted = false;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  model(question: TerminalQuestion | null): TerminalQuestionState | null {
    if (!question) {
      this.#reset("");
      return null;
    }
    this.#adopt(question);
    return {
      sessionId: question.sessionId,
      itemId: question.itemId,
      selectedIndices: [...this.#selected].toSorted((a, b) => a - b),
      submitted: this.#submitted,
    };
  }

  handleKey(
    input: string,
    question: TerminalQuestion | null,
    submit: (text: string) => boolean | void,
  ): boolean {
    if (!question) return false;
    this.#adopt(question);
    if (input === "\x1b" && this.#selected.size > 0 && !this.#submitted) {
      this.#selected.clear();
      this.#onChange();
      return true;
    }
    if (this.#submitted) {
      return (input >= "1" && input <= "9") || input === "\r" || input === "\n";
    }
    if (input >= "1" && input <= "9") {
      const index = Number(input) - 1;
      if (index >= question.question.options.length) return true;
      if (!question.question.multiSelect) {
        const sent = submit(question.question.options[index]!.label);
        if (sent !== false) this.#submitted = true;
      } else if (this.#selected.has(index)) {
        this.#selected.delete(index);
      } else {
        this.#selected.add(index);
      }
      this.#onChange();
      return true;
    }
    if (question.question.multiSelect && (input === "\r" || input === "\n")) {
      if (this.#selected.size === 0) return true;
      const answer = question.question.options
        .filter((_, index) => this.#selected.has(index))
        .map((option) => option.label)
        .join(", ");
      const sent = submit(answer);
      if (sent !== false) this.#submitted = true;
      this.#onChange();
      return true;
    }
    return false;
  }

  #adopt(question: TerminalQuestion): void {
    this.#reset(`${question.sessionId}:${question.itemId}:${question.rev}`);
  }

  #reset(identity: string): void {
    if (identity === this.#identity) return;
    this.#identity = identity;
    this.#selected.clear();
    this.#submitted = false;
  }
}
