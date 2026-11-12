import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registryProcessAlive, type ProcessIdentity } from "../src/process-identity.ts";
import { resumeRequest, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { BYPASS_OPTION } from "../src/agent-adapter.ts";

/**
 * A pid that came round again (2026-11-06): a session that had stopped working, and that Restart could not bring back.
 * After the Mac restarted on 2026-11-05, the retired Blueprint profile still had two registry entries from the boot
 * before: one naming pid 972, which macOS had handed to ImageIOXPCService, and a seashell window's naming 996, by then the `login`
 * of a Terminal tab. Asked only "is the pid alive?", conch counted both as running: it did not bring them back
 * ("not bringing back … it is running elsewhere"), it typed the first's messages at a process with no terminal, it listed
 * seashell twice, and the first's Restart read the command line of the image service, then had its close refused.
 */

const lastBoot = "Mon Oct 26 16:32:49 2026";
const at = (ms: number): ProcessIdentity => ({ pid: 972, birth: `${Math.floor(ms / 1000)}.000000`, birthTimeMs: ms, executable: "/x", ttyDevice: null });

test("a registry entry's process is alive only while its pid is still the process that started then", () => {
  const alive = () => true;
  const reused = at(Date.UTC(2026, 10, 6, 0, 8, 16));
  const own = at(Date.UTC(2026, 9, 26, 16, 32, 49) + 400);
  expect(registryProcessAlive(972, lastBoot, { alive, identity: () => reused })).toBe(false);
  expect(registryProcessAlive(972, lastBoot, { alive, identity: () => own })).toBe(true);
  expect(registryProcessAlive(972, lastBoot, { alive: () => false, identity: () => own })).toBe(false);
  // Only positive evidence counts as gone: no start time recorded, one in another form, or a kernel that won't say.
  expect(registryProcessAlive(972, undefined, { alive, identity: () => reused })).toBe(true);
  expect(registryProcessAlive(972, "2026-10-26T16:32:49Z", { alive, identity: () => reused })).toBe(true);
  expect(registryProcessAlive(972, lastBoot, { alive, identity: () => null })).toBe(true);
  expect(registryProcessAlive(0, undefined, { alive })).toBe(false);
});

test("this process, by the start time ps gives it, is its own; by another, it is not", () => {
  const lstart = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })
    .stdout.toString().trim();
  expect(registryProcessAlive(process.pid, lstart)).toBe(true);
  expect(registryProcessAlive(process.pid, lastBoot)).toBe(false);
});

test("a session whose process is gone comes back as a resume, on the defaults a start from the sheet gets", () => {
  const request = resumeRequest({ sessionId: "11111111-2222-4333-8444-555555555555", backend: "claude", cwd: "/Users/t", claudeSignInId: "sign-in" });
  expect(request).toMatchObject({ backend: "claude", resumeSessionId: "11111111-2222-4333-8444-555555555555", cwd: "/Users/t", claudeSignInId: "sign-in" });
  // No command line was read, so permissions are not switched off for it: the persisted default decides, as at Start.
  expect(request.options).not.toHaveProperty(BYPASS_OPTION);
  const { claudeSignInId: _signIn, ...onDefault } = request;
  expect(terminalSessionCommand(onDefault)).toContain("--resume '11111111-2222-4333-8444-555555555555'");
});

const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

test("recovery after a restart counts a session as running only by its own process", () => {
  const reconcile = daemon.slice(daemon.indexOf("function reconcileSessionSnapshot("), daemon.indexOf("void backgroundGuard.observe(named, running)"));
  expect(reconcile).toContain("const alive = (pid?: number, procStart?: string): boolean => Boolean(pid && registryProcessAlive(pid, procStart));");
  expect(reconcile).toContain("alive(s.pid, s.procStart) || alive(s.agentPid)");
  expect(reconcile).not.toContain("defaultIsPidAlive");
});

test("Restart on a session whose process is gone resumes it, before reading any command line or closing anything", () => {
  const close = daemon.slice(daemon.indexOf("const closeLiveSession = async ("), daemon.indexOf("await closeSession(session, { restart });"));
  const gone = close.indexOf("if (restart && !session.jobId && session.pid && !registryProcessAlive(session.pid, session.procStart)) {");
  expect(gone).toBeGreaterThan(-1);
  expect(close.indexOf("await launchSession(request);", gone)).toBeGreaterThan(gone);
  expect(close.indexOf("readProcessArgs(session.pid)")).toBeGreaterThan(gone);
});

test("a send hands the check the start time its row's registry entry gave, while the pid is still the row's", () => {
  const loop = readFileSync(join(import.meta.dir, "..", "src", "voice-loop.ts"), "utf8");
  const check = loop.slice(loop.indexOf("async function deadTargetOf("), loop.indexOf("/** The original session delivery path"));
  expect(check).toContain("...(same && row?.procStart ? { procStart: row.procStart } : {}),");
});
