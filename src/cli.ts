#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runHook } from "./hook.ts";
import { runDaemon } from "./daemon.ts";
import { runInstall, runDoctor } from "./install.ts";
import { listenOnce } from "./listen.ts";
import { speak } from "./speak.ts";

const HELP = `conch — a voice loop for Claude Code

Usage:
  conch install         wire Stop/Notification hooks into ~/.claude/settings.json
  conch hook            hook entrypoint (reads payload JSON on stdin)
  conch daemon          run the voice loop: announce -> listen -> inject
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
  case "install":
    await runInstall(cfg);
    break;
  case "doctor":
    await runDoctor(cfg);
    break;
  case "listen": {
    console.error("[conch] listening... (speak, then pause)");
    const { text, error } = await listenOnce(cfg);
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
