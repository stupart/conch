#!/usr/bin/env bun
/**
 * Settings › Skills and Benchmarks, end to end (`src/skills-library.ts`, `src/skill-indexes.ts`, `src/skill-install.ts`,
 * `src/benchmarks.ts`): this checkout's daemon, over its socket, against made-up accounts and the real public indexes.
 *
 *   installed   Two Claude accounts and a Codex one, each with skills of their own, claude.ai's synced skills (the
 *               signed-in organization's, never a stale one), a command, Codex's built-in skills and a project's.
 *               Expected: one entry per skill, the same skill in three places collapsed into one with three locations.
 *   discover    The indexes read for real into this sandbox's cache, then searched. Expected: every index listed, none
 *               failing, a search that finds something.
 *   add         A skill from Anthropic's repository previewed, added to the second Claude account, and previewed again.
 *               Expected: the files the preview named are what landed, a stale plan is refused, and the second preview
 *               says it is already there.
 *   try         A skill from an index tried in Claude: a trial folder holding it as a project skill, and the first
 *               message that calls it. With --start, then this daemon's `session-start` with that message, as a
 *               background session of a fake `claude` that records how it was started. Expected: it was started in
 *               that folder with that message, as one argument.
 *   benchmarks  The catalog this build carries.
 *
 *   bun scripts/skills-library-e2e.ts [--keep] [--start]
 *
 * Nothing real is touched. The daemon gets a temporary HOME, CONCH_CONFIG_DIR, CLAUDE_CONFIG_DIR, CODEX_HOME and socket,
 * and with --start its tmux server lives in a temporary TMUX_TMPDIR under a socket name of its own, with $TMUX unset, as
 * scripts/restore-e2e.ts does. The fake agent is ended by its pid. That server is conch's background server, which
 * conch keeps running while empty (`exit-empty off`, background-sessions.ts): this script never stops a tmux server, so
 * it names the one it leaves.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const startSession = process.argv.includes("--start");
const TMUX = "/Applications/conch.app/Contents/Helpers/tmux";
const say = (line: string) => console.log(line);

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(300);
  }
}

// deno-lint-ignore no-explicit-any
type Reply = any;

function send(socket: string, message: Record<string, unknown>, ms = 90_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => { try { resolve(JSON.parse(reply.split("\n")[0]!)); } catch { reject(new Error(`unreadable reply: ${reply.slice(0, 200)}`)); } });
    client.on("error", reject);
    setTimeout(() => { client.destroy(); reject(new Error(`no reply to ${message.kind} ${message.action ?? ""}`)); }, ms);
  });
}

function expect(condition: unknown, what: string): void {
  if (!condition) throw new Error(what);
}

function skill(folder: string, name: string, description: string, body = "Do the thing.\n"): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`);
}

/** Records how it was started, as `claude` would be: its folder and every argument, one per line. */
const FAKE_CLAUDE = `#!/bin/bash
{ echo "cwd=$PWD"; for a in "$@"; do echo "arg=$a"; done; echo "--"; } >> "$E2E_LAUNCHES"
echo $$ >> "$E2E_PIDS"
trap 'exit 0' TERM INT HUP
while :; do sleep 1; done
`;

