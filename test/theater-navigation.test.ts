import { describe, expect, test } from "bun:test";
import { TheaterNavigation, type NavigationScheduler } from "../src/theater-navigation.ts";

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
  test("keeps the active anchor independent from the transient manual cursor", () => {
    const scheduler = new FakeScheduler();
    let changes = 0;
    const navigation = new TheaterNavigation(() => changes++, 2_500, scheduler);
    navigation.setActive("b");

    navigation.move(["a", "b", "c"], 1);
    expect(navigation.activeSessionId).toBe("b");
    expect(navigation.manualSelectedId).toBe("c");
    expect(navigation.actionTarget("last")).toBe("c");
    expect(changes).toBe(1);

    scheduler.fire(1);
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.activeSessionId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");
    expect(changes).toBe(2);
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
    expect(navigation.manualSelectedId).toBe("a");

    navigation.reconcile(new Set(["b"]));
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("last");
    expect(scheduler.callbacks.size).toBe(0);
  });

  test("moving off either edge releases manual control", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.setActive("a");
    navigation.move(["a", "b"], -1);
    expect(navigation.manualSelectedId).toBeNull();

    navigation.setActive("b");
    navigation.move(["a", "b"], 1);
    expect(navigation.manualSelectedId).toBeNull();
  });
});
