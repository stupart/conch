import type {
  RestoreSessionsOverlayModel,
  SessionActionKey,
  SessionActionsOverlayModel,
} from "./panel.ts";

export interface SessionActionsTarget {
  sessionId: string;
  label: string;
  backend?: "claude" | "codex";
  pid?: number;
}

/**
 * All mutations stay outside the modal. The daemon supplies this controller
 * from its live session sets and the existing voice/label persistence helpers.
 */
export interface SessionActionsController {
  voiceCandidates(target: Readonly<SessionActionsTarget>): readonly string[];
  effectiveVoice(target: Readonly<SessionActionsTarget>): string;
  previewVoice(target: Readonly<SessionActionsTarget>, voice: string): void;
  setVoice(target: Readonly<SessionActionsTarget>, voice: string): boolean | void;
  resetVoice(target: Readonly<SessionActionsTarget>): boolean | void;
  isPrioritized(sessionId: string): boolean;
  setPrioritized(sessionId: string, prioritized: boolean): boolean | void;
  /**
   * Return the canonical stored label when persistence normalizes the input.
   * A void return means the submitted (trimmed) label was stored unchanged.
   */
  rename(target: Readonly<SessionActionsTarget>, label: string): string | void;
  dismiss(target: Readonly<SessionActionsTarget>): boolean | void;
  /** Ask the agent to exit cleanly; never kill its process. */
  close(target: Readonly<SessionActionsTarget>): Promise<boolean | void>;
  /** Restore a previously dismissed session to the active dashboard. */
  restore(sessionId: string): boolean | void;
}

export type SessionActionMutation =
  | { command: "rename"; label: string }
  | { command: "set-voice"; voice: string }
  | { command: "reset-voice" }
  | { command: "prioritize"; value: boolean }
  | { command: "dismiss" }
  | { command: "close" }
  | { command: "restore" };

/** One closed command-to-controller adapter shared by terminal UI and socket IPC. */
export function invokeSessionAction(
  controller: SessionActionsController,
  target: Readonly<SessionActionsTarget>,
  mutation: SessionActionMutation,
): string | boolean | void | Promise<boolean | void> {
  switch (mutation.command) {
    case "rename":
      return controller.rename({ ...target }, mutation.label);
    case "set-voice":
      return controller.setVoice({ ...target }, mutation.voice);
    case "reset-voice":
      return controller.resetVoice({ ...target });
    case "prioritize":
      return controller.setPrioritized(target.sessionId, mutation.value);
    case "dismiss":
      return controller.dismiss({ ...target });
    case "close":
      return controller.close({ ...target });
    case "restore":
      return controller.restore(target.sessionId);
  }
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
  "close",
];

