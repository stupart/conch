import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { speak } from "./speak.ts";
import { listenOnce } from "./listen.ts";
import { injectText, injectKey } from "./inject.ts";
import { classify, classifyApproval } from "./commands.ts";
import { lastAssistantText, splitSentences, stripMarkdown } from "./snippet.ts";

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
    }
  }

  async function handle(event: TurnEvent): Promise<void> {
    if (event.type === "wake") {
      if (!lastTurn) {
        log("wake with nothing to wake — no session has announced yet");
        return void (await speak(cfg, "Nothing to wake. No session has spoken yet."));
      }
      log(`wake -> "${lastTurn.label}"`);
      await speak(cfg, `Mic open for ${lastTurn.label}.`);
      await conversationLoop(lastTurn);
      return;
    }

    log(`${event.type}${event.ntype ? `/${event.ntype}` : ""} from "${event.label}" (${event.sessionId.slice(0, 8)})`);
    await speak(cfg, event.announce); // mic stays closed until this finishes

    if (event.type === "needs-you" && event.ntype !== "idle_prompt") {
      await permissionLoop(event); // dialogs take Enter/Escape, not free text
      return;
    }

    // turn-end and idle_prompt are both "the session wants a prompt from you"
    lastTurn = event;
    await conversationLoop(event);
  }

  /** Commands (continue/repeat/cancel) keep the mic cycling; a real prompt injects; silence idles. */
  async function conversationLoop(event: TurnEvent): Promise<void> {
    let lastSpoken = event.announce;
    let sentences: string[] | null = null;
    let cursor = cfg.speakSentences; // the announcement already covered the first sentences

    while (true) {
      await micCue(cfg, "open"); // audible "mic is open" — cue finishes before sox starts
      log(`listening (start within ${cfg.listenWindowSecs}s)...`);
      const { text, error } = await listenOnce(cfg);
      if (error) return log(`listen error: ${error}`);
      if (!text) {
        await micCue(cfg, "close");
        return log("no speech — back to idle");
      }

      const intent = classify(text);
      log(`heard: "${text}" -> ${intent}`);

      switch (intent) {
        case "prompt": {
          const { via } = await injectText(cfg, event.pid, text);
          if (via === "none") {
            log("no tmux pane found and keystroke fallback is off — transcript dropped");
            speak(cfg, "Heard you, but I could not find the session's pane.");
          } else {
            log(`injected via ${via}`);
          }
          return;
        }
        case "discard":
          await speak(cfg, "Okay.");
          return;
        case "repeat":
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
    const { text, error } = await listenOnce(cfg);
    if (error) return log(`listen error: ${error}`);
    if (!text) {
      await micCue(cfg, "close");
      return log("no speech — back to idle");
    }
    const verdict = classifyApproval(text);
    log(`heard: "${text}" -> ${verdict ?? "unclear"}`);
    if (!verdict) return void (await speak(cfg, "For permission prompts, say yes or no. Ignoring."));
    const { via } = await injectKey(cfg, event.pid, verdict === "approve" ? "Enter" : "Escape");
    if (via === "none") speak(cfg, "Could not reach the session to answer.");
    else log(`sent ${verdict === "approve" ? "Enter" : "Escape"} via ${via}`);
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

  const shutdown = () => {
    server.close();
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
  console.log(`[conch ${t}] ${msg}`);
}

async function micCue(cfg: Config, kind: "open" | "close"): Promise<void> {
  if (!cfg.micCues) return;
  const sound = kind === "open" ? "/System/Library/Sounds/Tink.aiff" : "/System/Library/Sounds/Bottle.aiff";
  await Bun.spawn(["afplay", sound], { stdout: "ignore", stderr: "ignore" }).exited;
  if (kind === "open") await Bun.sleep(350); // let the cue's tail decay before sox arms
}
