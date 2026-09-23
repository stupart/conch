import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// scripts/ui-snapshot.sh photographs the apps without the screen: the Mac app
// draws its own window (DebugSnapshot via `conch shot`), and a headless
// simulator renders a published-state fixture through the phone's DEBUG-only
// fixture mode. These pin that the fixture mode cannot reach Release, that it
// goes through the app's real decoder, and that the script keeps its hands off
// the screen and off any simulator it did not boot. Presence before absence.

const repo = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const iosDir = join(repo, "mobile", "conch-ios", "conch-ios");
const iosSources = readdirSync(iosDir)
  .filter((name) => name.endsWith(".swift"))
  .map((name) => readFileSync(join(iosDir, name), "utf8"));

/** How often `marker` appears, failing if any occurrence is outside an `#if DEBUG` branch. */
function debugOnlyCount(source: string, marker: string): number {
  let count = 0;
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + marker.length)) {
    count++;
    const before = source.slice(0, at);
    const opened = before.lastIndexOf("#if DEBUG");
    expect(opened).toBeGreaterThan(-1);
    // Neither closed nor switched to the #else branch since it opened.
    expect(Math.max(before.lastIndexOf("#endif"), before.lastIndexOf("#else"))).toBeLessThan(opened);
  }
  return count;
}

describe("phone fixture mode", () => {
  test("exists only in DEBUG: every mention, in every iOS source file, sits inside #if DEBUG", () => {
    for (const marker of ["conchFixture", "FixtureTransport", "fixtureURL"]) {
      const total = iosSources.reduce((sum, source) => sum + debugOnlyCount(source, marker), 0);
      expect(total).toBeGreaterThan(0);
    }
    // The ways in: the fixture file, the session to open, where it opens, the sheet to raise.
    const all = iosSources.join("\n");
    expect(all).toContain('UserDefaults.standard.string(forKey: "conchFixture")');
    expect(all).toContain('UserDefaults.standard.string(forKey: "conchFixtureSession")');
    expect(all).toContain('UserDefaults.standard.bool(forKey: "conchFixtureTop")');
    expect(all).toContain('UserDefaults.standard.bool(forKey: "conchFixtureReview")');
    // And which answer a recorded-history read gives, so the states above the live
    // window — loaded, partial, loading, off, failed — can each be photographed.
    expect(all).toContain('UserDefaults.standard.string(forKey: "conchFixtureHistory")');
  });

  test("the fixture reaches the UI through the app's own decoder, and deliverables are copies", () => {
    const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
    expect(bridge).toContain("JSONDecoder().decode(PublishedState.self, from: data)");
    const start = bridge.indexOf("final class FixtureTransport: BridgeTransport");
    expect(start).toBeGreaterThan(-1);
    const fixture = bridge.slice(start, bridge.indexOf("#endif", start));
    expect(fixture).toContain("onStateData?(data)");
    // The deliverable sheet deletes the file it is handed on dismiss.
    expect(fixture).toContain("copyItem(at:");
    expect(fixture).not.toContain("JSONDecoder");
    expect(fixture).not.toContain("moveItem");
  });

  test("the showcase fixture carries every state the phone has to draw", () => {
    const state = JSON.parse(read("mobile/conch-ios/fixtures/showcase.json"));
    const rows: any[] = state.rows;
    expect(rows.some((row) => row.backend === "claude")).toBe(true);
    expect(rows.some((row) => row.backend === "codex" && row.noTerminal)).toBe(true);
    expect(rows.some((row) => row.parentSessionId)).toBe(true);
    // A subagent whose parent is actually in the list, so nesting has something to nest.
    expect(rows.some((row) => row.parentSessionId && rows.some((p) => p.id === row.parentSessionId))).toBe(true);
    // More than one folder: with a single cwd the grouped list draws one header over
    // everything, which would make the sections look right while proving nothing.
    expect(new Set(rows.map((row) => row.cwd).filter(Boolean)).size).toBeGreaterThan(1);
    expect(rows.some((row) => row.status === "needs")).toBe(true);
    // A permission prompt with Allow / Deny, and a session whose only work is its agents.
    expect(rows.some((row) => row.status === "needs" && row.approval?.id && row.approval?.name)).toBe(true);
    expect(rows.some((row) => row.status === "working" && row.waitingOnAgents === true)).toBe(true);

    const items: any[] = Object.values(state.conversations).flatMap((c: any) => c.items);
    expect(items.some((item) => item.question?.options?.length > 1)).toBe(true);
    // Several questions in one call, still open: the card with one Submit for all of them.
    expect(items.some((item) => item.questions?.length > 1 && item.tool?.status === "running")).toBe(true);
    expect(items.some((item) => item.tool?.kind === "command_execution")).toBe(true);
    expect(items.some((item) => item.tool?.kind === "subagent")).toBe(true);

    const reply = state.conversations["claude-readability"].items.at(-1);
    expect(reply.kind).toBe("assistant");
    for (const piece of ["## ", "\n- ", "\n1. ", " `", "```swift", "| --- |", "](docs/architecture.md)", "](https://"]) {
      expect(reply.text).toContain(piece);
    }
    // The daemon caps a published item at 4,000 chars; a fixture past it lies.
    expect(reply.text.length).toBeLessThanOrEqual(4_000);

    const review = rows.find((row) => row.id === "claude-readability").review;
    expect(existsSync(join(repo, review.link))).toBe(true);
  });
});

