import type {
  SessionStartKey,
  SessionStartOverlayModel,
} from "./panel.ts";
import type { SessionBackend, StartSessionRequest } from "./session-lifecycle.ts";

export interface SessionStartController {
  start(request: StartSessionRequest): Promise<void>;
}

export interface SessionStartOverlayOptions {
  controller: SessionStartController;
  defaultCwd: string;
  onOpen?(): void;
  onClose?(): void;
  onChange(): void;
}

const START_KEYS: readonly SessionStartKey[] = ["backend", "cwd", "start"];
const START_HELP: Record<SessionStartKey, string> = {
  backend: "←/→ switch agent · enter toggle",
  cwd: "enter edit/commit · absolute folder on this Mac",
  start: "enter open a fresh session in Terminal",
};
const PRINTABLE_INPUT = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_CWD_LENGTH = 1_024;

/** Fresh-session launcher for the TUI. Historical resume remains in the two apps. */
export class SessionStartOverlay {
  readonly #controller: SessionStartController;
  readonly #defaultCwd: string;
  readonly #onOpen: () => void;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  #opened = false;
  #backend: SessionBackend = "claude";
  #cwd = "";
  #cwdBuffer: string | null = null;
  #selectedIndex = 0;
  #starting = false;
  #error: string | undefined;

  constructor(options: SessionStartOverlayOptions) {
    this.#controller = options.controller;
    this.#defaultCwd = options.defaultCwd;
    this.#onOpen = options.onOpen ?? (() => {});
    this.#onClose = options.onClose ?? (() => {});
    this.#onChange = options.onChange;
  }

  isOpen(): boolean {
    return this.#opened;
  }

  open(): void {
    if (this.#opened) return;
    this.#opened = true;
    this.#backend = "claude";
    this.#cwd = this.#defaultCwd;
    this.#cwdBuffer = null;
    this.#selectedIndex = 0;
    this.#starting = false;
    this.#error = undefined;
    this.#onOpen();
    this.#onChange();
  }

  close(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#cwdBuffer = null;
    this.#starting = false;
    this.#onClose();
    this.#onChange();
  }

  model(): SessionStartOverlayModel | null {
    if (!this.#opened) return null;
    return {
      selectedIndex: this.#selectedIndex,
      starting: this.#starting,
      rows: START_KEYS.map((key, index) => ({
        key,
        value: key === "backend"
          ? this.#backend
          : key === "cwd"
            ? this.#cwdBuffer ?? this.#cwd
            : this.#starting ? "starting…" : "fresh session",
        help: START_HELP[key],
        selected: index === this.#selectedIndex,
        editing: key === "cwd" && this.#cwdBuffer !== null,
      })),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** False only while closed or for raw Ctrl-C, which must reach shutdown. */
  handleKey(input: string): boolean {
    if (!this.#opened || input === "\u0003") return false;
    if (this.#starting) return true;
    if (input === "\x1b") {
      if (this.#cwdBuffer !== null) {
        this.#cwdBuffer = null;
        this.#error = undefined;
        this.#onChange();
      } else {
        this.close();
      }
      return true;
    }
    if (input === "\x1b[A" || input === "\x1bOA") return this.#move(-1);
    if (input === "\x1b[B" || input === "\x1bOB") return this.#move(1);
    if (input === "\x1b[D" || input === "\x1bOD") return this.#switchBackend(-1);
    if (input === "\x1b[C" || input === "\x1bOC") return this.#switchBackend(1);
    if (input === "\r" || input === "\n") return this.#enter();
    if (input === "\x7f" || input === "\b") {
      if (this.#cwdBuffer !== null) {
        this.#cwdBuffer = Array.from(this.#cwdBuffer).slice(0, -1).join("");
        this.#error = undefined;
        this.#onChange();
      }
      return true;
    }
    if (this.#cwdBuffer !== null && PRINTABLE_INPUT.test(input)) {
      this.#cwdBuffer = (this.#cwdBuffer + input).slice(0, MAX_CWD_LENGTH);
      this.#error = undefined;
      this.#onChange();
    }
    return true;
  }

  #move(delta: -1 | 1): true {
    this.#selectedIndex = (
      this.#selectedIndex + delta + START_KEYS.length
    ) % START_KEYS.length;
    this.#cwdBuffer = null;
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #switchBackend(_delta: -1 | 1): true {
    if (START_KEYS[this.#selectedIndex] === "backend") {
      this.#backend = this.#backend === "claude" ? "codex" : "claude";
      this.#error = undefined;
      this.#onChange();
    }
    return true;
  }

  #enter(): true {
    switch (START_KEYS[this.#selectedIndex]) {
      case "backend":
        return this.#switchBackend(1);
      case "cwd":
        if (this.#cwdBuffer === null) {
          this.#cwdBuffer = this.#cwd;
        } else {
          const cwd = this.#cwdBuffer.trim();
          if (!cwd) {
            this.#error = "working folder cannot be empty";
          } else {
            this.#cwd = cwd;
            this.#cwdBuffer = null;
            this.#error = undefined;
          }
        }
        this.#onChange();
        return true;
      case "start":
        this.#starting = true;
        this.#error = undefined;
        this.#onChange();
        void this.#controller.start({ backend: this.#backend, cwd: this.#cwd })
          .then(() => this.close())
          .catch((error) => {
            this.#starting = false;
            this.#error = error instanceof Error ? error.message : String(error);
            this.#onChange();
          });
        return true;
    }
  }
}
