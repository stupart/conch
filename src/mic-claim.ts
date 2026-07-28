import { dlopen, FFIType } from "bun:ffi";

const CORE_AUDIO_FRAMEWORK = "/System/Library/Frameworks/CoreAudio.framework/CoreAudio";
const AUDIO_OBJECT_SYSTEM = 1;
const AUDIO_OBJECT_UNKNOWN = 0;
const AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN = 0;

function fourCC(value: string): number {
  return (
    (value.charCodeAt(0) << 24)
    | (value.charCodeAt(1) << 16)
    | (value.charCodeAt(2) << 8)
    | value.charCodeAt(3)
  ) >>> 0;
}

// Apple CoreAudio AudioHardware.h:
// - default input device: 'dIn ', global scope, main element
// - device running in at least one process: 'gone', global scope, main element
const DEFAULT_INPUT_ADDRESS = new Uint32Array([
  fourCC("dIn "),
  fourCC("glob"),
  AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
]);
const DEVICE_RUNNING_SOMEWHERE_ADDRESS = new Uint32Array([
  fourCC("gone"),
  fourCC("glob"),
  AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
]);

type GetPropertyData = (
  objectId: number,
  address: Uint32Array,
  qualifierDataSize: number,
  qualifierData: null,
  dataSize: Uint32Array,
  data: Uint32Array,
) => number;

let propertyReader: GetPropertyData | null | undefined;

/** Lazy so importing the daemon with meeting-autopause off never opens CoreAudio. */
function coreAudioPropertyReader(): GetPropertyData | null {
  if (propertyReader !== undefined) return propertyReader;
  if (process.platform !== "darwin") return (propertyReader = null);
  try {
    const library = dlopen(CORE_AUDIO_FRAMEWORK, {
      AudioObjectGetPropertyData: {
        args: [
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
    } as const);
    const read = library.symbols.AudioObjectGetPropertyData;
    propertyReader = (objectId, address, qualifierDataSize, qualifierData, dataSize, data) =>
      read(objectId, address, qualifierDataSize, qualifierData, dataSize, data);
  } catch {
    propertyReader = null;
  }
  return propertyReader;
}

function readUInt32(
  read: GetPropertyData,
  objectId: number,
  address: Uint32Array,
): number | null {
  const size = new Uint32Array([Uint32Array.BYTES_PER_ELEMENT]);
  const value = new Uint32Array(1);
  const status = read(objectId, address, 0, null, size, value);
  return status === 0 && size[0] === Uint32Array.BYTES_PER_ELEMENT ? value[0]! : null;
}

/**
 * Resolve the current default input on every read, then ask whether any process
 * is running it. CoreAudio failures return unknown so an owned pause is kept.
 */
export function readMicInUse(): boolean | null {
  const read = coreAudioPropertyReader();
  if (!read) return null;
  const device = readUInt32(read, AUDIO_OBJECT_SYSTEM, DEFAULT_INPUT_ADDRESS);
  if (device === null || device === AUDIO_OBJECT_UNKNOWN) return null;
  const running = readUInt32(read, device, DEVICE_RUNNING_SOMEWHERE_ADDRESS);
  return running === 0 ? false : running === 1 ? true : null;
}

export interface MicClaimWatcherOptions {
  inUse(): boolean | null;
  selfOwned(): boolean;
  onClaim(): void;
  onRelease(): void;
  claimTicks?: number;
  releaseTicks?: number;
  onError?(error: unknown): void;
}

/** Pure debounced edge detector; CoreAudio and Conch ownership are injected. */
export class MicClaimWatcher {
  readonly #options: MicClaimWatcherOptions;
  readonly #claimTicks: number;
  readonly #releaseTicks: number;
  #busyTicks = 0;
  #freeTicks = 0;
  #claimed = false;
  #closed = false;

  constructor(options: MicClaimWatcherOptions) {
    this.#options = options;
    this.#claimTicks = Math.max(1, Math.floor(options.claimTicks ?? 2));
    this.#releaseTicks = Math.max(1, Math.floor(options.releaseTicks ?? 3));
  }

  get claimed(): boolean {
    return this.#claimed;
  }

  tick(): void {
    if (this.#closed) return;
    try {
      // A Conch-owned tick is deliberately inert: it neither samples the
      // aggregate CoreAudio bit nor disturbs either debounce edge.
      if (this.#options.selfOwned()) return;
      const inUse = this.#options.inUse();
      if (inUse === null) return;
      if (inUse) {
        this.#freeTicks = 0;
        if (this.#claimed) return;
        this.#busyTicks++;
        if (this.#busyTicks < this.#claimTicks) return;
        this.#busyTicks = 0;
        this.#claimed = true;
        this.#emit(this.#options.onClaim);
        return;
      }

      this.#busyTicks = 0;
      if (!this.#claimed) return;
      this.#freeTicks++;
      if (this.#freeTicks < this.#releaseTicks) return;
      this.#freeTicks = 0;
      this.#claimed = false;
      this.#emit(this.#options.onRelease);
    } catch (error) {
      this.#report(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#busyTicks = 0;
    this.#freeTicks = 0;
    if (!this.#claimed) return;
    this.#claimed = false;
    this.#emit(this.#options.onRelease);
  }

  #emit(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    try {
      this.#options.onError?.(error);
    } catch {}
  }
}

export interface MicClaimClock {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYSTEM_CLOCK: MicClaimClock = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface MicClaimPollerOptions {
  enabled: boolean;
  createWatcher(): MicClaimWatcher;
  clock?: MicClaimClock;
  intervalMs?: number;
  onError?(error: unknown): void;
}

/** Owns the default-off/live-enable timer without constructing a disabled detector. */
export class MicClaimPoller {
  readonly #options: MicClaimPollerOptions;
  readonly #clock: MicClaimClock;
  readonly #intervalMs: number;
  #watcher: MicClaimWatcher | null = null;
  #timer: unknown = null;

  constructor(options: MicClaimPollerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#intervalMs = options.intervalMs ?? 2_000;
    if (options.enabled) this.setEnabled(true);
  }

  get claimed(): boolean {
    return this.#watcher?.claimed ?? false;
  }

  setEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.#watcher) return;
      let watcher: MicClaimWatcher | null = null;
      try {
        watcher = this.#options.createWatcher();
        const timer = this.#clock.setInterval(() => watcher?.tick(), this.#intervalMs);
        (timer as { unref?(): void } | null)?.unref?.();
        this.#watcher = watcher;
        this.#timer = timer;
      } catch (error) {
        watcher?.close();
        this.#report(error);
      }
      return;
    }

    if (!this.#watcher && this.#timer === null) return;
    const watcher = this.#watcher;
    const timer = this.#timer;
    this.#watcher = null;
    this.#timer = null;
    if (timer !== null) {
      try {
        this.#clock.clearInterval(timer);
      } catch (error) {
        this.#report(error);
      }
    }
    watcher?.close();
  }

  tick(): void {
    this.#watcher?.tick();
  }

  close(): void {
    this.setEnabled(false);
  }

  #report(error: unknown): void {
    try {
      this.#options.onError?.(error);
    } catch {}
  }
}
