#!/usr/bin/env bun
/**
 * Photograph the conversation overlay in NAMED, REPRODUCIBLE states — the app-side
 * twin of the design lab's `lab-tests/shoot.mjs`.
 *
 * THE WHOLE THING IN FIVE LINES:
 *   bun scripts/shoot-overlay.ts              every state in MANIFEST, into build/ui-shots/
 *   bun scripts/shoot-overlay.ts br-dark      just that one state
 *   bun scripts/shoot-overlay.ts --list       the state names, and what each one means
 *   swift tools/pixels.swift stats <png> [x y w h]   measure a shot (crop from <png>.json)
 *   swift tools/backdrop.swift 202020         a known ground under it all, by hand
 *
 * WHY IT DRIVES STATE THE SLOW WAY. "Docked bottom-right, dark" has to mean the same
 * thing twice or nothing measured against it means anything, and a session was lost
 * because it did not. Only SOME of the overlay's state can be driven at all:
 *
 *   appearance, tint, colour, scrim, blur, material   FloatingPanels re-reads these on
 *       a 0.5s timer, so a `defaults write` lands within half a second, no relaunch.
 *   corner, collapsed, shown                          read only at LAUNCH. Writing them
 *       into a running app does nothing at all: `showWhatIsOn()` runs from init and
 *       from UserDefaults.didChangeNotification, which another process's write does
 *       not fire. Measured, not assumed — the panel sat unmoved through 1.7s of
 *       polling. So this quits conch, writes the defaults, and launches it again.
 *   size                                              CANNOT be driven. The frame
 *       autosave default restores the ORIGIN but not the SIZE: the fog is a borderless,
 *       non-resizable NSPanel, and `place()` sets its content size to a hardcoded
 *       900x640 before restoring. Measured twice — asked for 480x360, got 900x640;
 *       asked for 600x500, got 900x640 — so size is REPORTED here, never requested.
 *   full screen                                       CANNOT be driven from outside at
 *       all; see the note at the bottom of this file. Neither appears in MANIFEST,
 *       rather than appearing there and quietly doing nothing.
 *
 * And nothing is believed: after driving a state this polls the app's own LIVE
 * geometry and refuses to photograph anything that is not where it was asked to be,
 * settled and unmoving. A lab resize that reported success and silently did nothing
 * invalidated an hour of comparisons; a capture that cannot prove its own state is
 * worth less than no capture, because it gets believed.
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const DOMAIN = "ai.blueprintstudio.conch";
const APP = "/Applications/conch.app";
/** Written by AppKit's frame autosave; read at launch by `FloatingPanels.place`. */
const FRAME_KEY = "NSWindow Frame conch.conversation";
const COLLAPSED_KEY = "conch.conversationCollapsed";
const SHOW_KEY = "conch.showConversation";
const APPEARANCE_KEY = "conch.overlay.appearance";

type Corner = "bl" | "br" | "tl" | "tr";
type State = {
  corner: Corner;
  appearance: "light" | "dark" | "auto";
  collapsed?: boolean;
  why: string;
};

/** The states worth having pictures of. Add one here and it is shot by name forever. */
const MANIFEST: Record<string, State> = {
  "bl-light": { corner: "bl", appearance: "light", why: "the reference: bottom-left, light" },
  "br-dark": { corner: "br", appearance: "dark", why: "the other corner, dark — the pair that gets compared" },
  "tr-dark": { corner: "tr", appearance: "dark", why: "top-right, tucked under the menu bar" },
  "br-light-collapsed": { corner: "br", appearance: "light", collapsed: true, why: "folded down to its handle" },
};

type Rect = { x: number; y: number; width: number; height: number };
type WindowInfo = {
  name: string;
  windowNumber: number;
  frame: Rect;
  imageRect?: Rect;
  screenFrame?: Rect;
  /** What the menu bar and the Dock leave over; AppKit constrains a window to it. */
  visibleFrame?: Rect;
  isVisible: boolean;
  isKeyWindow: boolean;
  firstResponder: string;
  appearance: string;
  backingScaleFactor: number;
  isOnMainDisplay?: boolean;
};
type Sidecar = {
  captured: string | null;
  target: string;
  windows: WindowInfo[];
  overlayAppearance: string;
  appIsActive: boolean;
  capturedAt: string;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sh(...argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out: out.trim() };
}