const root = mkdtempSync(join("/tmp", "conch-skills-"));
const home = join(root, "home");
const claudeDir = join(root, "claude");
const configDir = join(root, "config");
const codexDir = join(root, "codex");
const bin = join(root, "bin");
const none = join(root, "none");
const work = join(root, "work");
const project = join(work, "storefront");
const tmuxDir = join(root, "tmux");
for (const dir of [home, claudeDir, configDir, codexDir, bin, none, work, project, tmuxDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
chmodSync(join(bin, "claude"), 0o755);
writeFileSync(join(home, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
const launches = join(root, "launches.log");
const pids = join(root, "pids.log");
writeFileSync(launches, "");
writeFileSync(pids, "");

// ── The accounts ─────────────────────────────────────────────────────────────────────────────────────────────────
// Default Claude: its own skill, a command, and claude.ai's skills for the sign-in it holds, beside a stale sign-in's.
const shared = "Writes the hand-off note at the end of a working session.";
skill(join(claudeDir, "skills", "handoff-notes"), "handoff-notes", shared);
mkdirSync(join(claudeDir, "commands"), { recursive: true });
writeFileSync(join(claudeDir, "commands", "standup.md"), "---\ndescription: Summarise yesterday for the standup\n---\nSummarise.\n");
const bucket = "11111111-aaaa-4bbb-8ccc-000000000001_22222222-aaaa-4bbb-8ccc-000000000002";
writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({
  oauthAccount: { organizationUuid: bucket.split("_")[0], accountUuid: bucket.split("_")[1], emailAddress: "e2e@example.com" },
}));
skill(join(claudeDir, "skills", "synced", bucket, "docs"), "docs", "Editable docs people share and comment on.");
writeFileSync(join(claudeDir, "skills", "synced", bucket, "manifest.json"), JSON.stringify({ skills: [{ name: "docs", source: "anthropic-example" }] }));
skill(join(claudeDir, "skills", "synced", "99999999-aaaa-4bbb-8ccc-000000000009_88888888-aaaa-4bbb-8ccc-000000000008", "stale-skill"),
  "stale-skill", "Left by a sign-in that was swapped out; never listed.");
// A second Claude account, "Work", with the same skill.
const workId = "e2e-work";
const workDir = join(configDir, "claude", workId);
skill(join(workDir, "skills", "handoff-notes"), "handoff-notes", shared);
writeFileSync(join(configDir, "claude-accounts.json"), JSON.stringify([{ id: workId, label: "Work", configDir: workDir }]));
// Codex: the same skill again, and one of its built-in ones.
skill(join(codexDir, "skills", "handoff-notes"), "handoff-notes", shared);
skill(join(codexDir, "skills", ".system", "imagegen"), "imagegen", "Generate images with Codex's built-in tool.");
// A project a session works in.
skill(join(project, ".claude", "skills", "deploy-check"), "deploy-check", "Checks a deploy before it ships.");
writeFileSync(join(configDir, "working-folders.json"), JSON.stringify({ "e2e-session": [project] }));

const socket = join(root, "conch.sock");
const tmuxSocket = `e2e-skills-${process.pid}`;
const env: Record<string, string> = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  TMUX_TMPDIR: tmuxDir,
  CONCH_TMUX: TMUX,
  CONCH_TMUX_SOCKET: tmuxSocket,
  CONCH_STARTED_BY: "app",
  CONCH_SOCKET: socket,
  CONCH_CONFIG_DIR: configDir,
  CLAUDE_CONFIG_DIR: claudeDir,
  CODEX_HOME: codexDir,
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_APP_BUNDLE: join(root, "no-app"),
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_CLI: join(none, "whisper-cli"),
  CONCH_WHISPER_SERVER: join(none, "whisper-server"),
  CONCH_WHISPER_MODEL: join(none, "model.bin"),
  CONCH_VAD_MODEL: join(none, "vad.bin"),
  CONCH_SOX: join(none, "sox"),
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
  E2E_LAUNCHES: launches,
  E2E_PIDS: pids,
};
if ("TMUX" in env || !env.TMUX_TMPDIR!.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");

const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
  env, cwd: work, stdout: "ignore", stderr: "ignore",
});
let failed = false;
try {
  await until("the daemon's socket", () => existsSync(socket));
  const ask = (message: Record<string, unknown>) => send(socket, { kind: "skills-library", ...message });

  say("── installed ──");
  const installed = await ask({ action: "installed", refresh: true });
  expect(installed.kind === "skills-library", `installed: ${JSON.stringify(installed).slice(0, 300)}`);
  const byName = new Map<string, Reply>(installed.skills.map((entry: Reply) => [entry.name, entry]));
  const handoff = byName.get("handoff-notes");
  expect(handoff?.locations.length === 3, `handoff-notes in 3 places, got ${handoff?.locations.length}`);
  expect(handoff.versions === 1, "the three copies are one text");
  expect(byName.get("docs")?.locations[0].origin === "claude.ai", "claude.ai's docs, from the signed-in bucket");
  expect(byName.get("docs")?.locations[0].invocation === "/anthropic-skills:docs", "claude.ai's skills are called as anthropic-skills:");
  expect(!byName.has("stale-skill"), "a swapped-out sign-in's skills are not listed");
  expect(byName.get("standup")?.kind === "command", "a command is listed as one");
  expect(byName.get("imagegen")?.origin === "system", "Codex's built-in skill");
  expect(byName.get("deploy-check")?.locations[0].projectPath, "the project's skill");
  for (const account of installed.accounts) say(`  ${account.agent} · ${account.label}: ${account.skills}`);
  say(`  ✓ ${installed.total} entries: ${installed.skills.map((entry: Reply) => `${entry.name}×${entry.locations.length}`).join(", ")}`);

  say("── discover ──");
  await ask({ action: "discover", refresh: true });
  const listed = await until("the indexes read", async () => {
    const reply = await ask({ action: "discover" });
    return !reply.refreshing && reply.indexes.some((index: Reply) => index.count > 0) ? reply : undefined;
  }, 180_000);
  for (const index of listed.indexes) say(`  ${index.name} (${index.maintainer}): ${index.count}${index.error ? ` ! ${index.error}` : ""}`);
  expect(listed.indexes.filter((index: Reply) => index.id !== "skills-sh").every((index: Reply) => index.count > 0 && !index.error),
    "every listed index read");
  const searched = await ask({ action: "discover", query: "frontend design" });
  expect(searched.total > 0, "a search finds something");
  say(`  ✓ ${listed.total} listed; "frontend design" finds ${searched.total}, first ${searched.entries[0].name} (${searched.entries[0].index})`);

  say("── add ──");
  const candidate = listed.entries.find((entry: Reply) => entry.index === "anthropic-skills" && !entry.installed && !entry.needsPlugin);
  expect(candidate, "a skill from Anthropic's repository to add");
  const preview = await ask({ action: "add-preview", entryId: candidate.id, agent: "claude", accountId: workId });
  expect(preview.action === "add-preview" && !preview.preview.refusal, `preview: ${JSON.stringify(preview).slice(0, 300)}`);
  // Accounts are kept by their real path (claude-accounts.ts), and /tmp is /private/tmp.
  expect(preview.preview.destination === join(realpathSync(workDir), "skills", candidate.name), `it lands in the Work account's own skills: ${preview.preview.destination}`);
  const stale = await ask({ action: "add", entryId: candidate.id, agent: "claude", accountId: workId, planHash: "0".repeat(64) });
  expect(stale.kind === "session-error" && /changed since the preview/.test(stale.error), `a stale plan is refused: ${JSON.stringify(stale)}`);
  const added = await ask({ action: "add", entryId: candidate.id, agent: "claude", accountId: workId, planHash: preview.preview.planHash });
  expect(added.action === "add" && added.added === preview.preview.destination, `added: ${JSON.stringify(added)}`);
  for (const file of preview.preview.files) {
    expect(existsSync(join(preview.preview.destination, ...file.path.split("/"))), `${file.path} landed`);
  }
  const again = await ask({ action: "add-preview", entryId: candidate.id, agent: "claude", accountId: workId });
  expect(/already there/.test(again.preview.refusal ?? ""), "a second add is refused in words");
  const after = await ask({ action: "installed", refresh: true });
  expect(after.skills.some((entry: Reply) => entry.name === candidate.name
    && entry.locations.some((location: Reply) => location.accountId === workId)), "the inventory lists it in Work");
  say(`  ✓ ${candidate.name}: ${preview.preview.files.length} files, ${preview.preview.totalBytes} bytes, into ${preview.preview.destination}`);

  say("── try ──");
  const codex = await ask({ action: "discover", index: "openai-skills" });
  const tryable = codex.entries.find((entry: Reply) => !entry.needsPlugin);
  expect(tryable, "a curated OpenAI skill to try");
  const trial = await ask({ action: "trial", entryId: tryable.id, agent: "claude" });
  expect(trial.action === "trial" && realpathSync(trial.cwd).startsWith(join(realpathSync(home), ".cache", "conch", "skill-trials")), `trial: ${JSON.stringify(trial)}`);
  expect(existsSync(join(trial.cwd, ".claude", "skills", trial.name, "SKILL.md")), "the trial folder holds it as a project skill");
  expect(trial.prompt.startsWith(`/${trial.name} `), `the first message calls it: ${trial.prompt}`);
  if (startSession) {
    const start = { kind: "session-start", backend: "claude", host: "background", cwd: trial.cwd, prompt: trial.prompt };
    let started = await send(socket, start);
    if (started.kind === "session-needs-trust") started = await send(socket, { ...start, trustFolder: true });
    expect(started.kind === "session-started", `started: ${JSON.stringify(started)}`);
    const launch = await until("the fake claude started", () => {
      const text = readFileSync(launches, "utf8");
      return text.includes(`cwd=${trial.cwd}`) ? text : undefined;
    });
    expect(launch.includes(`arg=${trial.prompt}`), `its first message was the prompt, as one argument:\n${launch}`);
    say(`  started in it as a background session, with the first message as one argument`);
  }
  const project = installed.skills.find((entry: Reply) => entry.name === "deploy-check").locations[0];
  const inProject = await ask({ action: "trial", path: project.path, agent: "claude" });
  expect(realpathSync(inProject.cwd) === realpathSync(project.projectPath), "a project's skill is tried in its project");
  say(`  ✓ ${trial.name} tried in ${trial.cwd}, first message "${trial.prompt.slice(0, 60)}…"`);

  say("── benchmarks ──");
  const benchmarks = await send(socket, { kind: "benchmarks" });
  expect(benchmarks.kind === "benchmarks" && benchmarks.catalog.indexes.length >= 3, `benchmarks: ${JSON.stringify(benchmarks).slice(0, 200)}`);
  // A page at a time: every page asked for in turn holds every index once.
  let seen = benchmarks.catalog.indexes.length;
  for (let next = benchmarks.next; next !== undefined;) {
    const page = await send(socket, { kind: "benchmarks", offset: next });
    seen += page.catalog.indexes.length;
    next = page.next;
  }
  expect(seen === benchmarks.total, `every page read: ${seen} of ${benchmarks.total}`);
  say(`  ✓ ${benchmarks.total} indexes in ${benchmarks.next === undefined ? "one page" : "pages"}, updated ${benchmarks.catalog.updatedAt}`);
} catch (error) {
  failed = true;
  say(`  ✗ ${(error as Error).message}`);
} finally {
  daemon.kill("SIGTERM");
  await daemon.exited;
  // The fake agents, by the pids they wrote. Their tmux server, this run's own, ends with its last session.
  for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean)) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
  if (startSession) say(`conch's empty background server for this run is left running: tmux -L ${tmuxSocket} (TMUX_TMPDIR=${tmuxDir})`);
  if (!keep && !startSession) rmSync(root, { recursive: true, force: true });
  else say(`kept ${root}`);
}
process.exit(failed ? 1 : 0);
