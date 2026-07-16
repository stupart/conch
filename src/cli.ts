#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { runHook, sendToDaemon } from "./hook.ts";
import { runDaemon } from "./daemon.ts";
import { runInstall, runDoctor, runService, runSetup } from "./install.ts";
import { listenOnce } from "./listen.ts";
import { speak, probeTtsServer, voiceFor, setVoiceOverride } from "./speak.ts";
import { emitRecorderTraces } from "./diagnostics.ts";
import {
  SETTING_DESCRIPTORS,
  getSettingDescriptor,
  loadSettingResolutions,
  loadSettingsFile,
  parseSetting,
  resolveSettingFromLoaded,
  sendControlMessage,
  settingsPathFor,
  unsetSetting,
  writeSetting,
  type ConfigAck,
  type ConfigSnapshot,
  type SettingDescriptor,
  type SettingResolution,
} from "./settings.ts";

const HELP = `conch — a voice loop for Claude Code

Usage:
  conch setup           one-command install: deps, models, hooks (run this first)
  conch install         wire Stop/Notification hooks into ~/.claude/settings.json
  conch service [off]   launchd supervision: start at login, self-heal on crash
  conch hook            hook entrypoint (reads payload JSON on stdin)
  conch daemon          run the voice loop: announce -> listen -> inject
  conch wake [name]     reopen the mic — last announced session, or by name
  conch sessions        list live Claude Code sessions
  conch mute | unmute   silence announcements + mic (auto-away covers this too)
  conch pause | resume  step away: stay quiet but HOLD finished sessions, replay on resume
  conch listen          capture one utterance, print the transcript (mic test)
  conch speak <text>    say something (TTS test; uses the warm Kokoro server when up)
  conch voices          audition the voice ring — each voice introduces itself
  conch voice <s> [v]   show or pin a session's voice (persisted)
  conch set <key> <v>   save a curated setting and apply it live when possible
  conch get <key>       show one effective setting and its source
  conch unset <key>     remove a saved setting (revert to env/default)
  conch settings        show all curated settings and their sources
  conch doctor          check external dependencies

Config via env: CONCH_VOICE, CONCH_SPEAK_SENTENCES, CONCH_SPEAK_MAX_CHARS,
CONCH_BELL, CONCH_BELL_SOUND, CONCH_SPEAK, CONCH_LISTEN_WINDOW_SECS,
CONCH_AUTO_SUBMIT, CONCH_KEYSTROKE_FALLBACK, CONCH_SEASHELL_ROOT, CONCH_SOCKET
`;

const cfg = loadConfig();
const [command, ...rest] = process.argv.slice(2);
const settingsPath = settingsPathFor(process.env);

function settingValue(value: number | boolean): string {
  return String(value);
}

function hookCaveat(descriptor: SettingDescriptor): string {
  return `next hook — hook env (${descriptor.env}) may override`;
}

function freshResolution(descriptor: SettingDescriptor): SettingResolution {
  const loaded = loadSettingsFile(settingsPath);
  const resolution = resolveSettingFromLoaded(
    descriptor,
    process.env,
    loaded,
    descriptor.apply === "live",
    true,
  );
  if (descriptor.apply === "live") return resolution;
  const caveat = hookCaveat(descriptor);
  return {
    ...resolution,
    diagnostic: resolution.diagnostic ? `${resolution.diagnostic}; ${caveat}` : caveat,
  };
}

function localSnapshot(): ConfigSnapshot {
  const snapshot = loadSettingResolutions({ env: process.env, settingsPath });
  const loaded = loadSettingsFile(settingsPath);
  for (const descriptor of SETTING_DESCRIPTORS) {
    if (descriptor.apply !== "hook") continue;
    const resolution = resolveSettingFromLoaded(descriptor, process.env, loaded, false, true);
    const caveat = hookCaveat(descriptor);
    snapshot[descriptor.key] = {
      ...resolution,
      diagnostic: resolution.diagnostic ? `${resolution.diagnostic}; ${caveat}` : caveat,
    };
  }
  return snapshot;
}

function printSetting(descriptor: SettingDescriptor, resolution: SettingResolution): void {
  const source = resolution.source === "env" ? `env ${descriptor.env}` : resolution.source;
  const diagnostic = resolution.diagnostic ? ` — ${resolution.diagnostic}` : "";
  console.log(`${descriptor.key.padEnd(22)} ${settingValue(resolution.value).padEnd(8)} ${source}${diagnostic}`);
}