async function readDefault(key: string): Promise<string | null> {
  const { code, out } = await sh("defaults", "read", DOMAIN, key);
  return code === 0 ? out : null;
}

/** Quit conch, resolving PIDs and killing them one at a time.
 *
 * Never a pattern kill: it reaches whatever else happens to match it, and has already
 * cost this project a session's work (see scripts/build-app.sh). */
async function quitConch(): Promise<void> {
  const { out } = await sh("pgrep", "-f", `${APP}/Contents/MacOS/`);
  const pids = out.split(/\s+/).filter(Boolean);
  for (const pid of pids) await sh("kill", pid);
  for (let tries = 0; tries < 40 && pids.length; tries++) {
    if ((await sh("pgrep", "-f", `${APP}/Contents/MacOS/`)).out === "") return;
    await wait(100);
  }
}

/** Every conch window's live geometry, straight from the app, as of right now. */
async function geometry(): Promise<Sidecar | null> {
  const path = `/tmp/conch-shoot-geometry-${Date.now()}.png`;
  const { code } = await sh("bun", join(root, "src/cli.ts"), "shot", path, "--window", "geometry");
  if (code !== 0 || !existsSync(`${path}.json`)) return null;
  return JSON.parse(readFileSync(`${path}.json`, "utf8")) as Sidecar;
}

const overlayOf = (sidecar: Sidecar | null) => sidecar?.windows.find((w) => w.name === "overlay") ?? null;

const leadingOf = (corner: Corner) => corner === "bl" || corner === "tl";
const bottomOf = (corner: Corner) => corner === "bl" || corner === "br";

/** Where FogDock puts a fog of this size in this corner: flush into the screen's own
 * frame, two edges touching. Mirrors ConchDesign's `FogDock.frame`. */
function dockedFrame(corner: Corner, size: { width: number; height: number }, screen: Rect): Rect {
  const width = Math.min(size.width, screen.width);
  const height = Math.min(size.height, screen.height);
  return {
    x: leadingOf(corner) ? screen.x : screen.x + screen.width - width,
    y: bottomOf(corner) ? screen.y : screen.y + screen.height - height,
    width,
    height,
  };
}

/** Which of the screen's two rectangles this frame is docked flush into, if either.
 *
 * Corner rather than exact frame, because the SIZE is the app's to choose and not ours
 * to request (see the header). Two answers both count as docked: FogDock computes
 * against the screen's FULL frame, so the fog is meant to reach under the menu bar, but
 * AppKit constrains a restored frame to the VISIBLE frame, so at launch a top corner
 * comes up 33 points short of the real top edge. Saying WHICH one it matched beats
 * failing a legitimate state, and beats passing it without saying so. */
function dockedIn(corner: Corner, frame: Rect, screen: Rect, visible?: Rect): "screen" | "visible" | null {
  const flush = (area: Rect) => {
    const x = leadingOf(corner)
      ? Math.abs(frame.x - area.x)
      : Math.abs(frame.x + frame.width - (area.x + area.width));
    const y = bottomOf(corner)
      ? Math.abs(frame.y - area.y)
      : Math.abs(frame.y + frame.height - (area.y + area.height));
    return x < 2 && y < 2;
  };
  if (flush(screen)) return "screen";
  if (visible && flush(visible)) return "visible";
  return null;
}

/** Put the overlay into `state` and PROVE it got there, or throw saying what happened
 * instead. Returns the overlay's live geometry, freshly read. */
