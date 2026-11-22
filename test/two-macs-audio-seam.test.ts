import { describe, expect, test } from "bun:test";
import { reserveNormalMicForSink } from "../src/daemon.ts";
import { buildPublishedState, refreshPublishedConversationState, type PanelModel } from "../src/panel.ts";

/** C9b Cut B: the audio holder's published shape, and the mic reservation refusing while another Mac holds the audio. */
describe("Cut B published shape and mic reservation, executable", () => {
  const model: PanelModel = {
    rows: [], mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "", partial: "" }, reply: null, panelOpen: false,
  };

  test("the publisher emits the record and the outbox only when the daemon hands them over, and a live refresh keeps them", () => {
    const control = { holder: "mac-a", revision: 3, expiresAt: 9_000 };
    const outbox = [{ seq: 501, text: "done", voice: "af_heart", label: "conch", session: { ownerDeviceId: "b", localSessionKey: "k" }, at: 1 }];
    const published = buildPublishedState("b", model, new Map(), new Set(), 1, { audio: { control, outbox } });
    expect(published.audioControl).toEqual(control);
    expect(published.audioOutbox).toEqual(outbox);
    const refreshed = refreshPublishedConversationState(published, model.live, null, 2);
    expect(refreshed.audioControl).toEqual(control);
    expect(refreshed.audioOutbox).toEqual(outbox);
    const older = buildPublishedState("b", model, new Map(), new Set(), 1);
    expect(older).not.toHaveProperty("audioControl");
    expect(older).not.toHaveProperty("audioOutbox");
  });

  test("the mic is refused before waiting while another Mac holds the audio, and released if a yield lands during quiescence", async () => {
    let waited = false;
    const reservations: boolean[] = [];
    expect(await reserveNormalMicForSink({
      sink: () => "mac",
      voicedHere: () => false,
      shuttingDown: () => false,
      setReserved: (value) => reservations.push(value),
      quiescent: async () => { waited = true; },
    })).toBe(false);
    expect(waited).toBe(false);
    expect(reservations).toEqual([]);

    let local = true;
    expect(await reserveNormalMicForSink({
      sink: () => "mac",
      voicedHere: () => local,
      shuttingDown: () => false,
      setReserved: (value) => reservations.push(value),
      quiescent: async () => { local = false; },
    })).toBe(false);
    expect(reservations).toEqual([true, false]);
  });
});