function printMutation(
  descriptor: SettingDescriptor,
  action: "set" | "unset",
  fresh: SettingResolution,
  result: Awaited<ReturnType<typeof sendControlMessage>>,
  savedValue?: number | boolean,
): void {
  const lead = action === "set"
    ? `[conch] ${descriptor.key} = ${settingValue(savedValue ?? fresh.value)} — saved`
    : `[conch] ${descriptor.key} unset — saved; effective ${settingValue(fresh.value)} (${fresh.source})`;
  const parts = [lead];

  if (!result.ok) {
    if (result.reason === "ack-unknown") {
      if (descriptor.apply === "hook") parts.push(`hook-next (${hookCaveat(descriptor)})`);
      parts.push("ack-unknown (saved; daemon reply could not be verified)");
    } else if (descriptor.apply === "hook") {
      parts.push(`hook-next (${hookCaveat(descriptor)})`, "daemon-down");
    } else {
      if (action === "set" && fresh.source === "env") parts.push(`masked-by-env ${descriptor.env}`);
      parts.push("daemon-down (saved, next start)");
    }
  } else if (result.response.kind !== "config-ack"
    || result.response.key !== descriptor.key
    || result.response.action !== action) {
    if (descriptor.apply === "hook") parts.push(`hook-next (${hookCaveat(descriptor)})`);
    parts.push("ack-unknown (saved; daemon reply did not match the request)");
  } else {
    const ack: ConfigAck = result.response;
    if (ack.status === "applied") {
      parts.push(`applied-live ${settingValue(ack.effective)} (${ack.source})`);
    } else if (ack.status === "masked") {
      parts.push(`masked-by-env ${ack.env ?? descriptor.env} (effective ${settingValue(ack.effective)})`);
    } else {
      parts.push(`hook-next (${ack.diagnostic ?? hookCaveat(descriptor)})`);
    }
    if (ack.diagnostic && ack.status !== "hook-next") parts.push(ack.diagnostic);
  }

  if (fresh.diagnostic && !parts.some((part) => part.includes(fresh.diagnostic!))) parts.push(fresh.diagnostic);
  if (descriptor.key === "barge-threshold") {
    parts.push("existing supervised daemons need `conch service install` once to shed the old inherited env and restart");
  }
  console.log(parts.join("; "));
}

