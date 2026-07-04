#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runHook, sendToDaemon } from "./hook.ts";
import { runDaemon } from "./daemon.ts";
import { runInstall, runDoctor } from "./install.ts";
import { listenOnce } from "./listen.ts";
import { speak } from "./speak.ts";

const HELP = `conch — a voice loop for Claude Code

Usage:
  conch install         wire Stop/Notification hooks into ~/.claude/settings.json
  conch hook            hook entrypoint (reads payload JSON on stdin)
  conch daemon          run the voice loop: announce -> listen -> inject
  conch wake [name]     reopen the mic — last announced session, or by name
  conch sessions        list live Claude Code sessions
  conch mute | unmute   silence announcements + mic (auto-away covers this too)
  conch listen          capture one utterance, print the transcript (mic test)
  conch speak <text>    say something (TTS test)
  conch doctor          check external dependencies

Config via env: CONCH_VOICE, CONCH_SPEAK_SENTENCES, CONCH_SPEAK_MAX_CHARS,
CONCH_BELL, CONCH_BELL_SOUND, CONCH_SPEAK, CONCH_LISTEN_WINDOW_SECS,
CONCH_AUTO_SUBMIT, CONCH_KEYSTROKE_FALLBACK, CONCH_SEASHELL_ROOT, CONCH_SOCKET
`;

const cfg = loadConfig();
const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "hook":
    await runHook(cfg);
    break;
  case "daemon":
    await runDaemon(cfg);
    break;
  case "wake": {
    const { findSessionByName, findTranscript, listSessions, sessionLabel } = await import("./sessions.ts");
    let event = { type: "wake" as const, sessionId: "", label: "", announce: "" };
    const query = rest.join(" ").trim();
    if (query) {
      const s = await findSessionByName(cfg.claudeDir, query);
      if (!s) {
        const names = (await listSessions(cfg.claudeDir)).map((x) => x.name ?? x.cwd?.split("/").pop() ?? x.sessionId.slice(0, 8));
        console.error(`[conch] no live session matching "${query}". Live: ${names.join(", ") || "none"}`);
        process.exit(1);
      }
      event = {
        ...event,
        sessionId: s.sessionId,
        label: sessionLabel(s, s.cwd),
        pid: s.pid,
        cwd: s.cwd,
        transcriptPath: findTranscript(cfg.claudeDir, s.sessionId),
      } as typeof event & { pid?: number; cwd?: string; transcriptPath?: string };
    }
    const ok = await sendToDaemon(cfg.socketPath, event);
    console.log(ok ? `[conch] wake sent${event.label ? ` -> ${event.label}` : ""}` : "[conch] daemon not running");
    if (!ok) process.exit(1);
    break;
  }
  case "mute":
  case "unmute": {
    const ok = await sendToDaemon(cfg.socketPath, { type: command, sessionId: "", label: "", announce: "" });
    console.log(ok ? `[conch] ${command}d` : "[conch] daemon not running");
    if (!ok) process.exit(1);
    break;
  }
  case "sessions": {
    const { listSessions } = await import("./sessions.ts");
    for (const s of await listSessions(cfg.claudeDir)) {
      console.log(`${(s.name ?? "(unnamed)").padEnd(30)} ${s.cwd ?? ""}  pid=${s.pid}`);
    }
    break;
  }
  case "install":
    await runInstall(cfg);
    break;
  case "doctor":
    await runDoctor(cfg);
    break;
  case "listen": {
    const { probeServer } = await import("./transcribe.ts");
    await probeServer(cfg, 1500); // a running daemon's warm server enables live partials
    console.error("[conch] listening... (speak, then pause)");
    const { text, error } = await listenOnce(cfg, {
      onPartial: (t) => process.stderr.write(`\r\x1b[K[conch] ▸ ${t}`),
    });
    process.stderr.write("\r\x1b[K");
    if (error) {
      console.error(`[conch] ${error}`);
      process.exit(1);
    }
    console.log(text);
    break;
  }
  case "speak":
    await speak(cfg, rest.join(" "));
    break;
  default:
    console.log(HELP);
    process.exit(command ? 1 : 0);
}
