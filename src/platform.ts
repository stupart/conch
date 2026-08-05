import { existsSync, readFileSync } from "node:fs";

/**
 * Platform seams — the one module that knows which OS conch is running on.
 *
 * conch was born on macOS (`say`, `afplay`, `osascript`, `pbcopy`, `ioreg`);
 * on Linux each of those has a different (or absent) counterpart. Every
 * platform-specific choice lives here so the rest of the code asks *what to
 * run* and never *which OS am I on*:
 *
 *   - darwin: unchanged — same binaries, same defaults.
 *   - wsl:    WSL2 with Windows interop. Audio in/out rides WSLg PulseAudio
 *             (paplay + sox's pulseaudio driver), the voice is Windows SAPI
 *             via powershell.exe, clipboard is clip.exe, and cue sounds come
 *             from C:\Windows\Media.
 *   - linux:  bare Linux — paplay/espeak-ng/wl-copy|xclip, freedesktop sounds.
 *
 * `CONCH_PLATFORM=darwin|wsl|linux` forces the answer (used by tests to pin
 * behavior regardless of the host).
 */
export type Platform = "darwin" | "wsl" | "linux";

const WINDOWS_MEDIA = "/mnt/c/Windows/Media";

let cachedIsWsl: boolean | null = null;

/** WSL2 kernels self-identify in /proc/version; WSL_DISTRO_NAME covers sudo/cron envs that scrub it. */
function isWslKernel(): boolean {
  if (cachedIsWsl === null) {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
      cachedIsWsl = true;
    } else {
      try {
        cachedIsWsl = readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
      } catch {
        cachedIsWsl = false;
      }
    }
  }
  return cachedIsWsl;
}

export function platform(env: Readonly<Record<string, string | undefined>> = process.env): Platform {
  const forced = env.CONCH_PLATFORM;
  if (forced === "darwin" || forced === "wsl" || forced === "linux") return forced;
  if (process.platform === "darwin") return "darwin";
  return isWslKernel() ? "wsl" : "linux";
}

/** First path that exists, else the last candidate (mirrors config.ts — doctor still reports a sensible expected path). */
function firstExisting(...candidates: string[]): string {
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}

// ---------------------------------------------------------------------------
// Speech (the `say` seam)
// ---------------------------------------------------------------------------

export interface SpeakOptions {
  /** TTS voice; empty string = platform default */
  voice: string;
  /** words per minute; 0 = platform default (~175) */
  sayRate: number;
  /** playback volume 0-1 (0.4 default was calibrated against macOS `say`, which is ~3.4x louder raw than Kokoro) */
  sayVolume: number;
}

/**
 * Build the argv that speaks `text` aloud on this platform.
 *  - darwin: `say`, with `[[volm]]` matching the measured Kokoro loudness.
 *  - wsl:    Windows SAPI via powershell.exe. The text crosses the interop
 *            boundary base64-encoded so no quoting/UTF-8 mangling is possible.
 *  - linux:  espeak-ng (best available offline voice without extra installs).
 */