async function drive(name: string, state: State): Promise<{ overlay: WindowInfo; docked: string }> {
  // The screen and the current size both have to come from the app, before it is quit:
  // the origin to write is computed against the real screen and the size the panel
  // actually has, never an assumed 1728x1117 or an assumed 900x640.
  const before = await geometry();
  const screen = overlayOf(before)?.screenFrame ?? before?.windows.find((w) => w.screenFrame)?.screenFrame;
  if (!screen) throw new Error("conch is not running, or reported no screen — start conch.app first");
  const size = overlayOf(before)?.frame ?? { width: 900, height: 640 };
  const target = dockedFrame(state.corner, size, screen);

  await quitConch();
  // The screen half of the autosave string is AppKit's own bookkeeping (it reconciles
  // a frame saved on a screen that has since changed). Keep whatever it last wrote and
  // change only the window half. Only the ORIGIN of that half survives the trip, and
  // only its midpoint really matters: `FogCorner.nearest` reads the corner off it and
  // `dock()` then snaps the panel flush.
  const saved = (await readDefault(FRAME_KEY)) ?? `0 0 0 0 ${screen.x} ${screen.y} ${screen.width} ${screen.height}`;
  const screenHalf = saved.trim().split(/\s+/).slice(4).join(" ");
  await sh("defaults", "write", DOMAIN, FRAME_KEY, `${target.x} ${target.y} ${target.width} ${target.height} ${screenHalf} `);
  await sh("defaults", "write", DOMAIN, COLLAPSED_KEY, "-bool", state.collapsed ? "YES" : "NO");
  await sh("defaults", "write", DOMAIN, SHOW_KEY, "-bool", "YES");
  // Live-tunable, but written here too: read at launch it is right from the first
  // frame, with none of the light-to-dark crossfade to wait out.
  await sh("defaults", "write", DOMAIN, APPEARANCE_KEY, "-string", state.appearance);
  await sh("open", "-a", APP);

  // Settled, not merely present: the panel animates into its corner, and a shot taken
  // on the way there is a picture of a state nobody asked for. Caught in practice —
  // a poll saw 896x636 one tick before the 900x640 it settled at.
  let last = "";
  for (let tries = 0; tries < 60; tries++) {
    await wait(250);
    const overlay = overlayOf(await geometry());
    if (!overlay?.isVisible) continue;
    const { x, y, width, height } = overlay.frame;
    const now = [x, y, width, height].map(Math.round).join(",");
    const settled = now === last;
    last = now;
    if (!settled) continue;
    if (state.collapsed) {
      // The handle is a small square docked in the corner; its side is the app's to
      // choose, so this checks the shape and the corner, not a number the app owns.
      const inCorner = (leadingOf(state.corner) ? x < screen.width / 2 : x > screen.width / 2)
        && (bottomOf(state.corner) ? y < screen.height / 2 : y > screen.height / 2);
      if (width < 200 && Math.abs(width - height) < 1 && inCorner) return { overlay, docked: "collapsed" };
      throw new Error(
        `${name}: asked for collapsed in ${state.corner}, settled as ${width}x${height} at ${x},${y}.`
        + " The state did NOT take; nothing was photographed.",
      );
    }
    const where = dockedIn(state.corner, overlay.frame, screen, overlay.visibleFrame);
    if (where) return { overlay, docked: `${state.corner}/${where}` };
    throw new Error(
      `${name}: asked to dock in ${state.corner} of ${screen.width}x${screen.height}`
      + ` — settled at ${width}x${height} at ${x},${y}. The state did NOT take; nothing was photographed.`,
    );
  }
  throw new Error(`${name}: the overlay never settled (last frame ${last || "never seen"})`);
}