async function readDaemonSnapshot(): Promise<ConfigSnapshot | "daemon-down" | "ack-unknown"> {
  const result = await sendControlMessage(cfg.socketPath, { kind: "get-config" });
  if (!result.ok) return result.reason;
  return result.response.kind === "config-snapshot" ? result.response.snapshot : "ack-unknown";
}

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
  case "unmute":
  case "pause":
  case "resume": {
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
  case "setup":
    await runSetup(cfg);
    break;
  case "install":
    await runInstall(cfg);
    break;
  case "service":
    await runService(cfg, rest[0] === "off" ? "off" : "install");
    break;
  case "doctor":
    await runDoctor(cfg);
    break;
  case "listen": {
    const { probeServer } = await import("./transcribe.ts");
    await probeServer(cfg, 1500); // a running daemon's warm server enables live partials
    console.error("[conch] listening... (speak, then pause)");
    const { text, error, diagnosticId, diagnosticIds } = await listenOnce(cfg, {
      onPartial: (t) => process.stderr.write(`\r\x1b[K[conch] ▸ ${t}`),
    });
    process.stderr.write("\r\x1b[K");
    if (error) {
      emitRecorderTraces(diagnosticIds ?? [diagnosticId], { intent: "cli-error", bufferCountAfterReduction: 0 });
      console.error(`[conch] ${error}`);
      process.exit(1);
    }
    emitRecorderTraces(diagnosticIds ?? [diagnosticId], { intent: "cli-output", bufferCountAfterReduction: 0 });
    console.log(text);
    break;
  }
  case "speak":
    if (!(await sendToDaemon(cfg.socketPath, { type: "speak", sessionId: "", label: "", announce: rest.join(" ") }))) {
      await probeTtsServer(cfg, 1500);
      await speak(cfg, rest.join(" "));
    }
    break;
  case "voice": {
    const [session, voice] = rest;
    if (!session) {
      console.error("usage: conch voice <session> [kokoro-voice]   (no voice = show current)");
      process.exit(1);
    }
    if (!voice) {
      console.log(`${session} -> ${voiceFor(cfg, session)}`);
      break;
    }
    setVoiceOverride(session, voice);
    console.log(`[conch] ${session} -> ${voice} (persisted to ~/.config/conch/voices.json)`);
    if (!(await sendToDaemon(cfg.socketPath, {
      type: "speak",
      sessionId: "",
      label: session,
      announce: `${session} now sounds like this.`,
    })) && (await probeTtsServer(cfg, 1500))) {
      await speak(cfg, `${session} now sounds like this.`, session);
    }
    break;
  }
  case "set": {
    const [key, raw, ...extra] = rest;
    if (key === undefined || raw === undefined || extra.length) {
      console.error("usage: conch set <key> <value>");
      process.exit(1);
    }
    const parsed = parseSetting(key, raw);
    if (!parsed.ok) {
      console.error(`[conch] ${parsed.err}`);
      process.exit(1);
    }
    try {
      writeSetting(settingsPath, parsed.value.descriptor.key, parsed.value.value);
    } catch (error) {
      console.error(`[conch] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const fresh = freshResolution(parsed.value.descriptor); // re-read the just-renamed file; never report a stale merge
    const result = await sendControlMessage(cfg.socketPath, {
      kind: "set-config",
      key: parsed.value.descriptor.key,
      value: parsed.value.value,
    });
    printMutation(parsed.value.descriptor, "set", fresh, result, parsed.value.value);
    break;
  }
  case "get": {
    const [key, ...extra] = rest;
    if (key === undefined || extra.length) {
      console.error("usage: conch get <key>");
      process.exit(1);
    }
    const found = getSettingDescriptor(key);
    if (!found.ok) {
      console.error(`[conch] ${found.err}`);
      process.exit(1);
    }
    const remote = await readDaemonSnapshot();
    if (remote === "ack-unknown") {
      console.error("[conch] ack-unknown — daemon reply could not be verified");
      process.exit(1);
    }
    if (remote === "daemon-down") console.log("[conch] daemon-down — showing local settings resolution");
    const snapshot = remote === "daemon-down" ? localSnapshot() : remote;
    printSetting(found.value, snapshot[found.value.key]);
    break;
  }
  case "unset": {
    const [key, ...extra] = rest;
    if (key === undefined || extra.length) {
      console.error("usage: conch unset <key>");
      process.exit(1);
    }
    const found = getSettingDescriptor(key);
    if (!found.ok) {
      console.error(`[conch] ${found.err}`);
      process.exit(1);
    }
    try {
      unsetSetting(settingsPath, found.value.key);
    } catch (error) {
      console.error(`[conch] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const fresh = freshResolution(found.value); // file layer is gone; resolve env -> default now
    const result = await sendControlMessage(cfg.socketPath, { kind: "unset-config", key: found.value.key });
    printMutation(found.value, "unset", fresh, result);
    break;
  }
  case "settings": {
    if (rest.length) {
      console.error("usage: conch settings");
      process.exit(1);
    }
    const remote = await readDaemonSnapshot();
    if (remote === "ack-unknown") {
      console.error("[conch] ack-unknown — daemon reply could not be verified");
      process.exit(1);
    }
    if (remote === "daemon-down") console.log("[conch] daemon-down — showing local settings resolution");
    const snapshot = remote === "daemon-down" ? localSnapshot() : remote;
    for (const descriptor of SETTING_DESCRIPTORS) printSetting(descriptor, snapshot[descriptor.key]);
    break;
  }
  case "voices": {
    let localUp: boolean | undefined;
    for (const v of cfg.ttsVoices) {
      console.log(v);
      const text = `Hi, I'm ${v.replace(/^[a-z]+_/, "")}. A session could sound like this.`;
      const handedOff = await sendToDaemon(cfg.socketPath, {
        type: "speak",
        sessionId: "",
        label: "",
        announce: text,
        voice: v,
      });
      if (!handedOff) {
        localUp ??= await probeTtsServer(cfg, 1500);
        if (!localUp) {
          console.error("[conch] TTS server not up (start the daemon, or check CONCH_TTS_PORT) — nothing to audition");
          process.exit(1);
        }
        await speak({ ...cfg, ttsVoices: [v] }, text);
      }
    }
    break;
  }
  default:
    console.log(HELP);
    process.exit(command ? 1 : 0);
}
