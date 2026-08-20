import { describe, expect, test } from "bun:test";
import {
  RestoreSessionsOverlay,
  SessionActionsOverlay,
  type SessionActionsController,
  type SessionActionsTarget,
} from "../src/session-actions-overlay.ts";
import { TheaterNavigation } from "../src/theater-navigation.ts";
import type { SessionActionKey } from "../src/panel.ts";

class FakeController implements SessionActionsController {
  candidates = ["Nova", "Sage"];
  effective = "Nova";
  prioritized = new Set<string>();
  previews: Array<{ target: SessionActionsTarget; voice: string }> = [];
  pinned: Array<{ target: SessionActionsTarget; voice: string }> = [];
  resets: SessionActionsTarget[] = [];
  priorityWrites: Array<{ sessionId: string; prioritized: boolean }> = [];
  renames: Array<{ target: SessionActionsTarget; label: string }> = [];
  dismissals: SessionActionsTarget[] = [];
  closures: SessionActionsTarget[] = [];
  restorations: string[] = [];

  voiceCandidates(): readonly string[] {
    return this.candidates;
  }

  effectiveVoice(): string {
    return this.effective;
  }

  previewVoice(target: Readonly<SessionActionsTarget>, voice: string): void {
    this.previews.push({ target: { ...target }, voice });
  }

  setVoice(target: Readonly<SessionActionsTarget>, voice: string): void {
    this.pinned.push({ target: { ...target }, voice });
    this.effective = voice;
  }

  resetVoice(target: Readonly<SessionActionsTarget>): void {
    this.resets.push({ ...target });
    this.effective = "Sage";
  }

  isPrioritized(sessionId: string): boolean {
    return this.prioritized.has(sessionId);
  }

  setPrioritized(sessionId: string, prioritized: boolean): void {
    this.priorityWrites.push({ sessionId, prioritized });
    if (prioritized) this.prioritized.add(sessionId);
    else this.prioritized.delete(sessionId);
  }

  rename(target: Readonly<SessionActionsTarget>, label: string): string {
    this.renames.push({ target: { ...target }, label });
    return label;
  }

  dismiss(target: Readonly<SessionActionsTarget>): void {
    this.dismissals.push({ ...target });
  }

  async close(target: Readonly<SessionActionsTarget>): Promise<void> {
    this.closures.push({ ...target });
  }

  restore(sessionId: string): void {
    this.restorations.push(sessionId);
  }
}

function moveTo(overlay: SessionActionsOverlay, key: SessionActionKey): void {
  for (let count = 0; count < 5; count++) {
    const model = overlay.model()!;
    if (model.rows[model.selectedIndex]?.key === key) return;
    overlay.handleKey("\x1b[B");
  }
  throw new Error(`could not select ${key}`);
}

function createOverlay(controller = new FakeController(), lifecycle: string[] = []) {
  let changes = 0;
  const overlay = new SessionActionsOverlay({
    controller,
    onOpen: () => lifecycle.push("open"),
    onClose: () => lifecycle.push("close"),
    onChange: () => changes++,
  });
  return { overlay, controller, changes: () => changes };
}

