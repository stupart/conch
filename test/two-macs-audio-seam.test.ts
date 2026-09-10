import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reserveNormalMicForSink } from "../src/daemon.ts";
import { buildPublishedState, refreshPublishedConversationState, type PanelModel } from "../src/panel.ts";

/**
 * C9b Cut B, wired. `runDaemon` runs in no test, so every site the design
 * names is pinned by exact text. Presence is asserted before ordering:
 * `indexOf` returns -1 for a missing marker and -1 sorts before everything.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const daemon = source("src/daemon.ts");
// Ignore line comments so a description of a site cannot satisfy a guard.
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");

function at(text: string, marker: string, from = 0): number {
  const index = text.indexOf(marker, from);
  expect(index, `missing: ${marker}`).toBeGreaterThan(-1);
  return index;
}
function section(text: string, start: string, end: string): string {
  const a = at(text, start);
  const b = at(text, end, a);
  return text.slice(a, b);
}
function ordered(text: string, ...markers: string[]): void {
  let position = 0;
  for (const marker of markers) position = at(text, marker, position) + marker.length;
}
function count(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("Cut B daemon wiring, by site", () => {
  const run = daemon.slice(at(daemon, "export async function runDaemon("));

  test("the holder, outbox and seen-set exist once, seeded from the clock (F9, F12)", () => {
    expect(count(run, "new AudioHolder()")).toBe(1);
    expect(count(run, "new AudioOutbox(Date.now())")).toBe(1);
    expect(count(run, "new PresentedItems(Date.now())")).toBe(1);
  });

  test("the speech gate is the exported predicate over holder AND phone sink", () => {
    const gate = section(run, "const speech = new SpeechManager(", "warn: log,");
    expect(gate).toContain("speechAllowedHere(audioHolder.holder, audioLease.sink)");
    expect(gate).not.toContain('audioLease.sink === "phone"');
  });

  test("the mic reservation consults the holder as well as the sink", () => {
    const reserve = section(run, "const reserveNormalMic = async", "const speakBlocker =");
    expect(reserve).toContain("sink: () => audioLease.sink,");
    expect(reserve).toContain("voicedHere: () => audioHolder.isLocal(),");
  });

  test("the eligibility predicate is unchanged and `voicedHere` sits beside it (F1)", () => {
    const turn = section(run, "const controlledTurn = shouldHandleTurnAudibly(event, cfg.workingMic);", "// Nobody's there:");
    ordered(
      turn,
      'const audibleTurn = controlledTurn && audioLease.sink === "mac";',
      "const voicedHere = audibleTurn && audioHolder.isLocal();",
      "sessionGoneFromSnapshot(",
    );
    // The checks below still run on `audibleTurn`, not on `voicedHere`.
    expect(turn).toContain("if (!audibleTurn) return;");
    expect(turn).toContain("gateTurnForControls(event, controlledTurn");
  });

  test("the idle probe is this Mac's presence, skipped while yielded (F7)", () => {
    expect(run).toContain('if (event.type !== "wake" && event.type !== "recite" && cfg.awayAfterSecs && audioHolder.isLocal()) {');
  });

  test("a wake is refused before the courtesy line on a yielded daemon", () => {
    const wake = section(run, 'if (event.type === "wake") {\n      // C9b', 'await conversationLoop(target, "", undefined, undefined, undefined, undefined, undefined, undefined, false, pauseGeneration);');
    ordered(
      wake,
      "const heldBy = presentedTo(audioHolder.holder, audioLease.sink);",
      "if (heldBy) return log(`wake refused",
      "resolveWakeTarget(",
      "Nothing to wake",
      "That session is closed.",
      "Mic open for",
    );
  });

  test("`voicedHere` gates the bell and outbox site 1 hands the announce over before any reading (F6)", () => {
    const announce = section(run, "// The hook hands the bell to the daemon", "await conversationLoop(\n        event,\n        announce.heard,");
    ordered(
      announce,
      "if (voicedHere) await ringBell();",
      "if (audibleTurn && !voicedHere) {",
      "presentElsewhere(audioHolder.holder, event.announce, voiceFor(cfg, event.label), event.label, event.sessionId);",
      "lastTurn = event;",
      "return;",
      "const announce = await speakInterruptible(",
      // The re-speak on a noise blip is the second speak site; it stays
      // behind the same return, so a yielded daemon never reaches it.
      "await speakInterruptible(event, event.announce, true, undefined, undefined, interruptedByPause);",
    );
    expect(announce).not.toContain("if (audibleTurn) await ringBell();");
    expect(announce).not.toContain("speech.speak(");
  });

  test("outbox site 2 is `speak` for volunteered lines only, between the manual check and the state change (F3, F6)", () => {
    const speak = section(run, "const speak = async (", "await speech.speak(");
    ordered(
      speak,
      "normalMicOpen()",
      "pause.paused && !volunteered",
      "const holder = presentedTo(audioHolder.holder, audioLease.sink);",
      "if (holder) {",
      "if (volunteered) presentElsewhere(holder, text, voiceFor(speechCfg, label), label, sessionId);",
      "return;",
      'setState("speaking", label);',
      'if (audioLease.sink === "phone") {',
      "armPhoneSpeechLatch(text);",
    );
    // Exactly two outbox sites (the helper is an arrow, so only calls carry the paren).
    expect(count(run, "presentElsewhere(")).toBe(2);
    expect(count(run, "audioOutbox.push(")).toBe(1);
    // The volunteered callers name their session so the holder can too.
    expect(run).toContain("await speak(cfg, `${target.label}:`, target.label, true, target.sessionId);");
    expect(run).toContain('return speak(speechCfg, event.announce, event.voice ? "" : event.label, true, event.sessionId);');
  });

  test("`speakInterruptible` returns before speaking or arming a recorder unless the holder is local", () => {
    const interruptible = section(run, "async function speakInterruptible(", "/** Inject a prompt utterance and report how it went. */");
    const guard = 'if (audioLease.isPhone() || !audioHolder.isLocal()) return { heard: "", cut: false };';
    expect(count(interruptible, guard)).toBe(3);
    ordered(interruptible, guard, 'setState("speaking", event.label);', "await speech.quiescent();", guard, "armBargeRecorder(");
  });

  test("the conversation-loop mic refusal covers the other Mac holding the ear", () => {
    const loop = section(run, "async function conversationLoop(", 'log(`listening → ');
    ordered(
      loop,
      "if (audioLease.isPhone() || !audioHolder.isLocal()) {",
      "mic held —",
      'micCue(cfg, "open")',
    );
  });

  test("the phone-only sites are untouched: the phone still wins on its daemon (F2)", () => {
    const fallback = section(run, "onClientsChanged: (count) => {", "acceptUpload:");
    expect(fallback).toContain("if (audioLease.clientsChanged(count)) {");
    expect(fallback).not.toContain("audioHolder");
    const latch = section(run, 'if (message.kind === "phone-speaking") {', 'if (message.kind === "open-pairing") {');
    expect(latch).toContain("if (audioLease.isPhone()) {");
    expect(latch).not.toContain("audioHolder");
    const claim = section(run, 'if (message.kind === "audio-sink") {', 'if (message.kind === "audio-take"');
    expect(claim).toContain("const claimingPhone = requested === \"phone\"");
    expect(claim).not.toContain("audioHolder");
  });

  test("the device entry stays synchronous and the transfer mirrors the phone claim: cancels, then the record, then the ack (F5)", () => {
    const device = section(run, "function deviceCommand(message: DeviceCommand): DeviceControlResponse {", "const controlServer = createControlServer({");
    expect(device).not.toContain("await ");
    const take = section(device, 'if (message.kind === "audio-take" || message.kind === "audio-release") {', 'if (message.kind === "audio-yield") {');
    ordered(take, 'message.kind === "audio-take" ? audioHolder.take() : audioHolder.release();', "armHolderExpiry(null);", 'return { kind: "audio-ack", revision: record.revision };');
    const yielded = section(device, 'if (message.kind === "audio-yield") {', 'if (message.kind === "audio-present") {');
    ordered(
      yielded,
      "const verdict = audioHolder.assess(holder, revision);",
      'if (verdict === "stale") {',
      'code: "stale-revision"',
      'if (verdict === "grant") {',
      "speech.cancelCurrent();",
      "speech.cancelPendingAudio();",
      'activeDictation?.requestExternal("spacebar", "audio-yield");',
      "void Promise.resolve(killActiveRecorders()).catch(() => {});",
      "const outcome = audioHolder.yield(holder, revision, leaseMs);",
      "armHolderExpiry(outcome.record.expiresAt);",
      'return { kind: "audio-ack", revision: outcome.record.revision, stopped: verdict === "grant" };',
    );
    // The same four steps the phone claim runs, in the same order.
    const claim = section(device, "if (claimingPhone) {", "const wanted = audioLease.request(");
    ordered(claim, "speech.cancelCurrent();", "speech.cancelPendingAudio();", 'activeDictation?.requestExternal("spacebar"', "killActiveRecorders()");
  });

  test("a presented item goes through `speak` and is recorded only when it will be enqueued (F4)", () => {
    const device = section(run, "function deviceCommand(message: DeviceCommand): DeviceControlResponse {", "const controlServer = createControlServer({");
    const present = section(device, 'if (message.kind === "audio-present") {', 'if (message.kind === "phone-spoke") {');
    ordered(
      present,
      "const admission = presented.check(source, seq, at);",
      'if (admission !== "admit") return { kind: "audio-error", code: "dropped" };',
      "if (speakBlocker(false) || !speechAllowedHere(audioHolder.holder, audioLease.sink)) {",
      'return { kind: "audio-error", code: "held" };',
      "presented.record(source, seq);",
      "const heading = `${host || source.slice(0, 8)} · ${label}`;",
      "void speak(voice ? { ...cfg, ttsVoices: [voice] } : cfg, text, heading)",
      'return { kind: "audio-ack", revision: audioHolder.record.revision, seq };',
    );
    expect(present).not.toContain("speech.speak(");
    expect(count(run, "presented.record(")).toBe(1);
    // The blocker mirrors the two checks at the top of `speak`.
    const blocker = section(run, "const speakBlocker = (volunteered: boolean)", "const presentElsewhere =");
    expect(blocker).toContain('normalMicOpen() ? "mic-open" : pause.paused && !volunteered ? "manual" : null');
  });

  test("audioControl and audioOutbox are published on every complete document", () => {
    const publish = section(run, "lastPublishedPanelState = buildDaemonPublishedState(", "publishedStateWriter.request();");
    expect(publish).toContain("{ control: audioHolder.record, outbox: audioOutbox.items },");
    const builder = section(daemon, "export function buildDaemonPublishedState(", "export async function rehydrateLatestTurns(");
    expect(builder).toContain("audio?: { control: AudioControl; outbox: AudioOutboxItem[] },");
    expect(builder).toContain("...(audio ? { audio } : {}),");
    // Handing a line over republishes, so the holder's observer sees it.
    const hand = section(run, "const presentElsewhere =", "const armHolderExpiry =");
    ordered(hand, "audioOutbox.push({ text, voice, label, session: { ownerDeviceId, localSessionKey } });", "void renderSessionPanel();");
  });

  test("a lapsed lease republishes so the window sees audio return", () => {
    const expiry = section(run, "const armHolderExpiry =", "const speak = async (");
    ordered(expiry, "if (!audioHolder.isLocal()) return;", "audio lease expired", "void renderSessionPanel();");
  });
});

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

