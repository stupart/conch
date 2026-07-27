import type {
  SessionActionKey,
  SessionActionsOverlayModel,
} from "./panel.ts";

export interface SessionActionsTarget {
  sessionId: string;
  label: string;
}

/**
 * All mutations stay outside the modal. The daemon supplies this controller
 * from its live session sets and the existing voice/label persistence helpers.
 */
export interface SessionActionsController {
  voiceCandidates(target: Readonly<SessionActionsTarget>): readonly string[];
  effectiveVoice(target: Readonly<SessionActionsTarget>): string;
  previewVoice(target: Readonly<SessionActionsTarget>, voice: string): void;
  setVoice(target: Readonly<SessionActionsTarget>, voice: string): void;
  resetVoice(target: Readonly<SessionActionsTarget>): void;
  isPrioritized(sessionId: string): boolean;
  setPrioritized(sessionId: string, prioritized: boolean): void;
  /**
   * Return the canonical stored label when persistence normalizes the input.
   * A void return means the submitted (trimmed) label was stored unchanged.
   */
  rename(target: Readonly<SessionActionsTarget>, label: string): string | void;
  dismiss(target: Readonly<SessionActionsTarget>): void;
}

export interface SessionActionsOverlayOptions {
  controller: SessionActionsController;
  onOpen?(): void;
  onClose?(): void;
  onChange(): void;
}

const ACTION_KEYS: readonly SessionActionKey[] = [
  "voice",
  "prioritize",
  "rename",
  "dismiss",
];

const ACTION_HELP: Record<SessionActionKey, string> = {
  voice: "←/→ preview · enter pin · a reset to auto",
  prioritize: "← off · → on · space/enter toggle hand-off priority",
  rename: "enter edit/commit · letters, numbers, space, _.- · esc cancel",
  dismiss: "enter twice · stops announcements; session keeps running",
};

const RENAME_INPUT = /^[A-Za-z0-9 _.-]+$/;
const MAX_RENAME_LENGTH = 40;

/** State + key routing for the parked-session actions modal. */
export class SessionActionsOverlay {
  readonly #controller: SessionActionsController;
  readonly #onOpen: () => void;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  #opened = false;
  #target: SessionActionsTarget | null = null;
  #selectedIndex = 0;
  #voiceChoices: string[] = [];
  #voiceIndex = -1;
  #prioritized = false;
  #renameBuffer: string | null = null;
  #dismissArmed = false;
  #acks: Partial<Record<SessionActionKey, string>> = {};
  #error: string | undefined;

  constructor(options: SessionActionsOverlayOptions) {
    this.#controller = options.controller;
    this.#onOpen = options.onOpen ?? (() => {});
    this.#onClose = options.onClose ?? (() => {});
    this.#onChange = options.onChange;
  }

  isOpen(): boolean {
    return this.#opened;
  }