const ACTION_HELP: Record<SessionActionKey, string> = {
  voice: "←/→ preview · enter pin · a reset to auto",
  prioritize: "← off · → on · space/enter toggle hand-off priority",
  rename: "enter edit/commit · letters, numbers, space, _.- · esc cancel",
  dismiss: "enter twice · stops announcements; session keeps running",
  close: "enter twice · clean Ctrl-D; transcript remains resumable",
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
  #closeArmed = false;
  #closeInFlight = false;
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
    this.#target = { ...target };
    this.#selectedIndex = 0;
    this.#renameBuffer = null;
    this.#dismissArmed = false;
    this.#closeArmed = false;
    this.#closeInFlight = false;
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
    this.#closeArmed = false;
    this.#closeInFlight = false;
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
        ...(key === "close" && this.#closeArmed ? { confirming: true } : {}),
      })),
      selectedIndex: this.#selectedIndex,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** Returns false only when closed or when raw Ctrl-C must reach daemon shutdown. */
  handleKey(input: string): boolean {
    if (!this.#opened) return false;
    if (input === "\u0003") return false;
    if (this.#closeInFlight) return true;

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
      const closeDisarmed = this.#disarmClose();
      if (key === "rename" && this.#renameBuffer !== null) {
        this.#renameBuffer = this.#renameBuffer.slice(0, -1);
        this.#acks.rename = undefined;
        this.#onChange();
      } else if (disarmed || closeDisarmed) this.#onChange();
      return true;
    }

    if (key === "rename" && this.#renameBuffer !== null && RENAME_INPUT.test(input)) {
      this.#disarmDismiss();
      this.#disarmClose();
      this.#renameBuffer = (this.#renameBuffer + input).slice(0, MAX_RENAME_LENGTH);
      this.#acks.rename = undefined;
      this.#onChange();
      return true;
    }

    if (key === "voice" && input.toLowerCase() === "a") {
      this.#disarmDismiss();
      this.#disarmClose();
      this.#resetVoice();
      return true;
    }

    if (input === " ") {
      const disarmed = this.#disarmDismiss();
      const closeDisarmed = this.#disarmClose();
      if (key === "voice") this.#previewVoice();
      else if (key === "prioritize") this.#setPriority(!this.#prioritized);
      else if (disarmed || closeDisarmed) this.#onChange();
      return true;
    }

    // A confirmation must be two consecutive Enters, but every key remains
    // trapped so q/p/r/space cannot leak to a global action.
    if (this.#disarmDismiss() || this.#disarmClose()) this.#onChange();
    return true;
  }

  #move(delta: -1 | 1): true {
    this.#selectedIndex = (
      this.#selectedIndex + delta + ACTION_KEYS.length
    ) % ACTION_KEYS.length;
    this.#renameBuffer = null;
    this.#disarmDismiss();
    this.#disarmClose();
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #adjust(delta: -1 | 1): true {
    const key = ACTION_KEYS[this.#selectedIndex];
    this.#renameBuffer = null;
    const disarmed = this.#disarmDismiss();
    const closeDisarmed = this.#disarmClose();
    this.#error = undefined;
    if (key === "voice") this.#cycleVoice(delta);
    else if (key === "prioritize") this.#setPriority(delta > 0);
    else if (disarmed || closeDisarmed) this.#onChange();
    return true;
  }

  #enter(key: SessionActionKey): true {
    switch (key) {
      case "voice":
        this.#disarmDismiss();
        this.#disarmClose();
        this.#commitVoice();
        break;
      case "prioritize":
        this.#disarmDismiss();
        this.#disarmClose();
        this.#setPriority(!this.#prioritized);
        break;
      case "rename":
        this.#disarmDismiss();
        this.#disarmClose();
        if (this.#renameBuffer === null) {
          this.#renameBuffer = this.#capturedTarget().label;
          this.#acks.rename = undefined;
          this.#onChange();
        } else {
          this.#commitRename();
        }
        break;
      case "dismiss":
        this.#disarmClose();
        if (!this.#dismissArmed) {
          this.#dismissArmed = true;
          this.#acks.dismiss = "press enter again to dismiss";
          this.#onChange();
        } else {
          this.#commitDismiss();
        }
        break;
      case "close":
        this.#disarmDismiss();
        if (!this.#closeArmed) {
          this.#closeArmed = true;
          this.#acks.close = "press enter again to end cleanly";
          this.#onChange();
        } else {
          this.#commitClose();
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
      case "close":
        return this.#closeInFlight ? "closing…" : this.#closeArmed ? "CONFIRM" : "clean exit";
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
      invokeSessionAction(
        this.#controller,
        this.#capturedTarget(),
        { command: "set-voice", voice },
      );
      this.#acks.voice = "pinned";
      this.#error = undefined;
    } catch (error) {
      this.#acks.voice = `not saved: ${errorMessage(error)}`;
    }
    this.#onChange();
  }

  #resetVoice(): void {
    try {
      invokeSessionAction(
        this.#controller,
        this.#capturedTarget(),
        { command: "reset-voice" },
      );
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
      invokeSessionAction(
        this.#controller,
        this.#capturedTarget(),
        { command: "prioritize", value: prioritized },
      );
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
      const stored = invokeSessionAction(
        this.#controller,
        target,
        { command: "rename", label: submitted },
      );
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
      invokeSessionAction(
        this.#controller,
        this.#capturedTarget(),
        { command: "dismiss" },
      );
      this.close();
    } catch (error) {
      this.#dismissArmed = false;
      this.#acks.dismiss = `not dismissed: ${errorMessage(error)}`;
      this.#onChange();
    }
  }

  #commitClose(): void {
    this.#closeInFlight = true;
    this.#acks.close = "closing cleanly…";
    this.#onChange();
    void Promise.resolve(invokeSessionAction(
      this.#controller,
      this.#capturedTarget(),
      { command: "close" },
    )).then((closed) => {
      if (closed === false) {
        this.#closeInFlight = false;
        this.#closeArmed = false;
        this.#acks.close = "session did not close";
        this.#onChange();
        return;
      }
      this.close();
    }).catch((error) => {
      this.#closeInFlight = false;
      this.#closeArmed = false;
      this.#acks.close = `not closed: ${errorMessage(error)}`;
      this.#onChange();
    });
  }

  #disarmDismiss(): boolean {
    if (!this.#dismissArmed) return false;
    this.#dismissArmed = false;
    this.#acks.dismiss = undefined;
    return true;
  }

  #disarmClose(): boolean {
    if (!this.#closeArmed || this.#closeInFlight) return false;
    this.#closeArmed = false;
    this.#acks.close = undefined;
    return true;
  }

  #capturedTarget(): SessionActionsTarget {
    if (!this.#target) throw new Error("session actions target is unavailable");
    return this.#target;
  }
}