describe("SessionActionsOverlay", () => {
  test("modal-trap keeps global keys inside the menu and lets only raw Ctrl-C fall through", () => {
    const { overlay } = createOverlay();
    expect(overlay.handleKey("q")).toBe(false);

    overlay.open({ sessionId: "a", label: "Alpha" });
    for (const key of ["q", "p", "m", "r", " ", "x", "!", "\t"]) {
      expect(overlay.handleKey(key)).toBe(true);
      expect(overlay.isOpen()).toBe(true);
    }
    expect(overlay.handleKey("\u0003")).toBe(false);
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.handleKey("\x1b")).toBe(true);
    expect(overlay.isOpen()).toBe(false);
    expect(overlay.handleKey("q")).toBe(false);
  });

  test("cursor-fade capture keeps targeting the parked session captured at open", () => {
    const { overlay, controller } = createOverlay();
    const navigation = new TheaterNavigation(() => {});
    navigation.move(["a", "b"], 1);
    const parked = navigation.manualControlTarget();
    expect(parked).toBe("a");
    const target = { sessionId: parked!, label: "Alpha" };

    overlay.open(target);
    target.sessionId = "b";
    target.label = "Beta";
    navigation.release(); // the production fade has the same release result
    expect(navigation.manualControlTarget()).toBeNull();

    moveTo(overlay, "prioritize");
    overlay.handleKey("\r");
    expect(controller.priorityWrites).toEqual([{ sessionId: "a", prioritized: true }]);
    expect(overlay.model()?.target).toEqual({ sessionId: "a", label: "Alpha" });

    // An accidental second open while the modal is live cannot retarget it.
    overlay.open({ sessionId: "b", label: "Beta" });
    expect(overlay.model()?.target.sessionId).toBe("a");
  });

  test("voice cycling starts from an out-of-ring effective voice, previews, pins, and resets", () => {
    const controller = new FakeController();
    controller.effective = "Legacy";
    controller.candidates = ["Nova", "Sage", "Nova", ""];
    const { overlay } = createOverlay(controller);
    overlay.open({ sessionId: "a", label: "Alpha" });

    expect(overlay.model()?.rows[0]).toMatchObject({
      key: "voice",
      value: "Legacy",
      selected: true,
    });
    overlay.handleKey("\x1b[C");
    expect(overlay.model()?.rows[0]).toMatchObject({ value: "Nova", ack: "preview" });
    expect(controller.previews).toEqual([{
      target: { sessionId: "a", label: "Alpha" },
      voice: "Nova",
    }]);

    overlay.handleKey("\r");
    expect(controller.pinned.at(-1)).toEqual({
      target: { sessionId: "a", label: "Alpha" },
      voice: "Nova",
    });
    expect(overlay.model()?.rows[0]?.ack).toBe("pinned");

    overlay.handleKey("a");
    expect(controller.resets).toEqual([{ sessionId: "a", label: "Alpha" }]);
    expect(overlay.model()?.rows[0]).toMatchObject({ value: "Sage", ack: "auto" });
  });

  test("prioritize toggles round-trip through the controller and semantic model", () => {
    const { overlay, controller } = createOverlay();
    overlay.open({ sessionId: "a", label: "Alpha" });
    moveTo(overlay, "prioritize");
    expect(overlay.model()?.rows[1]).toMatchObject({ value: "off", selected: true });

    overlay.handleKey("\r");
    expect(overlay.model()?.rows[1]).toMatchObject({
      value: "on",
      ack: "prioritized",
    });
    overlay.handleKey("\r");
    expect(overlay.model()?.rows[1]).toMatchObject({
      value: "off",
      ack: "normal order",
    });
    expect(controller.priorityWrites).toEqual([
      { sessionId: "a", prioritized: true },
      { sessionId: "a", prioritized: false },
    ]);
  });

  test("rename editing accepts the safe charset and Escape cancels editing, not the modal", () => {
    const { overlay, controller } = createOverlay();
    overlay.open({ sessionId: "a", label: "Alpha", backend: "claude", pid: 42 });
    moveTo(overlay, "rename");

    overlay.handleKey("\r");
    expect(overlay.model()?.rows[2]).toMatchObject({ editing: true, value: "Alpha" });
    overlay.handleKey(" X_2.-");
    overlay.handleKey("/");
    expect(overlay.model()?.rows[2]?.value).toBe("Alpha X_2.-");
    expect(controller.renames).toEqual([]);
    overlay.handleKey("\x1b");
    expect(overlay.isOpen()).toBe(true);
    expect(overlay.model()?.rows[2]).toMatchObject({
      editing: false,
      value: "Alpha",
      ack: "edit cancelled",
    });

    overlay.handleKey("\r");
    for (let count = 0; count < "Alpha".length; count++) overlay.handleKey("\x7f");
    overlay.handleKey("Beta 2");
    overlay.handleKey("\r");
    expect(controller.renames).toEqual([{
      target: { sessionId: "a", label: "Alpha", backend: "claude", pid: 42 },
      label: "Beta 2",
    }]);
    expect(overlay.model()?.target.label).toBe("Beta 2");
    expect(overlay.model()?.rows[2]).toMatchObject({
      editing: false,
      value: "Beta 2",
      ack: "renamed",
    });
  });

  test("dismiss needs two consecutive Enters, states that the session keeps running, then closes", () => {
    const lifecycle: string[] = [];
    const { overlay, controller } = createOverlay(new FakeController(), lifecycle);
    overlay.open({ sessionId: "a", label: "Alpha" });
    moveTo(overlay, "dismiss");
    expect(overlay.model()?.rows[3]?.help).toContain("session keeps running");

    overlay.handleKey("\r");
    expect(overlay.model()?.rows[3]).toMatchObject({
      value: "CONFIRM",
      confirming: true,
      ack: "press enter again to dismiss",
    });
    expect(controller.dismissals).toEqual([]);
    overlay.handleKey("q");
    expect(overlay.model()?.rows[3]?.confirming).toBeUndefined();
    expect(controller.dismissals).toEqual([]);

    overlay.handleKey("\r");
    overlay.handleKey("\r");
    expect(controller.dismissals).toEqual([{ sessionId: "a", label: "Alpha" }]);
    expect(overlay.isOpen()).toBe(false);
    expect(lifecycle).toEqual(["open", "close"]);
  });

  test("close needs confirmation and waits for the clean asynchronous exit", async () => {
    const lifecycle: string[] = [];
    const controller = new FakeController();
    const { overlay } = createOverlay(controller, lifecycle);
    overlay.open({ sessionId: "a", label: "Alpha" });
    moveTo(overlay, "close");
    expect(overlay.model()?.rows[4]?.help).toContain("clean Ctrl-D");

    overlay.handleKey("\r");
    expect(overlay.model()?.rows[4]).toMatchObject({
      value: "CONFIRM",
      confirming: true,
      ack: "press enter again to end cleanly",
    });
    expect(controller.closures).toEqual([]);

    overlay.handleKey("\r");
    expect(overlay.model()?.rows[4]).toMatchObject({ value: "closing…" });
    await Bun.sleep(0);
    expect(controller.closures).toEqual([{ sessionId: "a", label: "Alpha" }]);
    expect(overlay.isOpen()).toBeFalse();
    expect(lifecycle).toEqual(["open", "close"]);
  });
});

