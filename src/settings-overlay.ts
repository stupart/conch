import {
  SETTING_DESCRIPTORS,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type SettingDescriptor,
  type SettingSource,
  type SettingValue,
} from "./settings.ts";
import type { SettingsOverlayModel } from "./panel.ts";

export interface SettingsOverlayConfigController {
  handle(message: ConfigControlMessage): ConfigControlResponse;
}

export interface SettingsOverlayOptions {
  controller: SettingsOverlayConfigController;
  settingsPath: string;
  persist(path: string, key: unknown, value: unknown): unknown;
  onChange(): void;
}

interface OverlaySetting {
  descriptor: SettingDescriptor;
  value: SettingValue;
  source: SettingSource;
  ack?: string;
}

function displayValue(value: SettingValue): string {
  return String(value);
}

/** State + key routing for the theater settings modal; rendering stays separate. */
export class SettingsOverlay {
  readonly #controller: SettingsOverlayConfigController;
  readonly #settingsPath: string;
  readonly #persist: SettingsOverlayOptions["persist"];
  readonly #onChange: () => void;
  #opened = false;
  #selectedIndex = 0;
  #editBuffer: string | null = null;
  #rows: OverlaySetting[] = [];
  #error: string | undefined;

  constructor(options: SettingsOverlayOptions) {
    this.#controller = options.controller;
    this.#settingsPath = options.settingsPath;
    this.#persist = options.persist;
    this.#onChange = options.onChange;
  }

  isOpen(): boolean {
    return this.#opened;
  }

  open(): void {
    const response = this.#controller.handle({ kind: "get-config" });
    this.#opened = true;
    this.#editBuffer = null;
    this.#error = undefined;
    if (response.kind === "config-snapshot") {
      this.#rows = SETTING_DESCRIPTORS.map((descriptor) => ({
        descriptor,
        value: response.snapshot[descriptor.key].value,
        source: response.snapshot[descriptor.key].source,
      }));
      this.#selectedIndex = Math.min(this.#selectedIndex, this.#rows.length - 1);
    } else {
      this.#rows = SETTING_DESCRIPTORS.map((descriptor) => ({
        descriptor,
        value: descriptor.default,
        source: "default",
      }));
      this.#selectedIndex = 0;
      this.#error = response.kind === "config-error" ? response.error : "could not load settings";
    }
    this.#onChange();
  }

  close(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#editBuffer = null;
    this.#onChange();
  }

  model(): SettingsOverlayModel | null {
    if (!this.#opened) return null;
    return {
      rows: this.#rows.map((row, index) => ({
        key: row.descriptor.key,
        value: index === this.#selectedIndex && this.#editBuffer !== null
          ? this.#editBuffer
          : displayValue(row.value),
        source: row.source,
        help: row.descriptor.help,
        selected: index === this.#selectedIndex,
        editing: index === this.#selectedIndex && this.#editBuffer !== null,
        ...(row.ack ? { ack: row.ack } : {}),
      })),
      selectedIndex: this.#selectedIndex,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** Returns false only when closed or when raw Ctrl-C must reach daemon shutdown. */
  handleKey(input: string): boolean {
    if (!this.#opened) return false;
    if (input === "\u0003") return false;

    if (input === "\x1b[A" || input === "\x1bOA") return this.#move(-1);
    if (input === "\x1b[B" || input === "\x1bOB") return this.#move(1);
    if (input === "\x1b[D" || input === "\x1bOD") return this.#adjust(-1);
    if (input === "\x1b[C" || input === "\x1bOC") return this.#adjust(1);
    if (input === "\x1b") {
      this.close();
      return true;
    }

    const row = this.#rows[this.#selectedIndex];
    if (!row) return true;
    if (input === " ") {
      this.#editBuffer = null;
      if (row.descriptor.kind === "boolean") this.#commit(!row.value);
      return true;
    }
    if (input === "\r" || input === "\n") {
      if (this.#editBuffer !== null) this.#commit(this.#editBuffer);
      return true;
    }
    if (input === "\x7f" || input === "\b") {
      if (this.#editBuffer !== null) {
        this.#editBuffer = this.#editBuffer.slice(0, -1);
        this.#onChange();
      }
      return true;
    }
    if (
      (row.descriptor.kind === "number" || row.descriptor.kind === "integer")
      && /^[0-9.+-]+$/.test(input)
    ) {
      this.#editBuffer = (this.#editBuffer ?? "") + input;
      row.ack = undefined;
      this.#onChange();
      return true;
    }

    return true; // modal trap: unknown keys never fall through to global actions
  }

  #move(delta: -1 | 1): true {
    if (!this.#rows.length) return true;
    this.#selectedIndex = (
      this.#selectedIndex + delta + this.#rows.length
    ) % this.#rows.length;
    this.#editBuffer = null;
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #adjust(delta: -1 | 1): true {
    const row = this.#rows[this.#selectedIndex];
    if (!row) return true;
    this.#editBuffer = null;
    if (row.descriptor.kind === "enum") {
      const choices = row.descriptor.choices ?? [];
      const current = choices.indexOf(row.value);
      if (choices.length) {
        const next = (Math.max(0, current) + delta + choices.length) % choices.length;
        this.#commit(choices[next]!);
      }
      return true;
    }
    if (row.descriptor.kind === "number" || row.descriptor.kind === "integer") {
      const step = row.descriptor.kind === "integer" ? 1 : 0.1;
      const value = typeof row.value === "number" ? row.value : Number(row.value);
      this.#commit(Number((value + delta * step).toFixed(6)));
    }
    return true;
  }

  #commit(raw: unknown): void {
    const row = this.#rows[this.#selectedIndex];
    if (!row) return;
    const parsed = row.descriptor.parse(raw);
    if (!parsed.ok) {
      row.ack = parsed.err;
      this.#onChange();
      return;
    }

    // Match `conch set`: durable write first, then mutate the live controller.
    // A corrupt/unwritable file therefore cannot leave only the process changed.
    try {
      this.#persist(this.#settingsPath, row.descriptor.key, parsed.value);
    } catch (error) {
      row.ack = `not saved: ${error instanceof Error ? error.message : String(error)}`;
      this.#onChange();
      return;
    }

    const response = this.#controller.handle({
      kind: "set-config",
      key: row.descriptor.key,
      value: parsed.value,
    });
    if (response.kind !== "config-ack") {
      row.ack = response.kind === "config-error" ? response.error : "unexpected config response";
      this.#onChange();
      return;
    }

    row.value = response.effective;
    row.source = response.source;
    row.ack = response.status === "masked"
      ? `masked-by-env ${response.env ?? row.descriptor.env}`
      : response.status === "hook-next"
        ? "next hook"
        : "applied";
    this.#editBuffer = null;
    this.#error = undefined;
    this.#onChange();
  }
}
