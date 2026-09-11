import { adapterFor, BYPASS_OPTION, type StartOption } from "./agent-adapter.ts";
import type {
  SessionStartKey,
  SessionStartOverlayModel,
} from "./panel.ts";
import {
  startOptionsError,
  type SessionBackend,
  type StartSessionRequest,
} from "./session-lifecycle.ts";

export interface SessionStartController {
  start(request: StartSessionRequest): Promise<void>;
}

export interface SessionStartOverlayOptions {
  controller: SessionStartController;
  defaultCwd: string;
  /** The persisted `bypass-permissions` setting, read at each open: what the Mac sheet seeds its toggle from. */
  bypassDefault(): boolean;
  onOpen?(): void;
  onClose?(): void;
  onChange(): void;
}

const START_HELP: Record<SessionStartKey, string> = {
  backend: "←/→ switch agent · enter toggle",
  cwd: "enter edit/commit · absolute folder on this Mac",
  start: "enter open a fresh session in Terminal",
};
const OPTION_HELP: Record<StartOption["kind"], string> = {
  enum: "←/→ cycle",
  bool: "enter toggle",
  string: "enter edit/commit · empty is the agent's default",
};
const PRINTABLE_INPUT = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_CWD_LENGTH = 1_024;

type Row = SessionStartKey | StartOption;

/** Fresh-session launcher for the TUI. Historical resume remains in the two apps. */
export class SessionStartOverlay {
  readonly #controller: SessionStartController;
  readonly #defaultCwd: string;
  readonly #bypassDefault: () => boolean;
  readonly #onOpen: () => void;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  #opened = false;
  #backend: SessionBackend = "claude";
  #cwd = "";
  /** The selected row's text while it is being edited: the folder, or a string option. */
  #buffer: string | null = null;
  /** What the person chose, by option name. Unset is the agent's default, and is not sent. */
  #values: Record<string, string | boolean> = {};
  #selectedIndex = 0;
  #starting = false;
  #error: string | undefined;

  constructor(options: SessionStartOverlayOptions) {
    this.#controller = options.controller;
    this.#defaultCwd = options.defaultCwd;
    this.#bypassDefault = options.bypassDefault;
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
    this.#buffer = null;
    this.#values = { [BYPASS_OPTION]: this.#bypassDefault() };
    this.#selectedIndex = 0;
    this.#starting = false;
    this.#error = undefined;
    this.#onOpen();
    this.#onChange();
  }

  close(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#buffer = null;
    this.#starting = false;
    this.#onClose();
    this.#onChange();
  }

