/**
 * Where a publication can be seen, as the daemon truly knows it when it files one: what
 * `review_to_front` hands back as `surfaces`, so the agent tells the user where the result landed
 * instead of assuming they saw it.
 *
 * Feedback (2026-10-03): agents said "it's on your screen" for a result filed while the Mac app
 * was shut and no phone was connected. Each state below is something the daemon observes, never
 * something it hopes, and each says plainly how far it can be trusted:
 *
 * `mac`, conch's Mac app:
 * - `showing`: the app is running, and conch's own window was in front the last time the app
 *   reported what is on screen (it reports on every change of the front app: screen-context.ts).
 * - `running`: the app is running; the result waits behind its Ready pill.
 * - `not-running`: the app hasn't been heard from in `MAC_APP_SEEN_MS`. The daemon can't count
 *   the app's windows: the app reads the state file, not the socket. What it CAN hear is the app's
 *   health check, a `ping` every 5 s (DaemonHost, `DaemonHealth` in ConchDesign), and its screen
 *   reports, so the app is running while those keep arriving.
 *
 * `phone`, the paired iPhone:
 * - `connected`: a phone app is connected now, over the LAN or the relay. One just backgrounded
 *   can count for a little while before iOS closes its socket, so this can overstate.
 * - `paired-not-connected`: a phone has paired, and none is connected: it sees the result when its
 *   app next connects.
 * - `unpaired`: the phone bridge is on and no phone has ever paired.
 * - `off`: the `phone` setting is off.
 *
 * `audio`, what conch's voice does with it (the gate `announceReview` in voice-loop.ts keeps):
 * - `mac`: announced aloud on this Mac, after anything already being said.
 * - `phone`: the phone holds conch's audio, so the Mac stays quiet and the phone reads it.
 * - `other-mac`: this Mac has yielded its audio to another Mac, so nothing is said here.
 * - `manual`: conch, or this session, is in manual mode (or the session is hidden), so it was
 *   filed silently.
 */

export type MacSurface = "showing" | "running" | "not-running";
export type PhoneSurface = "connected" | "paired-not-connected" | "unpaired" | "off";
export type AudioSurface = "mac" | "phone" | "other-mac" | "manual";

export interface ReviewSurfaces {
  mac: MacSurface;
  phone: PhoneSurface;
  audio: AudioSurface;
}

export const MAC_SURFACES: readonly MacSurface[] = ["showing", "running", "not-running"];
export const PHONE_SURFACES: readonly PhoneSurface[] = ["connected", "paired-not-connected", "unpaired", "off"];
export const AUDIO_SURFACES: readonly AudioSurface[] = ["mac", "phone", "other-mac", "manual"];

/**
 * How long the Mac app counts as running after it was last heard from. Its health check pings
 * every 5 s; six of those, since macOS may stretch a hidden app's timers (App Nap) and a daemon
 * that says "not running" about an app in the menu bar sends the user looking for nothing.
 */
export const MAC_APP_SEEN_MS = 30_000;

/** Who a `ping` says it is from: the Mac app's health check says `mac-app` (DaemonHealth.swift). */
export const MAC_APP_PING_FROM = "mac-app";

/**
 * Whether a socket `ping` is the Mac app's. One saying `from: "mac-app"` is; one saying nothing is
 * too, since until 2026-10-03 only the app's health check sent a ping at all, and an app from
 * before then still sends it bare. One that names any other sender (a script, a probe) is not.
 */
export function isMacAppPing(body: Readonly<Record<string, unknown>>): boolean {
  return body.kind === "ping" && (body.from === undefined || body.from === MAC_APP_PING_FROM);
}

/** When the daemon last heard from its Mac app (`isMacAppPing`, a screen report). */
export class MacAppPresence {
  #lastAt: number | undefined;

  seen(at: number): void {
    this.#lastAt = at;
  }

  lastSeen(): number | undefined {
    return this.#lastAt;
  }

  /** Running, and showing when conch's own window was the last thing seen in front. */
  surface(now: number, showingKind: string | undefined): MacSurface {
    if (this.#lastAt === undefined || now - this.#lastAt > MAC_APP_SEEN_MS) return "not-running";
    return showingKind === "conch" ? "showing" : "running";
  }
}

/** The phone's state from the setting, the bridge's live client count and whether one ever paired. */
export function phoneSurface(phone: { enabled: boolean; clients: number; paired: boolean }): PhoneSurface {
  if (!phone.enabled) return "off";
  if (phone.clients > 0) return "connected";
  return phone.paired ? "paired-not-connected" : "unpaired";
}

/** Whether a value read off the socket is a `ReviewSurfaces` this conch knows how to say. */
export function isReviewSurfaces(value: unknown): value is ReviewSurfaces {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const surfaces = value as Record<string, unknown>;
  return MAC_SURFACES.includes(surfaces.mac as MacSurface)
    && PHONE_SURFACES.includes(surfaces.phone as PhoneSurface)
    && AUDIO_SURFACES.includes(surfaces.audio as AudioSurface);
}