export interface RestoreSessionsOverlayOptions {
  controller: SessionActionsController;
  onOpen?(): void;
  onClose?(): void;
  onChange(): void;
}

/** A stable snapshot makes every dismissed session reachable, not just the latest. */
export class RestoreSessionsOverlay {
  readonly #controller: SessionActionsController;
  readonly #onOpen: () => void;
  readonly #onClose: () => void;
  readonly #onChange: () => void;
  #opened = false;
  #targets: SessionActionsTarget[] = [];
  #selectedIndex = 0;
  #error: string | undefined;

  constructor(options: RestoreSessionsOverlayOptions) {
    this.#controller = options.controller;
    this.#onOpen = options.onOpen ?? (() => {});
    this.#onClose = options.onClose ?? (() => {});
    this.#onChange = options.onChange;
  }

  isOpen(): boolean {
    return this.#opened;
  }

  open(targets: readonly SessionActionsTarget[]): void {
    if (this.#opened) return;
    const seen = new Set<string>();
    this.#targets = [];
    for (const target of targets) {
      if (!target.sessionId || seen.has(target.sessionId)) continue;
      seen.add(target.sessionId);
      this.#targets.push({ ...target });
    }
    if (!this.#targets.length) return;
    this.#opened = true;
    this.#selectedIndex = 0;
    this.#error = undefined;
    this.#onOpen();
    this.#onChange();
  }

  close(): void {
    if (!this.#opened) return;
    this.#opened = false;
    this.#onClose();
    this.#onChange();
  }

  model(): RestoreSessionsOverlayModel | null {
    if (!this.#opened) return null;
    return {
      rows: this.#targets.map((target, index) => ({
        id: target.sessionId,
        label: target.label,
        selected: index === this.#selectedIndex,
      })),
      selectedIndex: this.#selectedIndex,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** Returns false only when closed or when raw Ctrl-C must reach shutdown. */
  handleKey(input: string): boolean {
    if (!this.#opened || input === "\u0003") return false;
    if (input === "\x1b") {
      this.close();
      return true;
    }
    if (input === "\x1b[A" || input === "\x1bOA") return this.#move(-1);
    if (input === "\x1b[B" || input === "\x1bOB") return this.#move(1);
    if (input === "\r" || input === "\n") return this.#restoreSelected();
    return true;
  }

  #move(delta: -1 | 1): true {
    this.#selectedIndex = (
      this.#selectedIndex + delta + this.#targets.length
    ) % this.#targets.length;
    this.#error = undefined;
    this.#onChange();
    return true;
  }

  #restoreSelected(): true {
    const target = this.#targets[this.#selectedIndex];
    if (!target) return true;
    try {
      const restored = invokeSessionAction(
        this.#controller,
        target,
        { command: "restore" },
      );
      if (restored === false) {
        this.#error = `could not restore ${target.label}`;
      } else {
        this.#targets.splice(this.#selectedIndex, 1);
        if (!this.#targets.length) {
          this.close();
          return true;
        }
        this.#selectedIndex = Math.min(this.#selectedIndex, this.#targets.length - 1);
        this.#error = undefined;
      }
    } catch (error) {
      this.#error = `could not restore ${target.label}: ${errorMessage(error)}`;
    }
    this.#onChange();
    return true;
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
