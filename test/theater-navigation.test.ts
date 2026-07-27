import { describe, expect, test } from "bun:test";
import { TheaterNavigation } from "../src/theater-navigation.ts";
import { commitLatestPanelRender } from "../src/panel.ts";

describe("TheaterNavigation", () => {
  test("keeps the committed active anchor independent from the pending manual cursor", () => {
    let changes = 0;
    const navigation = new TheaterNavigation(() => changes++);
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

  test("keeps a parked selection across later active frames until explicit release", () => {
    let changes = 0;
    const navigation = new TheaterNavigation(() => changes++);
    navigation.commitFrame("a", null);
    navigation.move(["a", "b"], 1);
    navigation.commitFrame("a", navigation.manualSelectedId);

    expect(navigation.paintedSelectedId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");
    expect(navigation.manualControlTarget()).toBe("b");

    navigation.commitFrame("other-active", navigation.manualSelectedId);
    expect(navigation.activeSessionId).toBe("other-active");
    expect(navigation.manualSelectedId).toBe("b");
    expect(navigation.paintedSelectedId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");
    expect(navigation.manualControlTarget()).toBe("b");
    expect(changes).toBe(1);

    navigation.release();
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.paintedSelectedId).toBe("b");
    expect(navigation.actionTarget("last")).toBe("b");
    expect(changes).toBe(2);

    navigation.commitFrame("other-active", navigation.manualSelectedId);
    expect(navigation.paintedSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("other-active");
  });

  test("manual controls never fall back to the active or last session", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("active", null);

    expect(navigation.actionTarget("last")).toBe("active");
    expect(navigation.manualControlTarget()).toBeNull();
  });

  test("manual controls target the parked cursor before and after paint", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("active", null);

    navigation.move(["active", "parked"], 1);
    expect(navigation.manualControlTarget()).toBe("parked");
    navigation.commitFrame("active", navigation.manualSelectedId);
    expect(navigation.paintedSelectedId).toBe("parked");
    expect(navigation.manualSelectedId).toBe("parked");
    expect(navigation.manualControlTarget()).toBe("parked");
  });

  test("dispose clears active, pending, and painted identities", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.commitFrame("active", null);
    navigation.move(["active", "parked"], 1);
    navigation.commitFrame("active", navigation.manualSelectedId);

    navigation.dispose();

    expect(navigation.activeSessionId).toBeNull();
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.paintedSelectedId).toBeNull();
    expect(navigation.actionTarget()).toBeNull();
    expect(navigation.manualControlTarget()).toBeNull();
  });

  test("clears a vanished selection and falls back to the last session", () => {
    const navigation = new TheaterNavigation(() => {});
    navigation.move(["a", "b"], 1);
    navigation.commitFrame(null, navigation.manualSelectedId);
    expect(navigation.manualSelectedId).toBe("a");

    navigation.reconcile(new Set(["b"]));
    expect(navigation.manualSelectedId).toBeNull();
    expect(navigation.actionTarget("last")).toBe("a");
    navigation.commitFrame(null, navigation.manualSelectedId);
    expect(navigation.actionTarget("last")).toBe("last");
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