describe("RestoreSessionsOverlay", () => {
  test("selects and restores any dismissed session, then stays open for the rest", () => {
    const controller = new FakeController();
    const lifecycle: string[] = [];
    let changes = 0;
    const overlay = new RestoreSessionsOverlay({
      controller,
      onOpen: () => lifecycle.push("open"),
      onClose: () => lifecycle.push("close"),
      onChange: () => changes++,
    });
    overlay.open([
      { sessionId: "a", label: "Alpha" },
      { sessionId: "b", label: "Beta" },
      { sessionId: "c", label: "Gamma" },
    ]);
    overlay.handleKey("\x1b[B");
    overlay.handleKey("\r");
    expect(controller.restorations).toEqual(["b"]);
    expect(overlay.model()?.rows.map((row) => row.id)).toEqual(["a", "c"]);
    expect(overlay.isOpen()).toBeTrue();
    overlay.handleKey("\r");
    overlay.handleKey("\r");
    expect(controller.restorations).toEqual(["b", "c", "a"]);
    expect(overlay.isOpen()).toBeFalse();
    expect(lifecycle).toEqual(["open", "close"]);
    expect(changes).toBeGreaterThan(3);
  });

  test("does not open an empty tray and lets Ctrl-C reach shutdown", () => {
    const overlay = new RestoreSessionsOverlay({
      controller: new FakeController(),
      onChange() {},
    });
    overlay.open([]);
    expect(overlay.isOpen()).toBeFalse();
    overlay.open([{ sessionId: "a", label: "Alpha" }]);
    expect(overlay.handleKey("\u0003")).toBeFalse();
    expect(overlay.isOpen()).toBeTrue();
    expect(overlay.handleKey("\x1b")).toBeTrue();
    expect(overlay.isOpen()).toBeFalse();
  });
});
