#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { runHook, sendToDaemon } from "./hook.ts";
import { runCodexHook } from "./codex-hook.ts";
import { runDaemon } from "./daemon.ts";
import {
  runCodexInstall,
  runInstall,
  runDoctor,
  runService,
  runSetup,
  parseSetupArgs,
} from "./install.ts";
import { listenOnce } from "./listen.ts";
import { speak, probeTtsServer, voiceFor, setVoiceOverride } from "./speak.ts";
import { emitRecorderTraces } from "./diagnostics.ts";
import { CONCH_VERSION } from "./version.ts";
import {
  SETTING_DESCRIPTORS,
  configSnapshotEntry,
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
  type SettingValue,
} from "./settings.ts";

const HELP = `conch — a voice loop for Claude Code and Codex

Getting started:
  conch setup                    run this once — installs everything
  conch setup [--no-service] [--no-plugin]  opt out of automatic integrations
  conch | conch dashboard        open the live dashboard (ctrl-b d detaches)

Everyday:
  conch wake [name] | recite [name]       talk again | reread the latest reply
  conch sessions | resumable [query] | rename <session> <name>  list live/past | save a name
  conch pause | resume                     manual (hold) | auto (read and listen)

Voice and settings:
  conch voice <session> [voice] | voices   show/pin or audition voices
  conch set <key> <value>                   save and apply a setting
  conch get <key> | unset <key> | settings inspect, revert, or list settings
  conch listen | speak <text>               microphone and speech tests

Optional / manual setup:
  conch service [install|off] | uninstall [--models]  manage or remove the install
  conch install-plugin | uninstall-plugin  manage the Claude Code / Codex plugin
  conch install [--codex] | pair   wire hooks · connect the iPhone app
  conch doctor | version           run live checks | print the package version

Internal entrypoints: conch hook | codex-hook | daemon | mcp
`;

/**
 * Open the dashboard: attach to the daemon's detached tmux session, and if the
 * daemon restarts, wait and reattach so the window survives restarts.
 * Detaching on purpose (ctrl-b d) leaves the session alive, so we exit cleanly.
 *
 * This is the LAUNCHD way of running conch — `conch install` starts the daemon
 * inside a tmux session named `conch`. The Mac app hosts its own daemon instead
 * and never creates that session, so with the app there is nothing here to
 * attach to and the app IS the dashboard. Say so rather than waiting forever:
 * a `dashboard.command` login item spent every boot printing "daemon
 * restarting… reattaching" at a session that was never coming.
 */