  /**
   * The target is copied exactly once per open transition. Theater navigation
   * may release/fade its cursor while the modal is open without retargeting it.
   */
  open(target: Readonly<SessionActionsTarget>): void {
    if (this.#opened) return;
    this.#opened = true;
    this.#target = { sessionId: target.sessionId, label: target.label };
    this.#selectedIndex = 0;
    this.#renameBuffer = null;
    this.#dismissArmed = false;
    this.#acks = {};
    this.#error = undefined;
    this.#onOpen();

    try {
      this.#loadVoice();
    } catch (error) {
      this.#voiceChoices = [];
      this.#voiceIndex = -1;
      this.#error = `could not load voice: ${errorMessage(error)}`;
    }
    try {
      this.#prioritized = this.#controller.isPrioritized(target.sessionId);
    } catch (error) {
      this.#prioritized = false;
      this.#error ??= `could not load priority: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  close(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#renameBuffer = null;
    this.#dismissArmed = false;
    this.#onClose();
    this.#onChange();
  }

  model(): SessionActionsOverlayModel | null {
    const target = this.#target;
    if (!this.#opened || !target) return null;
    return {
      target: { ...target },
      rows: ACTION_KEYS.map((key, index) => ({
        key,
        value: this.#rowValue(key),
        help: ACTION_HELP[key],
        selected: index === this.#selectedIndex,
        editing: key === "rename" && this.#renameBuffer !== null,
        ...(this.#acks[key] ? { ack: this.#acks[key] } : {}),
        ...(key === "dismiss" && this.#dismissArmed ? { confirming: true } : {}),
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
      if (this.#renameBuffer !== null) {
        this.#renameBuffer = null;
        this.#acks.rename = "edit cancelled";
        this.#onChange();
      } else {
        this.close();
      }
      return true;
    }

    const key = ACTION_KEYS[this.#selectedIndex];
    if (!key) return true;

    if (input === "\r" || input === "\n") return this.#enter(key);

    if (input === "\x7f" || input === "\b") {
      const disarmed = this.#disarmDismiss();
      if (key === "rename" && this.#renameBuffer !== null) {
        this.#renameBuffer = this.#renameBuffer.slice(0, -1);
        this.#acks.rename = undefined;
        this.#onChange();
      } else if (disarmed) this.#onChange();
      return true;
    }

    if (key === "rename" && this.#renameBuffer !== null && RENAME_INPUT.test(input)) {
      this.#disarmDismiss();
      this.#renameBuffer = (this.#renameBuffer + input).slice(0, MAX_RENAME_LENGTH);
      this.#acks.rename = undefined;
      this.#onChange();
      return true;
    }

    if (key === "voice" && input.toLowerCase() === "a") {
      this.#disarmDismiss();
      this.#resetVoice();
      return true;
    }

    if (input === " ") {
      const disarmed = this.#disarmDismiss();
      if (key === "voice") this.#previewVoice();
      else if (key === "prioritize") this.#setPriority(!this.#prioritized);
      else if (disarmed) this.#onChange();
      return true;
    }

    // A confirmation must be two consecutive Enters, but every key remains
    // trapped so q/p/m/r/space cannot leak to a global action.
    if (this.#disarmDismiss()) this.#onChange();
    return true;
  }

  #move(delta: -1 | 1): true {
    this.#selectedIndex = (
      this.#selectedIndex + delta + ACTION_KEYS.length
    ) % ACTION_KEYS.length;
    this.#renameBuffer = null;
    this.#disarmDismiss();
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #adjust(delta: -1 | 1): true {
    const key = ACTION_KEYS[this.#selectedIndex];
    this.#renameBuffer = null;
    const disarmed = this.#disarmDismiss();
    this.#error = undefined;
    if (key === "voice") this.#cycleVoice(delta);
    else if (key === "prioritize") this.#setPriority(delta > 0);
    else if (disarmed) this.#onChange();
    return true;
  }

  #enter(key: SessionActionKey): true {
    switch (key) {
      case "voice":
        this.#disarmDismiss();
        this.#commitVoice();
        break;
      case "prioritize":
        this.#disarmDismiss();
        this.#setPriority(!this.#prioritized);
        break;
      case "rename":
        this.#disarmDismiss();
        if (this.#renameBuffer === null) {
          this.#renameBuffer = this.#capturedTarget().label;
          this.#acks.rename = undefined;
          this.#onChange();
        } else {
          this.#commitRename();
        }
        break;
      case "dismiss":
        if (!this.#dismissArmed) {
          this.#dismissArmed = true;
          this.#acks.dismiss = "press enter again to dismiss";
          this.#onChange();
        } else {
          this.#commitDismiss();
        }
        break;
    }
    return true;
  }

  #rowValue(key: SessionActionKey): string {
    switch (key) {
      case "voice":
        return this.#voiceChoices[this.#voiceIndex] ?? "unavailable";
      case "prioritize":
        return this.#prioritized ? "on" : "off";
      case "rename":
        return this.#renameBuffer ?? this.#capturedTarget().label;
      case "dismiss":
        return this.#dismissArmed ? "CONFIRM" : "keeps running";
    }
  }

  #loadVoice(): void {
    const target = this.#capturedTarget();
    const effective = this.#controller.effectiveVoice({ ...target }).trim();
    const candidates = uniqueNonempty(this.#controller.voiceCandidates({ ...target }));
    if (effective && !candidates.includes(effective)) candidates.unshift(effective);
    this.#voiceChoices = candidates;
    this.#voiceIndex = effective ? candidates.indexOf(effective) : (candidates.length ? 0 : -1);
  }

  #cycleVoice(delta: -1 | 1): void {
    if (!this.#voiceChoices.length) {
      this.#acks.voice = "no voices available";
      this.#onChange();
      return;
    }
    const current = this.#voiceIndex >= 0 ? this.#voiceIndex : 0;
    this.#voiceIndex = (
      current + delta + this.#voiceChoices.length
    ) % this.#voiceChoices.length;
    this.#previewVoice();
  }

  #previewVoice(): void {
    const voice = this.#voiceChoices[this.#voiceIndex];
    if (!voice) {
      this.#acks.voice = "no voices available";
      this.#onChange();
      return;
    }
    try {
      this.#controller.previewVoice({ ...this.#capturedTarget() }, voice);
      this.#acks.voice = "preview";
      this.#error = undefined;
    } catch (error) {
      this.#acks.voice = `preview failed: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #commitVoice(): void {
    const voice = this.#voiceChoices[this.#voiceIndex];
    if (!voice) {
      this.#acks.voice = "no voice to pin";
      this.#onChange();
      return;
    }
    try {
      this.#controller.setVoice({ ...this.#capturedTarget() }, voice);
      this.#acks.voice = "pinned";
      this.#error = undefined;
    } catch (error) {
      this.#acks.voice = `not saved: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #resetVoice(): void {
    try {
      this.#controller.resetVoice({ ...this.#capturedTarget() });
      this.#loadVoice();
      this.#acks.voice = "auto";
      this.#error = undefined;
    } catch (error) {
      this.#acks.voice = `not reset: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #setPriority(prioritized: boolean): void {
    try {
      const sessionId = this.#capturedTarget().sessionId;
      this.#controller.setPrioritized(sessionId, prioritized);
      this.#prioritized = this.#controller.isPrioritized(sessionId);
      this.#acks.prioritize = this.#prioritized ? "prioritized" : "normal order";
      this.#error = undefined;
    } catch (error) {
      this.#acks.prioritize = `not changed: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #commitRename(): void {
    const submitted = (this.#renameBuffer ?? "").trim();
    if (!submitted) {
      this.#acks.rename = "label cannot be empty";
      this.#onChange();
      return;
    }
    try {
      const target = this.#capturedTarget();
      const stored = this.#controller.rename({ ...target }, submitted);
      target.label = typeof stored === "string" && stored.trim() ? stored : submitted;
      this.#renameBuffer = null;
      this.#acks.rename = "renamed";
      this.#error = undefined;
      // Voice overrides are label-keyed. The controller migrates the pin during
      // rename; reload the effective selection under the newly captured label.
      this.#loadVoice();
    } catch (error) {
      this.#acks.rename = `not renamed: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #commitDismiss(): void {
    try {
      this.#controller.dismiss({ ...this.#capturedTarget() });
      this.close();
    } catch (error) {
      this.#dismissArmed = false;
      this.#acks.dismiss = `not dismissed: ${errorMessage(error)}`;
      this.#onChange();
    }
  }

  #disarmDismiss(): boolean {
    if (!this.#dismissArmed) return false;
    this.#dismissArmed = false;
    this.#acks.dismiss = undefined;
    return true;
  }

  #capturedTarget(): SessionActionsTarget {
    if (!this.#target) throw new Error("session actions target is unavailable");
    return this.#target;
  }
}

function uniqueNonempty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