export function speakArgs(opts: SpeakOptions, text: string, os: Platform = platform()): string[] {
  // Strip embedded [[...]] so spoken text can't smuggle say-engine commands
  // (and the other engines don't read the brackets aloud).
  const safe = text.replace(/\[\[|\]\]/g, "");
  switch (os) {
    case "darwin": {
      const flags = [
        ...(opts.voice ? ["-v", opts.voice] : []),
        ...(opts.sayRate > 0 ? ["-r", String(opts.sayRate)] : []),
      ];
      return ["say", ...flags, "--", `[[volm ${opts.sayVolume}]] ${safe}`];
    }
    case "wsl": {
      // SAPI Rate is -10..10 with 0 ≈ say's default ~175wpm; ~15wpm per step.
      const rate = opts.sayRate > 0 ? clamp(Math.round((opts.sayRate - 175) / 15), -10, 10) : 0;
      // sayVolume's 0.4 default compensates macOS say's raw loudness; SAPI
      // isn't hot like that, so 0.4 maps to full volume and scales down from there.
      const volume = clamp(Math.round((opts.sayVolume / 0.4) * 100), 0, 100);
      const b64 = Buffer.from(safe, "utf8").toString("base64");
      const voicePick = opts.voice
        ? `try { $s.SelectVoice('${opts.voice.replace(/'/g, "''")}') } catch {};`
        : "";
      const script =
        `Add-Type -AssemblyName System.Speech;` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
        `$s.Volume = ${volume}; $s.Rate = ${rate};` +
        voicePick +
        `$s.Speak([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')));`;
      return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
    }
    case "linux": {
      // espeak-ng: -a amplitude 0-200 (100 default), -s wpm. Same 0.4→full mapping as SAPI.
      const amplitude = clamp(Math.round((opts.sayVolume / 0.4) * 100), 0, 200);
      return [
        "espeak-ng",
        ...(opts.voice ? ["-v", opts.voice] : []),
        ...(opts.sayRate > 0 ? ["-s", String(opts.sayRate)] : []),
        "-a", String(amplitude),
        "--", safe,
      ];
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** The binary that speaks, for doctor/setup to check and name. */
export function speechBinary(os: Platform = platform()): string {
  return os === "darwin" ? "say" : os === "wsl" ? "powershell.exe" : "espeak-ng";
}

// ---------------------------------------------------------------------------
// Audio file playback (the `afplay` seam)
// ---------------------------------------------------------------------------

/** argv that plays an audio file (bell, mic cues, Kokoro wavs). paplay rides WSLg/desktop PulseAudio. */
export function playFileArgs(path: string, os: Platform = platform()): string[] {
  return [playBinary(os), path];
}

/** The binary that plays audio files, for doctor/setup to check and name. */
export function playBinary(os: Platform = platform()): string {
  return os === "darwin" ? "afplay" : "paplay";
}

/**
 * The packages a fresh box needs, by package manager. `conch setup` installs
 * these; doctor names them when something's missing. whisper is deliberately
 * absent — on Linux it's a source build (see setup), not a package.
 */
export function packageHints(os: Platform = platform()): { manager: string; install: string; packages: string[] } {
  if (os === "darwin") {
    return { manager: "brew", install: "brew install", packages: ["sox", "tmux", "whisper-cpp"] };
  }
  return {
    manager: "apt",
    install: "sudo apt-get install -y",
    // pulseaudio-utils gives paplay; libsox-fmt-all lets sox read the cue wavs.
    packages: ["sox", "libsox-fmt-all", "tmux", "pulseaudio-utils", ...(os === "linux" ? ["espeak-ng"] : [])],
  };
}

// ---------------------------------------------------------------------------
// Mic capture (sox environment)
// ---------------------------------------------------------------------------

/**
 * Extra env for the sox capture process. On Linux sox defaults to ALSA, but
 * the mic (WSLg's RDP source or a desktop pipewire-pulse) lives behind
 * PulseAudio — AUDIODRIVER steers `sox -d` there. The capture args themselves
 * are identical on every platform.
 */
export function captureEnv(os: Platform = platform()): Record<string, string> {
  return os === "darwin" ? {} : { AUDIODRIVER: "pulseaudio" };
}

// ---------------------------------------------------------------------------
// Clipboard (the `pbcopy` seam)
// ---------------------------------------------------------------------------

/** argv that reads stdin onto the clipboard, or null when no clipboard tool exists. */
export function clipboardArgs(os: Platform = platform()): string[] | null {
  switch (os) {
    case "darwin":
      return ["pbcopy"];
    case "wsl":
      // Windows interop puts System32 on PATH; clip.exe writes the *Windows*
      // clipboard, which is what a WSL user pastes from.
      return ["clip.exe"];
    case "linux":
      if (Bun.which("wl-copy")) return ["wl-copy"];
      if (Bun.which("xclip")) return ["xclip", "-selection", "clipboard"];
      if (Bun.which("xsel")) return ["xsel", "--clipboard", "--input"];
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sounds (bell + mic cues)
// ---------------------------------------------------------------------------

export interface CueSounds {
  /** mic opened, start talking */
  open: string;
  /** window closed on silence */
  close: string;
  /** dictation submitted */
  sent: string;
}

export function defaultBellSound(os: Platform = platform()): string {
  switch (os) {
    case "darwin":
      return "/System/Library/Sounds/Glass.aiff";
    case "wsl":
      return firstExisting(
        `${WINDOWS_MEDIA}/Windows Notify System Generic.wav`,
        `${WINDOWS_MEDIA}/notify.wav`,
      );
    case "linux":
      return firstExisting(
        "/usr/share/sounds/freedesktop/stereo/complete.oga",
        "/usr/share/sounds/freedesktop/stereo/bell.oga",
      );
  }
}

export function defaultCueSounds(os: Platform = platform()): CueSounds {
  switch (os) {
    case "darwin":
      return {
        open: "/System/Library/Sounds/Tink.aiff",
        close: "/System/Library/Sounds/Bottle.aiff",
        sent: "/System/Library/Sounds/Pop.aiff",
      };
    case "wsl":
      // Windows ships purpose-built speech-recognition cues — use them.
      return {
        open: firstExisting(`${WINDOWS_MEDIA}/Speech On.wav`, `${WINDOWS_MEDIA}/Windows Proximity Notification.wav`),
        close: firstExisting(`${WINDOWS_MEDIA}/Speech Off.wav`, `${WINDOWS_MEDIA}/Windows Menu Command.wav`),
        sent: firstExisting(`${WINDOWS_MEDIA}/Windows Ding.wav`, `${WINDOWS_MEDIA}/ding.wav`),
      };
    case "linux": {
      const stereo = "/usr/share/sounds/freedesktop/stereo";
      return {
        open: `${stereo}/dialog-information.oga`,
        close: `${stereo}/dialog-warning.oga`,
        sent: `${stereo}/message-sent-instant.oga`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/** osascript window focus/reveal/keystrokes — macOS only; elsewhere tmux injects and clipboard is the fallback. */
export function supportsUiScripting(os: Platform = platform()): boolean {
  return os === "darwin";
}

/** ioreg HID idle probe — macOS only; callers already fail safe (not idle) on null. */
export function supportsHidIdle(os: Platform = platform()): boolean {
  return os === "darwin";
}

/** Which service manager `conch service` should talk to. */
export function serviceManager(os: Platform = platform()): "launchd" | "systemd" {
  return os === "darwin" ? "launchd" : "systemd";
}
