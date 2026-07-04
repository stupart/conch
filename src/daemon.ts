import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { speak } from "./speak.ts";
import { listenOnce, listenGap, type ListenHooks } from "./listen.ts";
import { injectText, injectKey } from "./inject.ts";
import { classify, classifyApproval, classifyReadingGap } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown } from "./snippet.ts";
import { probeServer } from "./transcribe.ts";
import { setState, logAbove } from "./status.ts";
import { listSessions, sessionLabel, findTranscript, type SessionInfo } from "./sessions.ts";

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
      setState(muted ? "muted" : "idle");
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

  async function setMuted(next: boolean): Promise<void> {
    muted = next;
    log(muted ? "muted — announcements and mic off (m or `conch unmute` to resume)" : "unmuted");
    setState(muted ? "muted" : "idle");
    await speak(cfg, muted ? "Muted." : "Back on.");
  }

  async function handle(event: TurnEvent): Promise<void> {
    if (event.type === "mute") return setMuted(true);
    if (event.type === "unmute") return setMuted(false);

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
            case "prompt":
              await deliver(event, gapText);
              return;
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
          await deliver(event, text);
          return;
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

  /** Live sessions in a stable order so number keys mean the same thing between glances. */
  async function numberedSessions(): Promise<Array<{ n: number; s: SessionInfo; label: string }>> {
    const sessions = await listSessions(cfg.claudeDir);
    return sessions
      .map((s) => ({ s, label: sessionLabel(s, s.cwd) }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 9)
      .map((x, i) => ({ n: i + 1, ...x }));
  }

  async function printSessions(): Promise<void> {
    const rows = await numberedSessions();
    if (!rows.length) return log("no live sessions");
    logAbove(rows.map((r) => `  \x1b[36m${r.n}\x1b[0m ${r.label}${lastTurn?.sessionId === r.s.sessionId ? " \x1b[2m(space wakes this one)\x1b[0m" : ""}`).join("\n"));
  }

  async function wakeByNumber(n: number): Promise<void> {
    const rows = await numberedSessions();
    const row = rows.find((r) => r.n === n);
    if (!row) return log(`no session #${n} — press s to list`);
    enqueue({
      type: "wake",
      sessionId: row.s.sessionId,
      label: row.label,
      cwd: row.s.cwd,
      pid: row.s.pid,
      announce: "",
      transcriptPath: findTranscript(cfg.claudeDir, row.s.sessionId),
    });
  }

  // Interactive keys when running in a terminal.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (d) => {
      const c = d.toString();
      if (c === " ") enqueue({ type: "wake", sessionId: "", label: "", announce: "" });
      else if (c >= "1" && c <= "9") void wakeByNumber(Number(c));
      else if (c === "s" || c === "l") void printSessions();
      else if (c === "m") enqueue({ type: muted ? "unmute" : "mute", sessionId: "", label: "", announce: "" });
      else if (c === "?" || c === "h") printHelp();
      else if (c === "q" || c === "\u0003") shutdown();
    });
    printHelp();
  }
}

function printHelp(): void {
  logAbove(
    [
      "",
      "  \x1b[1mkeys\x1b[0m   \x1b[36mspace\x1b[0m mic to last session   \x1b[36ms\x1b[0m list sessions   \x1b[36m1-9\x1b[0m mic to session #   \x1b[36mm\x1b[0m mute   \x1b[36m?\x1b[0m help   \x1b[36mq\x1b[0m quit",
      '  \x1b[1mvoice\x1b[0m  \x1b[36m"continue"\x1b[0m read more   \x1b[36m"repeat"\x1b[0m again   \x1b[36m"stop"\x1b[0m end reading   \x1b[36m"no response needed"\x1b[0m close mic',
      "  \x1b[1mcli\x1b[0m    conch wake [name] · sessions · mute · doctor",
      "",
    ].join("\n"),
  );
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