/** A known ground under a translucent panel. Resolves once it is actually up. */
async function startBackdrop(hex: string) {
  const proc = Bun.spawn(["swift", join(root, "tools/backdrop.swift"), hex], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !text.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  if (!text.includes("ready")) throw new Error("the backdrop never reported ready");
  return proc;
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--list") || args.includes("-h") || args.includes("--help")) {
    for (const [name, state] of Object.entries(MANIFEST)) {
      console.log(`  ${name.padEnd(20)} ${state.corner} ${state.appearance}${state.collapsed ? " collapsed" : ""} — ${state.why}`);
    }
    console.log("\n  the panel's size and its full-screen mode cannot be driven from outside the app,");
    console.log("  so neither is a state here; size is reported as whatever it actually was.");
    return;
  }
  const named = args.filter((arg) => !arg.startsWith("--"));
  const unknown = named.filter((name) => !MANIFEST[name]);
  if (unknown.length) throw new Error(`unknown state(s): ${unknown.join(", ")} — try --list`);
  const chosen = named.length ? named : Object.keys(MANIFEST);
  const out = process.env.OUT ?? join(root, "build/ui-shots");
  const hex = process.env.BACKDROP ?? "808080";
  mkdirSync(out, { recursive: true });

  // Put the user's own overlay back exactly as it was. This drives his live UI, and
  // leaving it parked in a lab state is not the rig's to do.
  const restore: Record<string, string | null> = {};
  for (const key of [FRAME_KEY, COLLAPSED_KEY, SHOW_KEY, APPEARANCE_KEY]) restore[key] = await readDefault(key);

  const backdrop = args.includes("--no-backdrop") ? null : await startBackdrop(hex);
  const rows: string[] = [];
  try {
    for (const name of chosen) {
      const state = MANIFEST[name]!;
      const { overlay, docked } = await drive(name, state);
      const screenShot = join(out, `${name}.png`);
      await sh("bun", join(root, "src/cli.ts"), "shot", screenShot, "--screen");
      // The app's own allowlist is /tmp, so the window shot is taken there and copied.
      const windowShot = `/tmp/conch-shoot-${name}.png`;
      const drawn = await sh("bun", join(root, "src/cli.ts"), "shot", windowShot, "--window", "overlay");
      if (drawn.code === 0) copyFileSync(windowShot, join(out, `${name}-window.png`));

      // Measured off the FULL-SCREEN shot, cropped to the rect the app reported at the
      // moment of capture — the only crop that cannot be aimed at a stale position.
      const sidecar = existsSync(`${screenShot}.json`)
        ? (JSON.parse(readFileSync(`${screenShot}.json`, "utf8")) as Sidecar)
        : null;
      const rect = overlayOf(sidecar)?.imageRect;
      let measured = "no imageRect in the sidecar";
      if (rect) {
        // Inset well inside the panel, clear of its rounded edge and its shadow —
        // CLAMPED to the rect. A fixed inset is wider than the whole collapsed handle,
        // and a negative crop does not fail: CGRect standardises it into a valid rect
        // elsewhere in the image, so the collapsed state measured a patch of plain
        // backdrop (128.0, chroma 0.00, sd 0.00) and reported it as the panel.
        const inset = Math.max(0, Math.min(80, Math.floor(Math.min(rect.width, rect.height) / 4)));
        const { out: stats } = await sh(
          "swift", join(root, "tools/pixels.swift"), "stats", screenShot,
          String(Math.round(rect.x + inset)), String(Math.round(rect.y + inset)),
          String(Math.round(rect.width - inset * 2)), String(Math.round(rect.height - inset * 2)),
        );
        measured = stats.split("\n").slice(1).join(" | ");
      }
      rows.push(`${name.padEnd(20)} ${overlay.frame.width}x${overlay.frame.height} @ ${overlay.frame.x},${overlay.frame.y} ${docked.padEnd(12)} ${sidecar?.overlayAppearance ?? "?"}  ${measured}`);
      console.log(`✓ ${rows.at(-1)}`);
    }
  } finally {
    backdrop?.kill();
    if (!args.includes("--keep")) {
      await quitConch();
      for (const [key, value] of Object.entries(restore)) {
        if (value === null) await sh("defaults", "delete", DOMAIN, key);
        else await sh("defaults", "write", DOMAIN, key, value);
      }
      await sh("open", "-a", APP);
    }
  }
  console.log(`\n${rows.length} state(s) in ${out}${args.includes("--keep") ? " (overlay left in the last state: --keep)" : " (overlay restored)"}`);
}

// WHAT COULD NOT BE DRIVEN HONESTLY, and what each would take:
//
// SIZE. Writing the frame autosave default moves the panel but never resizes it:
// `place()` calls `setContentSize(900x640)` and then `setFrameUsingName`, which for a
// borderless, non-resizable NSPanel restores the origin only. Asked for 480x360 and
// for 600x500; got 900x640 both times. It would take one line in FloatingPanels.swift:
// read the wanted size out of a default in `place()`, or give the panel `.resizable`.
//
// FULL SCREEN. `FloatingPanels.toggleFullScreen()` is reachable only from the fog's own
// button and from Command-Return inside the panel; there is no default behind it, and
// `FloatingPanels.installed` is private. Nothing outside the app can ask for it, so it
// is absent here — a state that silently did nothing is exactly the failure this script
// exists to prevent. It would take one line in FloatingPanels.swift: read a
// `conch.conversationFullScreen` default in `showWhatIsOn()`, beside the collapsed one
// it already reads.
//
// VOICE STATE. The fog's colour follows the daemon's live state through the store.
// Faking it means faking a published daemon state, which is a fixture harness the Mac
// app does not have (the phone does: `-conchFixture`). Not cheap, so not attempted.
await main();