describe("Cut B Swift, by site", () => {
  const models = swift("Models.swift");
  const holder = swift("AudioHolderStore.swift");
  const dashboard = swift("DashboardView.swift");
  const composer = swift("ComposerView.swift");
  const app = swift("ConchMacApp.swift");

  test("the record decodes with a local default and `hasSamePresentation` compares it but never the outbox (F13)", () => {
    expect(models).toContain("let audioControl: AudioControl");
    expect(models).toContain("let audioOutbox: [AudioOutboxItem]");
    expect(models).toContain("audioControl = (try? container.decodeIfPresent(AudioControl.self, forKey: .audioControl)) ?? AudioControl()");
    expect(models).toContain("audioOutbox = Self.decodeLossyArray(AudioOutboxItem.self, from: container, forKey: .audioOutbox)");
    const comparison = section(models, "func hasSamePresentation", "\n    }");
    expect(comparison).toContain("&& audioControl == other.audioControl");
    expect(comparison).not.toContain("audioOutbox");
    expect(models).toContain('init(holder: String = "local", revision: Int = 0, expiresAt: TimeInterval? = nil)');
    // The rebuild carries both, or a poll silently drops them (see the memberwise-init note there).
    const rebuild = section(swift("StateStore.swift"), "let next = PublishedState(", "if state?.hasSamePresentation(as: next) != true");
    expect(rebuild).toContain("audioControl: sourceState.audioControl,");
    expect(rebuild).toContain("audioOutbox: sourceState.audioOutbox");
  });

  test("Take it sends audio-take locally, then audio-yield to every paired Mac at revision + 1 with a 90 s lease, and renews every 30 s while local", () => {
    expect(holder).toContain("static let leaseMs = 90_000");
    expect(holder).toContain("static let renewSeconds: Double = 30");
    const take = section(holder, "private func take() async {", "private func yield(");
    ordered(
      take,
      "await local(ConchAudioTakeRequest())",
      'guard reply?.kind == "audio-ack" else {',
      "for pairing in pairings {",
      "await yield(to: pairing, revision: (documents[pairing.id]?.audioControl.revision ?? 0) + 1)",
      "startRenewal()",
    );
    expect(holder).toContain('let kind = "audio-take"');
    const yielded = section(holder, "private func yield(", "private func startRenewal()");
    expect(yielded).toContain('"kind": "audio-yield", "holder": localOwner, "revision": revision, "leaseMs": Self.leaseMs,');
    expect(yielded).toContain("grants[pairing.id] = Grant(revision: reply.revision ?? revision)");
    const tick = section(holder, "private func renewTick() async {", "private func documentsChanged(");
    ordered(tick, "guard localState?.audioControl.isLocal == true else { return }", "await yield(to: pairing, revision: grant.revision)", "for (key, entry) in held {", "await present(key: key, owner: entry.owner, item: entry.item)");
    // Peer commands travel inside the peer's owner envelope over the LAN bridge.
    const wire = section(holder, "private func control(", "private func local<");
    expect(wire).toContain('"kind": "control-envelope", "ownerDeviceId": pairing.ownerDeviceId, "body": body,');
    expect(wire).toContain('path: "/control"');
  });

  test("the peer table: equal → re-yield, higher → drop and show Take it, lower → re-yield above it; a remote holder at home releases everything (F10, F11)", () => {
    const table = section(holder, "private func documentsChanged(", "private func localChanged(");
    ordered(
      table,
      "if peer.holder == localOwner {",
      'else if peer.holder == "local" {',
      "if peer.revision > grant.revision {",
      "grants[id] = nil",
      "let revision = peer.revision == grant.revision ? grant.revision : peer.revision + 1",
      "Task { await yield(to: pairing, revision: revision) }",
      "forward(document.audioOutbox, from: id)",
    );
    const home = section(holder, "private func localChanged(", "private func pairingsChanged(");
    expect(home).toContain("if let state, !state.audioControl.isLocal, !grants.isEmpty {");
    expect(home).toContain("releaseAll()");
  });

  test("forwarding is keyed by (ownerDeviceId, seq), admitted once, and `held` is retried on the tick (F4, F14)", () => {
    const forward = section(holder, "private func forward(", "private func present(");
    ordered(forward, 'let key = "\\(owner):\\(item.seq)"', "guard !forwarded.contains(key), held[key] == nil else { continue }", "held[key] = (owner, item)");
    const present = section(holder, "private func present(", "func releaseAll()");
    ordered(present, 'case ("audio-ack", _):', "forwarded.insert(key)", 'case ("audio-error", "held"):', "break", 'case ("audio-error", _):', "forwarded.insert(key)");
    expect(holder).toContain('let kind = "audio-present"');
    // Only the peer that says THIS Mac holds it is forwarded.
    expect(section(holder, "private func documentsChanged(", "private func localChanged(")).toContain("if peer.holder == localOwner, !localOwner.isEmpty {");
  });

  test("release on pairing removal, and fire-and-forget on termination (F14d)", () => {
    const removal = section(holder, "private func pairingsChanged(", "private func forward(");
    ordered(removal, "for pairing in previous where !pairings.contains(where: { $0.id == pairing.id }) {", "if grants[pairing.id] != nil { release(pairing) }");
    const release = section(holder, "private func release(_ pairing: RemoteMacPairing) {", "private func control(");
    expect(release).toContain('Task { _ = try? await control(["kind": "audio-release"], to: pairing) }');
    expect(release).not.toContain("await Task");
    ordered(app, "NSApplication.willTerminateNotification", "audio.releaseOnQuit()");
    const quit = section(holder, "func releaseOnQuit() {", "private func release(");
    expect(quit).not.toMatch(/\bawait\b/);
    expect(app).toContain("AudioHolderStore(local: store, remotes: remotes)");
    expect(app.match(/\.environmentObject\(audio\)/g)).toHaveLength(2);
  });

  test("the non-holder dims exactly the composer mic button and the auto/manual control, with the Take it line", () => {
    expect(dashboard).toContain('Text("Controlled by \\(host) —")');
    expect(dashboard).toContain('Button("Take it", action: audio.takeIt)');
    expect(dashboard).toContain('Text("You hold audio · \\(audio.silentHosts.joined(separator: ", ")) is silent")');
    // Both Macs local: the first transfer needs a Take it somewhere.
    expect(dashboard).toContain('Text("\\(audio.takeableHosts.joined(separator: ", ")) speaks for itself —")');
    expect(count(dashboard, 'Button("Take it", action: audio.takeIt)')).toBe(2);
    ordered(
      dashboard,
      "if let host = audio.controlledBy {",
      'Button("Take it", action: audio.takeIt)',
      "} else if !audio.silentHosts.isEmpty {",
      'Button("Give it back", action: audio.releaseAll)',
      "} else if !audio.takeableHosts.isEmpty {",
      'Button("Take it", action: audio.takeIt)',
    );
    expect(dashboard).toContain("audioHeldElsewhere: state?.audioControl.isLocal == false,");
    expect(dashboard).toContain("isDisabled: audioHeldElsewhere,");
    const toggle = section(dashboard, "private struct ModeToggle: View {", "\n}\n");
    ordered(toggle, ".disabled(isDisabled)", ".opacity(isDisabled ? 0.35 : 1)");
    const mic = section(composer, "Button(action: onTalk) {", "Button(action: onRecite) {");
    ordered(mic, ".disabled(audioHeldElsewhere)", ".opacity(audioHeldElsewhere ? 0.35 : 1)");
    // Nothing else in the composer is gated on it: sending, attaching and reciting keep working.
    expect(count(composer, "audioHeldElsewhere")).toBe(5);
    expect(count(dashboard, "audioHeldElsewhere")).toBe(4);
    // Drawn from the peer's document only while it is online.
    const banners = section(holder, "private func refreshBanners() {", "\n}\n");
    expect(banners).toContain("online.contains($0.id) && documents[$0.id]?.audioControl.holder == localOwner");
    expect(banners).toContain("online.contains($0.id) && documents[$0.id]?.audioControl.holder != localOwner");
    expect(banners).toContain("pairing(holder)?.endpoint.host ?? String(holder.prefix(8))");
  });
});
