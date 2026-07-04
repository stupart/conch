import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "./config.ts";
import type { TurnEvent } from "./hook.ts";
import { speak } from "./speak.ts";
import { listenOnce } from "./listen.ts";
import { injectText } from "./inject.ts";

/**
 * The turn-based voice loop.
 *
 *   IDLE -> (hook: turn ended) -> SPEAK announcement -> LISTEN (VAD window)
 *        -> INJECT transcript into that session -> IDLE
 *
 * Routing is "the mic follows the voice": whichever session most recently
 * announced owns the next utterance. The mic never opens while speaking, so
 * the loop can't hear itself. If several sessions finish while one is being
 * handled, only the most recent event per session is kept, and the newest
 * session announces next.
 */
export async function runDaemon(cfg: Config): Promise<void> {
  // newest-last queue, one pending event per session
  const queue: TurnEvent[] = [];
  let busy = false;

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
    log(`${event.type} from "${event.label}" (${event.sessionId.slice(0, 8)})`);
    await speak(cfg, event.announce); // mic stays closed until this finishes

    if (event.type === "needs-you") return; // permission prompts need eyes, not dictation

    log(`listening (up to ${cfg.listenWindowSecs}s)...`);
    const { text, error } = await listenOnce(cfg);
    if (error) return log(`listen error: ${error}`);
    if (!text) return log("no speech — back to idle");

    log(`heard: "${text}"`);
    const { via } = await injectText(cfg, event.pid, text);
    if (via === "none") {
      log("no tmux pane found and keystroke fallback is off — transcript dropped");
      speak(cfg, "Heard you, but I could not find the session's pane.");
    } else {
      log(`injected via ${via}`);
    }
  }

  if (existsSync(cfg.socketPath)) unlinkSync(cfg.socketPath); // stale socket from a previous run

  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as TurnEvent;
          const i = queue.findIndex((e) => e.sessionId === event.sessionId);
          if (i !== -1) queue.splice(i, 1); // newer event supersedes
          queue.push(event);
        } catch {
          log("ignoring malformed event");
        }
      }
      void drain();
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
}

function log(msg: string): void {
  console.log(`[conch] ${msg}`);
}
