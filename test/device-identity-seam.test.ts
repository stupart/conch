import { expect, test } from "bun:test";
import { buildPublishedState, refreshPublishedConversationState, type PanelModel } from "../src/panel.ts";

test("complete documents retain their owner through empty rows and live refreshes", () => {
  const model: PanelModel = {
    rows: [], mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "", partial: "" }, reply: null, panelOpen: false,
  };
  const initial = buildPublishedState("owner-a", model, new Map(), new Set(["dismissed#12"]), 1);
  expect(initial.ownerDeviceId).toBe("owner-a");
  expect(initial.rows).toEqual([]);
  const next = refreshPublishedConversationState(initial, model.live, null, 2);
  expect(next.ownerDeviceId).toBe("owner-a");
  expect(next.dismissed).toEqual(["dismissed#12"]);
});