async function runDashboard(): Promise<void> {
  const tmux = Bun.which("tmux") ?? "/opt/homebrew/bin/tmux";
  const hasSession = () =>
    Bun.spawnSync([tmux, "has-session", "-t", "conch"]).exitCode === 0;
  console.log("🐚 conch dashboard  ·  ctrl-b d to detach (leaves the daemon running)");
  let warned = false;
  while (true) {
    while (!hasSession()) {
      if (!warned) {
        if (existsSync(cfg.socketPath)) {
          console.log(
            "A daemon is already running without a tmux session — that is the Mac"
            + " app hosting it, and the app is the dashboard. Nothing to attach to.",
          );
          return;
        }
        console.log("daemon not up yet — waiting for the conch session (`conch install` starts it)…");
        warned = true;
      }
      await Bun.sleep(1000);
    }
    warned = false;
    Bun.spawnSync([tmux, "attach", "-t", "conch"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (hasSession()) break; // session still alive => you detached on purpose
    console.log("daemon restarting… reattaching");
  }
}

const cfg = loadConfig();
const [command, ...rest] = process.argv.slice(2);
const settingsPath = settingsPathFor(process.env);

function settingValue(value: SettingValue): string {
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
  const resolutions = loadSettingResolutions({ env: process.env, settingsPath });
  const snapshot = Object.create(null) as ConfigSnapshot;
  const loaded = loadSettingsFile(settingsPath);
  for (const descriptor of SETTING_DESCRIPTORS) {
    let resolution = resolutions[descriptor.key];
    if (descriptor.apply === "hook") {
      resolution = resolveSettingFromLoaded(descriptor, process.env, loaded, false, true);
      const caveat = hookCaveat(descriptor);
      resolution = {
        ...resolution,
        diagnostic: resolution.diagnostic ? `${resolution.diagnostic}; ${caveat}` : caveat,
      };
    }
    snapshot[descriptor.key] = configSnapshotEntry(descriptor, resolution);
  }
  return snapshot;
}

function printSetting(descriptor: SettingDescriptor, resolution: SettingResolution): void {
  const source = resolution.source === "env" ? `env ${descriptor.env}` : resolution.source;
  const diagnostic = resolution.diagnostic ? ` — ${resolution.diagnostic}` : "";
  console.log(`${descriptor.key.padEnd(22)} ${settingValue(resolution.value).padEnd(8)} ${source}${diagnostic}`);
}

function dim(text: string): string {
  return process.env.NO_COLOR !== undefined || !process.stdout.isTTY
    ? text
    : `\x1b[2m${text}\x1b[22m`;
}

function holdSubmitTimingAdvisory(snapshot: ConfigSnapshot): string | undefined {
  const hold = snapshot["hold-submit-delay"].value;
  const end = snapshot["end-silence"].value;
  if (typeof hold !== "number" || typeof end !== "number" || hold > end) return undefined;
  return dim(
    `  advisory: hold-submit-delay (${hold}s) <= end-silence (${end}s); `
      + "the submit timer can fire before the utterance is considered ended",
  );
}

function printMutation(
  descriptor: SettingDescriptor,
  action: "set" | "unset",
  fresh: SettingResolution,
  result: Awaited<ReturnType<typeof sendControlMessage>>,
  savedValue?: SettingValue,
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
  case "version":
  case "--version":
    console.log(`conch ${CONCH_VERSION}`);
    break;
  case "mcp": {
    const { runMcpServer } = await import("./mcp.ts");
    await runMcpServer({ config: cfg });
    break;
  }
  case "install-plugin": {
    const { runInstallPlugin } = await import("./plugin-install.ts");
    const absBun = process.execPath;
    const absCli = fileURLToPath(import.meta.url);
    try {
      const ok = await runInstallPlugin(absBun, absCli);
      if (!ok) process.exitCode = 1;
    } catch (error) {
      console.error(
        `[conch] install-plugin failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    break;
  }
  case "uninstall-plugin": {
    const { runUninstallPlugin } = await import("./plugin-install.ts");
    try {
      const ok = await runUninstallPlugin();
      if (!ok) process.exitCode = 1;
    } catch (error) {
      console.error(
        `[conch] uninstall-plugin failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
    break;
  }
  case "uninstall": {
    const { parseUninstallArgs, runUninstall } = await import("./uninstall.ts");
    let selection;
    try {
      selection = parseUninstallArgs(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      break;
    }
    const result = await runUninstall(cfg, selection);
    if (!result.ok) process.exitCode = 1;
    break;
  }
  case "hook":
    await runHook(cfg);
    break;
  case "codex-hook":
    await runCodexHook(cfg);
    break;
  case "daemon":
    await runDaemon(cfg);
    break;
  case "wake": {
    const { findSessionByName, findTranscript, listSessions, sessionLabel } = await import("./sessions.ts");
    // Typed at a terminal by a person, so it opens the mic even in manual mode.
    let event = {
      type: "wake" as const,
      sessionId: "",
      label: "",
      announce: "",
      origin: "user" as const,
    };
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
  case "recite": {
    const {
      findSessionByName,
      findTranscript,
      listSessions,
      sessionLabel,
    } = await import("./sessions.ts");
    const { transcriptMark } = await import("./snippet.ts");
    let event = { type: "recite" as const, sessionId: "", label: "", announce: "" };
    const query = rest.join(" ").trim();
    if (query) {
      const s = await findSessionByName(cfg.claudeDir, query);
      if (!s) {
        const names = (await listSessions(cfg.claudeDir)).map((session) =>
          sessionLabel(session, session.cwd)
        );
        console.error(`[conch] no live session matching "${query}". Live: ${names.join(", ") || "none"}`);
        process.exit(1);
      }
      const transcriptPath = findTranscript(cfg.claudeDir, s.sessionId);
      if (!transcriptPath) {
        console.error(`[conch] nothing to recite for "${sessionLabel(s, s.cwd)}" — transcript not found`);
        process.exit(1);
      }
      event = {
        ...event,
        sessionId: s.sessionId,
        label: sessionLabel(s, s.cwd),
        pid: s.pid,
        cwd: s.cwd,
        transcriptPath,
        mark: await transcriptMark(transcriptPath),
      } as typeof event & {
        pid?: number;
        cwd?: string;
        transcriptPath?: string;
        mark?: number;
      };
    }
    const ok = await sendToDaemon(cfg.socketPath, event);
    console.log(ok
      ? `[conch] recite sent${event.label ? ` -> ${event.label}` : ""}`
      : "[conch] daemon not running");
    if (!ok) process.exit(1);
    break;
  }
  case "rename": {
    const [query, ...labelParts] = rest;
    const label = labelParts.join(" ").trim();
    if (!query || !label) {
      console.error("usage: conch rename <session> <label>");
      process.exit(1);
    }
    const {
      findSessionByName,
      renameSessionLabel,
      sessionLabel,
    } = await import("./sessions.ts");
    const session = await findSessionByName(cfg.claudeDir, query);
    if (!session) {
      console.error(`[conch] no live session matching "${query}"`);
      process.exit(1);
    }
    const oldLabel = sessionLabel(session, session.cwd);
    const result = await sendControlMessage(cfg.socketPath, {
      kind: "session-command",
      sessionId: session.sessionId,
      command: "rename",
      label,
    });
    let renamedLabel: string;
    let voiceMigrated = false;
    if (!result.ok) {
      if (result.reason !== "daemon-down") {
        const diagnostic = result.diagnostic ? `: ${result.diagnostic}` : "";
        console.error(`[conch] ${result.reason}${diagnostic}`);
        process.exit(1);
      }
      const renamed = renameSessionLabel(session.sessionId, oldLabel, label);
      renamedLabel = renamed.label;
      voiceMigrated = renamed.voiceMigrated;
    } else if (result.response.kind === "session-error") {
      console.error(`[conch] ${result.response.error}`);
      process.exit(1);
    } else if (
      result.response.kind !== "session-ack"
      || result.response.sessionId !== session.sessionId
      || result.response.command !== "rename"
      || result.response.label === undefined
    ) {
      console.error("[conch] ack-unknown: daemon reply did not match the rename request");
      process.exit(1);
    } else {
      renamedLabel = result.response.label;
    }
    console.log(`[conch] ${oldLabel} -> ${renamedLabel} (persisted to ~/.config/conch/labels.json)${
      voiceMigrated ? "; voice pin migrated" : ""
    }`);
    break;
  }
  case "pause":
  case "resume": {
    const ok = await sendToDaemon(cfg.socketPath, { type: command, sessionId: "", label: "", announce: "" });
    const said = command === "pause" ? "manual mode" : "auto mode";
    console.log(ok ? `[conch] ${said}` : "[conch] daemon not running");
    if (!ok) process.exit(1);
    break;
  }
  case "sessions": {
    const { listSessions, sessionLabel } = await import("./sessions.ts");
    for (const s of await listSessions(cfg.claudeDir)) {
      console.log(`${sessionLabel(s, s.cwd).padEnd(30)} ${s.cwd ?? ""}  pid=${s.pid}`);
    }
    break;
  }
  case "resumable": {
    const { readResumableSessions } = await import("./resumable.ts");
    const query = rest.join(" ").trim();
    const sessions = readResumableSessions({
      ...(query ? { query } : {}),
      ...(process.env.CONCH_CONFIG_DIR === undefined
        ? {}
        : { configDir: process.env.CONCH_CONFIG_DIR }),
      ...(process.env.CLAUDE_CONFIG_DIR === undefined
        ? {}
        : { claudeHome: cfg.claudeDir }),
    });
    for (const session of sessions) {
      console.log(
        `${session.backend.padEnd(6)}  ${new Date(session.updatedAt).toISOString()}`
        + `  ${session.label.padEnd(40)}  ${session.cwd}  ${session.sessionId}`,
      );
    }
    break;
  }
  case "setup": {
    let selection;
    try {
      selection = parseSetupArgs(rest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      break;
    }
    await runSetup(cfg, {
      ...selection,
      absBun: process.execPath,
      absCli: fileURLToPath(import.meta.url),
    });
    break;
  }
  case "install":
    if (rest.includes("--codex")) {
      await runCodexInstall();
    } else {
      await runInstall(cfg);
    }
    break;
  case "service":
    await runService(cfg, rest[0] === "off" ? "off" : "install");
    break;
  case "shot": {
    // Ask the Mac app to photograph ITSELF, and wait for the file.
    //
    // Exists because verifying UI work by running `screencapture` over the
    // display caught an unrelated window full of Tyler's private work. The
    // app's own window is the only thing conch has any business capturing.
    const target = rest[0] ?? `/tmp/conch-shot-${Date.now()}.png`;
    if (!target.startsWith("/tmp/") || !target.endsWith(".png")) {
      console.error("usage: conch shot [/tmp/<name>.png]");
      process.exitCode = 1;
      break;
    }
    const { unlinkSync: removeFile, existsSync: fileExists } = await import("node:fs");
    try { removeFile(target); } catch {}
    await Bun.write("/tmp/conch-shot.request", target);
    // The app services the request on its state poll, which runs every 250ms.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (fileExists(target)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!fileExists(target)) {
      try { removeFile("/tmp/conch-shot.request"); } catch {}
      // The app reports which step failed rather than leaving the caller to
      // guess after a five-second wait.
      const reason = fileExists(target + ".error")
        ? await Bun.file(target + ".error").text()
        : "is the conch Mac app running?";
      console.error(`no snapshot — ${reason.trim()}`);
      process.exitCode = 1;
      break;
    }
    console.log(target);
    break;
  }
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
  case "pair": {
    // One command: turn the bridge on, open a two-minute window, print a code
    // a person can actually type on a phone. The 32-char token is never typed.
    const { PHONE_BRIDGE_DEFAULT_PORT } = await import("./phone-bridge.ts");
    const { networkInterfaces } = await import("node:os");
    const parsed = parseSetting("phone", "true");
    if (!parsed.ok) {
      console.error(`[conch] ${parsed.err}`);
      process.exit(1);
    }
    writeSetting(settingsPath, parsed.value.descriptor.key, parsed.value.value);
    await sendControlMessage(cfg.socketPath, {
      kind: "set-config",
      key: parsed.value.descriptor.key,
      value: parsed.value.value,
    });
    const opened = await sendControlMessage(
      cfg.socketPath,
      { kind: "open-pairing" } as never,
    );
    const window = opened.ok
      ? (opened.response as unknown as {
        code?: string;
        port?: number;
        relay?: import("./phone-relay.ts").RelayPairing;
      })
      : null;
    if (!window?.code) {
      console.error("[conch] couldn't open a pairing window — is the daemon running?");
      console.error("        start it with `conch service install`, then try again.");
      process.exit(1);
    }
    const port = window.port ?? cfg.phonePort ?? PHONE_BRIDGE_DEFAULT_PORT;
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
      .map((iface) => iface!.address);
    console.log("");
    console.log("  Open conch on your iPhone and enter:");
    console.log("");
    for (const address of lan) console.log(`    Host   ${address}:${port}`);
    if (!lan.length) console.log("    Host   (no Wi-Fi address found — is Wi-Fi on?)");
    console.log(`    Code   ${window.code}`);
    console.log("");
    console.log("  The code works once, for two minutes. Run `conch pair` again");
    console.log("  for a fresh one.");
    if (window.relay) {
      const { relayPairingCode } = await import("./phone-relay.ts");
      const qrcode = await import("qrcode-terminal");
      const relayCode = relayPairingCode(window.relay);
      console.log("");
      console.log("  From anywhere (cellular or any Wi-Fi), scan this in conch:");
      console.log("");
      qrcode.generate(relayCode, { small: true }, (qr) => console.log(qr));
      console.log(`    Relay code   ${relayCode}`);
      console.log("");
      console.log("  The relay pairing is long-lived and selects relay only; the app");
      console.log("  will not silently fall back to the LAN transport.");
    } else {
      console.log("");
      console.log("  Internet relay is not configured. After deploying relay/, run:");
      console.log("    conch set phone-relay-url https://<worker>.workers.dev");
      console.log("    conch pair");
    }
    console.log("");
    console.log("  Turn every phone transport off: conch set phone false");
    console.log("");
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
    for (const descriptor of SETTING_DESCRIPTORS) {
      printSetting(descriptor, snapshot[descriptor.key]);
      if (descriptor.key === "hold-submit-delay") {
        const advisory = holdSubmitTimingAdvisory(snapshot);
        if (advisory) console.log(advisory);
      }
    }
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
          console.error("[conch] TTS backend not up (start the daemon; server mode also checks CONCH_TTS_PORT) — nothing to audition");
          process.exit(1);
        }
        await speak({ ...cfg, ttsVoices: [v] }, text);
      }
    }
    break;
  }
  case "dashboard":
  case "dash":
    await runDashboard();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    if (command === undefined) {
      await runDashboard();
      break;
    }
    console.log(HELP);
    process.exit(1);
}