describe("ui-snapshot.sh", () => {
  const script = read("scripts/ui-snapshot.sh");
  const code = script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

  test("boots only a shut-down simulator, headless, and always shuts it down", () => {
    expect(code).toContain("grep '(Shutdown)'");
    expect(code).toContain('xcrun simctl boot "$udid"');
    expect(code).toContain("trap 'xcrun simctl shutdown \"$udid\"");
    expect(code.indexOf("trap '")).toBeLessThan(code.indexOf('xcrun simctl boot "$udid"'));
    expect(code).not.toMatch(/open\s+(-\S+\s+)*-a\s+Simulator/);
  });

  test("never captures the screen: the Mac shot is the app drawing itself", () => {
    expect(code).toContain('bun "$root/src/cli.ts" shot "$out"');
    expect(code).toContain('xcrun simctl io "$udid" screenshot');
    expect(code).not.toContain("screencapture");
  });
});

describe("conch shot photographs what is actually on screen", () => {
  const snapshot = read("mac-app/conch-mac/DebugSnapshot.swift");

  test("the window's own appearance is adopted while drawing", () => {
    // The palette is dynamic colours — `NSColor(name: nil) { appearance in … }` — which resolve
    // against the CURRENT DRAWING appearance. An offscreen `cacheDisplay` does not inherit the
    // window's, so on a light system every snapshot came back DARK, and a night of "verified by
    // eye" was judged in a theme the user never sees. A screenshot tool that lies is worse than
    // none, because it is believed.
    expect(snapshot).toContain("window.effectiveAppearance.performAsCurrentDrawingAppearance {");
    // And the draw must happen INSIDE it: a wrapper that does not contain the call is decoration.
    const at = snapshot.indexOf("window.effectiveAppearance.performAsCurrentDrawingAppearance {");
    const inside = snapshot.slice(at, snapshot.indexOf("\n        }", at));
    expect(inside.length).toBeGreaterThan(40);
    expect(inside).toContain("view.cacheDisplay(in: view.bounds, to: rep)");
    // Exactly one draw, so a second one cannot creep in outside the appearance.
    expect(snapshot.match(/cacheDisplay\(/g) ?? []).toHaveLength(1);
  });

  test("a named window reaches the floating panels, and no name still means what it did", () => {
    // The conversation overlay is the surface under the heaviest iteration and the app
    // could not photograph it AT ALL: the candidate list excluded every FloatingPanel.
    expect(snapshot).toContain("case key, overlay, controlbar, dashboard, geometry");
    expect(snapshot).toContain("case .overlay: window = panels.first(where: isOverlay)");
    expect(snapshot).toContain("case .controlbar: window = panels.first { !isOverlay($0) }");
    // A one-line request is what every caller wrote before this existed. It still
    // resolves the key window among the NON-panels, exactly as it always did.
    expect(snapshot).toContain("let target = wanted.isEmpty ? Target.key : Target(rawValue: wanted) ?? Target.key");
    expect(snapshot).toContain("case .key: window = key ?? largest");
    expect(snapshot).toContain("let candidates = onScreen.filter { !($0 is FloatingPanel) }");
  });

  test("the overlay is found structurally, never by the autosave name it loses", () => {
    // `takesKeys` is set once at construction, on the fog and on nothing else.
    expect(snapshot).toContain("private static func isOverlay(_ panel: FloatingPanel) -> Bool { panel.takesKeys }");
    const floating = read("mac-app/conch-mac/FloatingPanels.swift");
    expect(floating.match(/takesKeys = true/g) ?? []).toHaveLength(1);
    // And the reason a name lookup was rejected: FloatingPanels BLANKS the autosave
    // name while the fog is collapsed or full screen, so a name-matching lookup would
    // find the overlay in the dull states and silently miss it in the interesting ones.
    expect(floating).toContain('fog.setFrameAutosaveName("")');
    expect(snapshot).not.toContain("conversationFrameName");
  });

  test("named windows did not weaken the allowlist", () => {
    // The request file is world-writable by nature. Naming a window must never have
    // turned this into a "write a PNG anywhere" tool.
    expect(snapshot).toContain('guard destination.hasPrefix("/tmp/"), destination.hasSuffix(".png") else { return }');
    // And the destination is still only ever the FIRST line of the request.
    expect(snapshot).toContain("let destination = lines.first?");
  });

  test("live geometry is written beside every shot, before the picture is taken", () => {
    // Three measurements in one session were invalidated by cropping to where a window
    // used to be. The sidecar is the cure: every window's frame as of the capture.
    expect(snapshot).toContain('"windows": described');
    expect(snapshot).toContain('"imageRect"');
    // A caret only exists where the keyboard focus is; a whole session went into
    // scanning for one in a field that had none.
    expect(snapshot).toContain('"firstResponder"');
    expect(snapshot).toContain('"isKeyWindow": window.isKeyWindow');
    // Light-against-dark for an hour: the overlay paints its own appearance.
    expect(snapshot).toContain('"overlayAppearance"');
    // Written BEFORE the draw, so the geometry is of the moment photographed.
    expect(snapshot.indexOf('destination + ".json"')).toBeLessThan(snapshot.indexOf("view.cacheDisplay"));
  });
});

describe("the overlay shoot rig", () => {
  const shoot = read("scripts/shoot-overlay.ts");

  test("state is driven by relaunch, because a write into a running app does nothing", () => {
    // Measured: the panel sat unmoved through 1.7s of polling after a `defaults write`.
    // `showWhatIsOn()` reads the collapsed key from init and from
    // UserDefaults.didChangeNotification, which another process's write does not fire.
    expect(shoot).toContain("await quitConch();");
    expect(shoot.indexOf("await quitConch();")).toBeLessThan(shoot.indexOf('"defaults", "write", DOMAIN, FRAME_KEY'));
    expect(shoot).toContain('await sh("open", "-a", APP);');
    // Never a pattern kill: it reaches whatever else matches, and has cost a session.
    expect(shoot).toContain('await sh("pgrep", "-f", `${APP}/Contents/MacOS/`)');
    // The argv entry, not the word: the file explains in prose why pkill is refused.
    expect(shoot).not.toContain('"pkill"');
  });

  test("a state that did not take is thrown, never photographed", () => {
    // The failure this rig exists to prevent: a lab resize that reported success and
    // silently did nothing, which invalidated an hour of comparisons.
    expect(shoot).toContain("The state did NOT take; nothing was photographed.");
    // Settled, not merely present — a shot taken mid-animation is a state nobody asked for.
    expect(shoot).toContain("const settled = now === last;");
    expect(shoot).toContain("if (!settled) continue;");
    // Full screen and size are absent from the MANIFEST itself rather than present and
    // silently no-ops. Sliced to the manifest, because the prose above it necessarily
    // names both to explain why they are missing.
    const manifest = shoot.slice(shoot.indexOf("const MANIFEST"), shoot.indexOf("type Rect"));
    expect(manifest.length).toBeGreaterThan(100);
    expect(manifest).not.toContain("fullScreen");
    expect(manifest).not.toContain("size");
    expect(shoot).toContain("cannot be driven from outside the app");
    // The size finding, measured: asked for 600x500, got the hardcoded 900x640.
    expect(shoot).toContain("restores the ORIGIN but not the SIZE");
  });

  test("the crop is taken from the sidecar the app just wrote, not from a remembered rect", () => {
    expect(shoot).toContain("const rect = overlayOf(sidecar)?.imageRect;");
    expect(shoot).toContain('"--screen"');
    // And the inset is clamped to the rect: a fixed one is wider than the collapsed
    // handle, and a negative crop is standardised into a valid rect somewhere else in
    // the image rather than refused — which measured the backdrop and called it the panel.
    expect(shoot).toContain("Math.min(rect.width, rect.height) / 4");
  });
});

describe("pixels.swift", () => {
  const measure = join(repo, "tools", "pixels.swift");
  const fixture = "/tmp/conch-pixels-fixture.png";

  // A scanner that reads rows bottom-up gives a perfectly mirrored, entirely plausible,
  // WRONG answer — "the caret sits below the glyph" when it sits above — and nothing in
  // the output looks wrong. The only way to pin it is geometry known in advance, so the
  // tool writes its own fixture: a caret mark at y 10...39 and ink at y 60...79, from the
  // TOP, deliberately asymmetric so a flipped scan cannot land on the same answer.
  test("rows are counted from the TOP", async () => {
    expect((await Bun.$`swift ${measure} synth ${fixture}`.quiet()).exitCode).toBe(0);
    const ink = (await Bun.$`swift ${measure} ink ${fixture}`.quiet()).stdout.toString();
    expect(ink).toContain("y 10...39");
    expect(ink).toContain("y 60...79");
    expect(ink).toContain("caret top is 50 px ABOVE the text top");
    // The mirrored answer, spelled out so a flip cannot pass by looking reasonable.
    expect(ink).not.toContain("BELOW the text top");
  }, 60_000);

  test("nothing found says NOT FOUND, and never a negative height", async () => {
    // The prototype reported an empty search as `y 44...-1  height -44`, which reads as
    // a broken measurement rather than an empty one. A session was lost to exactly that,
    // scanning for a caret in a field that had no keyboard focus, where "there is no
    // caret here" was the correct answer all along.
    expect((await Bun.$`swift ${measure} synth ${fixture}`.quiet()).exitCode).toBe(0);
    const empty = (await Bun.$`swift ${measure} ink ${fixture} 100 85 10 10`.quiet()).stdout.toString();
    expect(empty).toContain("caret  NOT FOUND");
    expect(empty).toContain("text   NOT FOUND");
    expect(empty).toContain("no comparison");
    expect(empty).not.toMatch(/h -\d/);
    expect(empty).not.toMatch(/\.\.\.-\d/);
  }, 60_000);

  test("a region with no area is refused, never standardised into a valid one", async () => {
    // CGRect turns a negative-width crop into a perfectly good rect somewhere else in
    // the image. A crop meant for a 144px panel came back as a 16px patch of backdrop
    // that way and reported it as the panel — mean 128.0, chroma 0.00, sd 0.00.
    expect((await Bun.$`swift ${measure} synth ${fixture}`.quiet()).exitCode).toBe(0);
    const bad = await Bun.$`swift ${measure} stats ${fixture} 50 50 -16 -16`.quiet().nothrow();
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("has no area");
  }, 60_000);
});
