import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { speak } from "./speak.ts";
import { listenOnce, listenGap, type ListenHooks } from "./listen.ts";
import { injectText, injectKey } from "./inject.ts";
import { classify, classifyApproval, classifyReadingGap } from "./commands.ts";
import { lastAssistantText, lastSentences, splitSentences, stripMarkdown } from "./snippet.ts";
import { probeServer } from "./transcribe.ts";
import { setState, logAbove } from "./status.ts";
import { routePrompt, resolveInvoke, type RouteDecision } from "./router.ts";
import { findSessionByName, findTranscript, listSessions, normalizeLabel, sessionLabel, type SessionInfo } from "./sessions.ts";

/**
 * The turn-based voice loop.
 *
 *   IDLE -> (hook: turn ended) -> SPEAK announcement -> LISTEN (VAD window)
 *        -> INJECT transcript into that session -> IDLE
 *
 * Routing is "the mic follows the voice": whichever session most recently
 * announced owns the next utterance. The mic never opens while speaking, so
 * the loop can't hear itself. Events queue while an exchange is in flight —
 * multiple sessions finishing at once take turns, one pending event per
 * session, newest first. A "wake" event (conch wake, or spacebar when the
 * daemon runs in a terminal) reopens the mic for the last announced session.
 */
export async function runDaemon(cfg: Config): Promise<void> {
  const queue: TurnEvent[] = [];
  let busy = false;
  let lastTurn: TurnEvent | null = null;
  let muted = false;
  let routerFailureNoticed = false;

  // Intent router: resolved once. Per-mode default timeouts reflect measured
  // reality — api round-trips in well under a second, the cli pays ~4s of
  // startup before the model even sees the prompt.
  const router = resolveInvoke(cfg);
  if (router && !cfg.routerTimeoutMs) cfg.routerTimeoutMs = router.mode === "api" ? 3000 : 10_000;

  function enqueue(event: TurnEvent): void {
    const i = queue.findIndex((e) => e.sessionId === event.sessionId && e.type === event.type);
    if (i !== -1) queue.splice(i, 1); // newer event for the same session supersedes
    queue.push(event);
    void drain();
  }

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const event = queue.pop()!; // newest first
        await handle(event);
      }
    } finally {
      busy = false;
      setState("idle");
    }
  }

  /** Wire listen-phase state + live partials into the status line. */
  function listenHooks(label: string): ListenHooks {
    return {
      onState: (s) => {
        if (s === "armed") setState("listening", label);
        else if (s === "capturing") setState("recording", label);
        else setState("transcribing", label);
      },
      onPartial: (text) => setState("recording", label, text),
    };
  }

  async function handle(event: TurnEvent): Promise<void> {
    if (event.type === "mute") {
      muted = true;
      log("muted — announcements and mic off until `conch unmute`");
      return void (await speak(cfg, "Muted."));
    }
    if (event.type === "unmute") {
      muted = false;
      log("unmuted");
      return void (await speak(cfg, "Back on."));
    }

    // Nobody's there: don't announce to an empty room, don't open the mic,
    // don't burn battery on sox/whisper. Telegram (the other hook) still
    // pings the phone. `conch wake` always cuts through.
    if (event.type !== "wake") {
      const idle = await idleSeconds();
      if (muted || (cfg.awayAfterSecs && idle >= cfg.awayAfterSecs)) {
        log(`${muted ? "muted" : `away (idle ${Math.round(idle / 60)}m)`} — staying quiet for "${event.label}"`);
        if (event.type === "turn-end" || event.ntype === "idle_prompt") lastTurn = event; // wake still finds it
        return;
      }
    }

    if (event.type === "wake") {
      const target = event.sessionId ? event : lastTurn; // named wake carries its own session
      if (!target) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet."));
      }
      log(`wake -> "${target.label}"`);
      setState("speaking", target.label);
      await speak(cfg, `Mic open for ${target.label}.`);
      await conversationLoop(target);
      return;
    }

    log(`${event.type}${event.ntype ? `/${event.ntype}` : ""} from "${event.label}" (${event.sessionId.slice(0, 8)})`);
    setState("speaking", event.label);
    await speak(cfg, event.announce); // mic stays closed until this finishes

    if (event.type === "needs-you" && event.ntype !== "idle_prompt") {
      await permissionLoop(event); // dialogs take Enter/Escape, not free text
      return;
    }

    // turn-end and idle_prompt are both "the session wants a prompt from you"
    lastTurn = event;
    await conversationLoop(event);
  }

  /** Inject a prompt utterance and report how it went. */
  async function deliver(event: TurnEvent, text: string): Promise<void> {
    const { via } = await injectText(cfg, event.pid, text);
    log(`injected via ${via}`);
    if (via === "clipboard") {
      speak(cfg, "Couldn't reach the session's window — your words are on the clipboard, just paste.");
    } else if (via === "none") {
      speak(cfg, "Heard you, but I could not find the session's pane.");
    }
  }

  function eventFor(s: SessionInfo): TurnEvent {
    const label = sessionLabel(s, s.cwd);
    return {
      type: "turn-end",
      sessionId: s.sessionId,
      label,
      cwd: s.cwd,
      pid: s.pid,
      announce: label,
      transcriptPath: findTranscript(cfg.claudeDir, s.sessionId),
    };
  }

  type RouteOutcome = { status: "done" } | { status: "relisten" } | { status: "switch"; event: TurnEvent };

  /**
   * Route a would-be prompt (room-talk guard, name-addressing) and deliver.
   * Fail-open: router trouble means the utterance injects verbatim — a
   * dropped real prompt is invisible and corrodes trust; a bad injection is
   * visible and correctable.
   */
  async function routeAndDeliver(event: TurnEvent, text: string): Promise<RouteOutcome> {
    setState("routing", event.label);
    const others = (await listSessions(cfg.claudeDir))
      .map((s) => sessionLabel(s, s.cwd))
      .filter((l) => normalizeLabel(l) !== normalizeLabel(event.label));
    const replyTail =
      router && event.transcriptPath
        ? lastSentences(stripMarkdown(await lastAssistantText(event.transcriptPath)), 3, 350)
        : "";
    // Local fast paths (name-addressing, short-utterance bypass) apply even
    // with no LLM available; router?.invoke gates only the room-talk guard.
    const decision: RouteDecision = await routePrompt(
      cfg,
      { utterance: text, sessionLabel: event.label, replyTail, otherSessions: [...new Set(others)] },
      router?.invoke ?? null,
    );

    if (decision.via === "fallback" && !routerFailureNoticed) {
      routerFailureNoticed = true;
      log("router failed — failing open (send as heard); further failures logged only");
      speak(cfg, "Router is down — sending everything as heard.");
    }

    switch (decision.action) {
      case "discard":
        log(`router: discarded "${text}"`);
        await micCue(cfg, "close"); // the subtle tell that nothing was sent
        return { status: "done" };
      case "redirect": {
        const target = decision.target ?? "";
        const s = await findSessionByName(cfg.claudeDir, target);
        if (!s) {
          const live = (await listSessions(cfg.claudeDir)).map((x) => sessionLabel(x, x.cwd)).join(", ");
          log(`redirect target "${target}" not found (live: ${live})`);
          await speak(cfg, `No session called ${target}. Live: ${live || "none"}.`);
          return { status: "relisten" }; // never inject a misdirected prompt
        }
        const targetEvent = eventFor(s);
        if (!decision.cleaned) {
          // bare "hey dayloop" — voice wake: move the mic, don't inject
          log(`voice wake -> "${targetEvent.label}"`);
          await speak(cfg, `Mic open for ${targetEvent.label}.`);
          lastTurn = targetEvent;
          return { status: "switch", event: targetEvent };
        }
        await deliver(targetEvent, decision.cleaned);
        await speak(cfg, `Sent to ${targetEvent.label}.`);
        lastTurn = targetEvent; // spacebar / wake follows the conversation
        return { status: "done" };
      }
      default:
        await deliver(event, decision.cleaned ?? text);
        return { status: "done" };
    }
  }

  /** Commands (continue/repeat/cancel) keep the mic cycling; a real prompt injects; silence idles. */
  async function conversationLoop(event: TurnEvent): Promise<void> {
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = cfg.speakSentences; // the announcement already covered the first sentences

    // Read-full phase: keep speaking chunks, with a short interjection gap
    // between them — "stop" cuts to the listen window, "no response"/"cancel"
    // closes out, and a real prompt injects immediately.
    if (cfg.readFull && event.type !== "needs-you" && event.transcriptPath) {
      sentences = splitSentences(stripMarkdown(await lastAssistantText(event.transcriptPath)));
      reading: while (cursor < sentences.length) {
        setState("listening", event.label);
        const { text: gapText } = await listenGap(cfg, cfg.gapSecs);
        if (gapText) {
          const intent = classifyReadingGap(gapText);
          log(`heard mid-read: "${gapText}" -> ${intent}`);
          switch (intent) {
            case "stop":
              break reading; // skip the rest, open the normal window
            case "discard":
              await speak(cfg, "Okay.");
              return;
            case "prompt": {
              const outcome = await routeAndDeliver(event, gapText);
              if (outcome.status === "done") return;
              if (outcome.status === "switch") {
                event = outcome.event;
                sentences = null;
                cursor = cfg.speakSentences;
              }
              break reading; // relisten/switch: fall through to the normal window
            }
            case "repeat":
            case "continue":
              break; // keep reading
          }
        }
        const chunk = sentences.slice(cursor, cursor + cfg.continueSentences).join(" ");
        cursor += cfg.continueSentences;
        lastSpoken = chunk;
        setState("speaking", event.label);
        await speak(cfg, chunk);
      }
    }

    while (true) {
      await micCue(cfg, "open"); // audible "mic is open" — cue finishes before sox starts
      log(`listening (start within ${cfg.listenWindowSecs}s)...`);
      const { text, error } = await listenOnce(cfg, listenHooks(event.label));
      if (error) return log(`listen error: ${error}`);
      if (!text) {
        await micCue(cfg, "close");
        return log("no speech — back to idle");
      }

      const intent = classify(text);
      log(`heard: "${text}" -> ${intent}`);

      switch (intent) {
        case "prompt": {
          const outcome = await routeAndDeliver(event, text);
          if (outcome.status === "done") return;
          if (outcome.status === "switch") {
            event = outcome.event;
            sentences = null;
            cursor = cfg.speakSentences;
          }
          break; // relisten/switch: reopen the window
        }
        case "discard":
          await speak(cfg, "Okay.");
          return;
        case "repeat":
          setState("speaking", event.label);
          await speak(cfg, lastSpoken);
          break;
        case "continue": {
          if (!event.transcriptPath) {
            await speak(cfg, "I don't have the full message for this one.");
            break;
          }
          sentences ??= splitSentences(stripMarkdown(await lastAssistantText(event.transcriptPath)));
          const chunk = sentences.slice(cursor, cursor + cfg.continueSentences).join(" ");
          if (!chunk) {
            await speak(cfg, "That's the whole message.");
            break;
          }
          cursor += cfg.continueSentences;
          lastSpoken = chunk;
          setState("speaking", event.label);
          await speak(cfg, chunk);
          break;
        }
      }
    }
  }

  /** Permission/elicitation dialogs: "yes" -> Enter (highlighted option), "no" -> Escape. Free text is refused on purpose. */
  async function permissionLoop(event: TurnEvent): Promise<void> {
    await micCue(cfg, "open");
    log("listening for yes or no...");
    const { text, error } = await listenOnce(cfg, listenHooks(event.label));
    if (error) return log(`listen error: ${error}`);
    if (!text) {
      await micCue(cfg, "close");
      return log("no speech — back to idle");
    }
    const verdict = classifyApproval(text);
    log(`heard: "${text}" -> ${verdict ?? "unclear"}`);
    if (!verdict) return void (await speak(cfg, "For permission prompts, say yes or no. Ignoring."));
    const { via } = await injectKey(cfg, event.pid, verdict === "approve" ? "Enter" : "Escape");
    if (via === "none") speak(cfg, "Could not reach the session's window to answer — do it by hand.");
    else log(`sent ${verdict === "approve" ? "Enter" : "Escape"} via ${via}`);
  }

  // Warm whisper-server: the daemon owns it so transcription (and live
  // partials) skip the seconds-long model reload of the cold cli path.
  let whisperServer: ReturnType<typeof Bun.spawn> | null = null;
  if (cfg.whisperPort && existsSync(cfg.whisperServerBin)) {
    whisperServer = Bun.spawn(
      [
        cfg.whisperServerBin,
        "-m", cfg.whisperModel,
        "-vm", cfg.vadModel,
        "--vad",
        "--host", "127.0.0.1",
        "--port", String(cfg.whisperPort),
        "-l", "en",
        "-t", "6",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    void probeServer(cfg, 20_000).then((up) => {
      log(up ? `whisper-server warm on :${cfg.whisperPort} — fast transcription + live partials` : "whisper-server failed to come up — using the cold cli path");
    });
  } else if (cfg.whisperPort) {
    log(`whisper-server binary not found at ${cfg.whisperServerBin} — using the cold cli path`);
  }

  if (existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath); // stale socket from a previous run

  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          enqueue(JSON.parse(line) as TurnEvent);
        } catch {
          log("ignoring malformed event");
        }
      }
    });
  });

  server.listen(cfg.socketPath);
  log(`listening on ${cfg.socketPath} — wire hooks with \`conch install\``);
  log(
    router
      ? `intent router: ${router.mode} mode (${cfg.routerTimeoutMs}ms timeout) — room-talk guard on`
      : `intent router: LLM guard off (${cfg.routerMode === "off" ? "disabled" : "no API key — set ANTHROPIC_API_KEY, or CONCH_ROUTER=cli to use the slower claude CLI"}); name-addressing still works`,
  );
  setState("idle");

  const shutdown = () => {
    server.close();
    whisperServer?.kill();
    try {
      unlinkSync(cfg.socketPath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Interactive extras when running in a terminal: space reopens the mic.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const c = d.toString();
      if (c === " ") enqueue({ type: "wake", sessionId: "", label: "", announce: "" });
      else if (c === "q" || c === "\u0003") shutdown();
    });
    log("space = reopen mic for the last session · q = quit");
  }
}

function log(msg: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  logAbove(`[conch ${t}] ${msg}`);
}

/** Seconds since the user last touched keyboard or mouse (macOS HID idle time). */
async function idleSeconds(): Promise<number> {
  try {
    const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const m = out.match(/HIDIdleTime"?\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : 0;
  } catch {
    return 0;
  }
}

async function micCue(cfg: Config, kind: "open" | "close"): Promise<void> {
  if (!cfg.micCues) return;
  const sound = kind === "open" ? "/System/Library/Sounds/Tink.aiff" : "/System/Library/Sounds/Bottle.aiff";
  await Bun.spawn(["afplay", sound], { stdout: "ignore", stderr: "ignore" }).exited;
  if (kind === "open") await Bun.sleep(350); // let the cue's tail decay before sox arms
}
