import type { TerminalComposerModel } from "./panel.ts";

export interface TerminalComposerTarget {
  sessionId: string;
  label: string;
}

export interface TerminalComposerController {
  submit(target: Readonly<TerminalComposerTarget>, text: string): boolean | void;
}

export interface TerminalComposerOptions {
  controller: TerminalComposerController;
  onOpen?(): void;
  onClose?(): void;
  onChange(): void;
}

const MAX_PROMPT_LENGTH = 2_000;
const PRINTABLE_INPUT = /^[^\u0000-\u001f\u007f]+$/u;

/**
 * The terminal's intentionally small composer: one editable prompt line,
 * targeted to the session captured when it opens. It is not a pretend text
 * editor; Enter submits, Escape cancels, and image/multiline composition stays
 * on the apps that can present it honestly.
 */
export class TerminalComposer {
  readonly #controller: TerminalComposerController;
  readonly #onOpen: () => void;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  #target: TerminalComposerTarget | null = null;
  #text = "";
  #error: string | undefined;
  #appliedDictationId = 0;

  constructor(options: TerminalComposerOptions) {
    this.#controller = options.controller;
    this.#onOpen = options.onOpen ?? (() => {});
    this.#onClose = options.onClose ?? (() => {});
    this.#onChange = options.onChange;
  }

  isOpen(): boolean {
    return this.#target !== null;
  }

  open(target: Readonly<TerminalComposerTarget>, currentDictationId = 0): void {
    if (this.#target) return;
    this.#target = { ...target };
    this.#text = "";
    this.#error = undefined;
    this.#appliedDictationId = Math.max(this.#appliedDictationId, currentDictationId);
    this.#onOpen();
    this.#onChange();
  }

  close(): void {
    if (!this.#target) return;
    this.#target = null;
    this.#text = "";
    this.#error = undefined;
    this.#onClose();
    this.#onChange();
  }

  model(): TerminalComposerModel | null {
    if (!this.#target) return null;
    return {
      target: { ...this.#target },
      text: this.#text,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** Apply each daemon-published composer dictation once, and only to its owner. */
  applyDictation(dictation: { text: string; id: number; sessionId: string } | undefined): boolean {
    if (!dictation || dictation.id <= this.#appliedDictationId) return false;
    this.#appliedDictationId = dictation.id;
    if (!this.#target || dictation.sessionId !== this.#target.sessionId) return false;
    const spoken = dictation.text.trim();
    if (!spoken) return false;
    this.#text = this.#text.trimEnd();
    this.#text = this.#text ? `${this.#text} ${spoken}` : spoken;
    this.#error = undefined;
    return true;
  }

  /** False only while closed or for raw Ctrl-C, which must reach shutdown. */
  handleKey(input: string): boolean {
    if (!this.#target || input === "\u0003") return false;
    if (input === "\x1b") {
      this.close();
      return true;
    }
    if (input === "\r" || input === "\n") {
      this.#submit();
      return true;
    }
    if (input === "\x7f" || input === "\b") {
      this.#text = Array.from(this.#text).slice(0, -1).join("");
      this.#error = undefined;
      this.#onChange();
      return true;
    }
    if (PRINTABLE_INPUT.test(input)) {
      this.#text = (this.#text + input).slice(0, MAX_PROMPT_LENGTH);
      this.#error = undefined;
      this.#onChange();
    }
    return true;
  }

  #submit(): void {
    const target = this.#target;
    if (!target) return;
    const text = this.#text.trim();
    if (!text) {
      this.#error = "type a prompt before sending";
      this.#onChange();
      return;
    }
    try {
      const submitted = this.#controller.submit({ ...target }, text);
      if (submitted === false) {
        this.#error = "session is no longer available";
        this.#onChange();
        return;
      }
      this.close();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#onChange();
    }
  }
}