  model(): SessionStartOverlayModel | null {
    if (!this.#opened) return null;
    return {
      selectedIndex: this.#selectedIndex,
      starting: this.#starting,
      rows: this.#rows().map((row, index) => {
        const selected = index === this.#selectedIndex;
        const editing = selected && this.#buffer !== null;
        if (typeof row === "object") {
          const value = this.#values[row.name];
          return {
            key: row.name,
            value: editing ? this.#buffer! : value === undefined ? "default" : value === true ? "on" : value === false ? "off" : value,
            help: `${OPTION_HELP[row.kind]} · ${row.help}`,
            selected,
            editing,
          };
        }
        return {
          key: row,
          value: row === "backend"
            ? this.#backend
            : row === "cwd"
              ? editing ? this.#buffer! : this.#cwd
              : this.#starting ? "starting…" : "fresh session",
          help: START_HELP[row],
          selected,
          editing,
        };
      }),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** False only while closed or for raw Ctrl-C, which must reach shutdown. */
  handleKey(input: string): boolean {
    if (!this.#opened || input === "\u0003") return false;
    if (this.#starting) return true;
    if (input === "\x1b") {
      if (this.#buffer !== null) {
        this.#buffer = null;
        this.#error = undefined;
        this.#onChange();
      } else {
        this.close();
      }
      return true;
    }
    if (input === "\x1b[A" || input === "\x1bOA") return this.#move(-1);
    if (input === "\x1b[B" || input === "\x1bOB") return this.#move(1);
    if (input === "\x1b[D" || input === "\x1bOD") return this.#adjust(-1);
    if (input === "\x1b[C" || input === "\x1bOC") return this.#adjust(1);
    if (input === "\r" || input === "\n") return this.#enter();
    if (input === "\x7f" || input === "\b") {
      if (this.#buffer !== null) {
        this.#buffer = Array.from(this.#buffer).slice(0, -1).join("");
        this.#error = undefined;
        this.#onChange();
      }
      return true;
    }
    if (this.#buffer !== null && PRINTABLE_INPUT.test(input)) {
      this.#buffer = (this.#buffer + input).slice(0, MAX_CWD_LENGTH);
      this.#error = undefined;
      this.#onChange();
    }
    return true;
  }

  /** A fresh start only, so a resume-only entry would be a switch that does nothing. */
  #options(): StartOption[] {
    return adapterFor(this.#backend).startOptions.filter((entry) => !entry.resumeOnly);
  }

  #rows(): Row[] {
    return ["backend", "cwd", ...this.#options(), "start"];
  }

  #move(delta: -1 | 1): true {
    const count = this.#rows().length;
    this.#selectedIndex = (this.#selectedIndex + delta + count) % count;
    this.#buffer = null;
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  /** Left/right: the agent, an enum's choice (through "default"), or a toggle. */
  #adjust(delta: -1 | 1): true {
    const row = this.#rows()[this.#selectedIndex];
    if (row === "backend") {
      this.#backend = this.#backend === "claude" ? "codex" : "claude";
    } else if (typeof row === "object" && row.kind === "enum") {
      const choices = row.choices ?? [];
      const current = choices.indexOf(String(this.#values[row.name])) + 1;
      const next = (current + delta + choices.length + 1) % (choices.length + 1);
      if (next === 0) delete this.#values[row.name];
      else this.#values[row.name] = choices[next - 1]!;
    } else if (typeof row === "object" && row.kind === "bool") {
      this.#values[row.name] = this.#values[row.name] !== true;
    } else {
      return true;
    }
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #enter(): true {
    const row = this.#rows()[this.#selectedIndex];
    if (row === "backend" || (typeof row === "object" && row.kind !== "string")) return this.#adjust(1);
    if (row === "start" || row === undefined) return this.#start();
    if (this.#buffer === null) {
      this.#buffer = row === "cwd" ? this.#cwd : String(this.#values[row.name] ?? "");
    } else if (row === "cwd") {
      const cwd = this.#buffer.trim();
      if (!cwd) {
        this.#error = "working folder cannot be empty";
      } else {
        this.#cwd = cwd;
        this.#buffer = null;
        this.#error = undefined;
      }
    } else {
      const value = this.#buffer.trim();
      if (value) this.#values[row.name] = value;
      else delete this.#values[row.name];
      this.#buffer = null;
      this.#error = undefined;
    }
    this.#onChange();
    return true;
  }

  /** Exactly the shown options the person set, refused here in the CLI's words before anything leaves. */
  #start(): true {
    const options: Record<string, string | boolean> = {};
    for (const entry of this.#options()) {
      const value = this.#values[entry.name];
      if (value !== undefined) options[entry.name] = value;
    }
    const request: StartSessionRequest = { backend: this.#backend, cwd: this.#cwd, options };
    const refusal = startOptionsError(request);
    if (refusal) {
      this.#error = refusal;
      this.#onChange();
      return true;
    }
    this.#starting = true;
    this.#error = undefined;
    this.#onChange();
    void this.#controller.start(request)
      .then(() => this.close())
      .catch((error) => {
        this.#starting = false;
        this.#error = error instanceof Error ? error.message : String(error);
        this.#onChange();
      });
    return true;
  }
}
