import { describe, expect, test } from "bun:test";
import { TheaterNavigation, type NavigationScheduler } from "../src/theater-navigation.ts";
import { commitLatestPanelRender } from "../src/panel.ts";

class FakeScheduler implements NavigationScheduler {
  callbacks = new Map<number, () => void>();
  nextId = 1;

  set(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  fire(id: number): void {
    const callback = this.callbacks.get(id);
    this.callbacks.delete(id);
    callback?.();
  }
}

describe("TheaterNavigation", () => {
  test("keeps the committed active anchor independent from the pending manual cursor", () => {
    const scheduler = new FakeScheduler();
    let changes = 0;
    const navigation = new TheaterNavigation(() => changes++, 2_500, scheduler);
    navigation.commitFrame("b", null);

    navigation.move(["a", "b", "c"], 1);
    expect(navigation.activeSessionId).toBe("b");
    expect(navigation.manualSelectedId).toBe("c");
    expect(navigation.paintedSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("b");

    navigation.commitFrame("b", navigation.manualSelectedId);
    expect(navigation.paintedSelectedId).toBe("c");
    expect(navigation.actionTarget("last")).toBe("c");
    expect(changes).toBe(1);
  });

  test("keeps the action target on the visibly selected session across fade expiry", () => {
    const scheduler = new FakeScheduler();
    let changes = 0;
    const navigation = new TheaterNavigation(() => changes++, 2_500, scheduler);
    navigation.commitFrame("a", null);
    navigation.move(["a", "b"], 1);
    navigation.commitFrame("a", navigation.manualSelectedId);

    expect(navigation.paintedSelectedId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");

    scheduler.fire(1);
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.paintedSelectedId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");
    expect(changes).toBe(2);

    navigation.commitFrame("a", navigation.manualSelectedId);
    expect(navigation.paintedSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("a");
  });

  test("manual controls never fall back to the active or last session", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("active", null);

    expect(navigation.actionTarget("last")).toBe("active");
    expect(navigation.manualControlTarget()).toBeNull();
  });

  test("manual controls target the live cursor before paint and stop at fade expiry", () => {
    const scheduler = new FakeScheduler();
    const navigation = new TheaterNavigation(() => {}, 2_500, scheduler);
    navigation.commitFrame("active", null);

    navigation.move(["active", "parked"], 1);
    expect(navigation.manualControlTarget()).toBe("parked");
    navigation.commitFrame("active", navigation.manualSelectedId);
    expect(navigation.paintedSelectedId).toBe("parked");

    scheduler.fire(1);
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.paintedSelectedId).toBe("parked");
    expect(navigation.manualControlTarget()).toBeNull();
  });

  test("re-arms the fade and ignores the stale timer", () => {
    const scheduler = new FakeScheduler();
    const navigation = new TheaterNavigation(() => {}, 2_500, scheduler);

    navigation.move(["a", "b", "c"], 1);
    navigation.move(["a", "b", "c"], 1);
    expect(navigation.manualSelectedId).toBe("b");
    expect(scheduler.callbacks.has(1)).toBe(false);
    expect(scheduler.callbacks.has(2)).toBe(true);

    scheduler.fire(1);
    expect(navigation.manualSelectedId).toBe("b");
    scheduler.fire(2);
    expect(navigation.manualSelectedId).toBeNull();
  });

  test("clears a vanished selection and falls back to the last session", () => {
    const scheduler = new FakeScheduler();
    const navigation = new TheaterNavigation(() => {}, 2_500, scheduler);
    navigation.move(["a", "b"], 1);
    navigation.commitFrame(null, navigation.manualSelectedId);
    expect(navigation.manualSelectedId).toBe("a");

    navigation.reconcile(new Set(["b"]));
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("a");
    navigation.commitFrame(null, navigation.manualSelectedId);
    expect(navigation.actionTarget("last")).toBe("last");
    expect(scheduler.callbacks.size).toBe(0);
  });

  test("moving off either edge releases manual control", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("a", null);
    navigation.move(["a", "b"], -1);
    expect(navigation.manualSelectedId).toBeNull();

    navigation.commitFrame("b", null);
    navigation.move(["a", "b"], 1);
    expect(navigation.manualSelectedId).toBeNull();
  });

  test("a superseded async render cannot mutate committed navigation or action state", async () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("seed", null);
    navigation.move(["seed", "new"], 1);

    let latestGeneration = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let paintCount = 0;
    const render = async (
      activeSessionId: string,
      visibleIds: ReadonlySet<string>,
      gate: Promise<void>,
    ): Promise<boolean> => {
      const generation = ++latestGeneration;
      await gate;
      return commitLatestPanelRender(generation, latestGeneration, () => {
        navigation.reconcile(visibleIds);
        paintCount++;
        navigation.commitFrame(activeSessionId, navigation.manualSelectedId);
      });
    };

    const first = render("old", new Set(["old"]), firstGate);
    const second = render("new", new Set(["new"]), Promise.resolve());
    expect(await second).toBe(true);
    expect(navigation.activeSessionId).toBe("new");
    expect(navigation.paintedSelectedId).toBe("new");
    expect(navigation.actionTarget("fallback")).toBe("new");

    releaseFirst();
    expect(await first).toBe(false);
    expect(paintCount).toBe(1);
    expect(navigation.activeSessionId).toBe("new");
    expect(navigation.manualSelectedId).toBe("new");
    expect(navigation.paintedSelectedId).toBe("new");
    expect(navigation.actionTarget("fallback")).toBe("new");
  });
});
