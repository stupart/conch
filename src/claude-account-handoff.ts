import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { validAccountId, type ClaudeAccount } from "./claude-accounts.ts";
import type { StartSessionRequest } from "./session-lifecycle.ts";
import { recordKey, type RecordReceipt } from "./records-types.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COPY_CHUNK_BYTES = 1024 * 1024;

export function supportsClaudeHandoff(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 280)));
}

/** Conservative floor: this is the first installed version we verified with an isolated transcript. */
export async function requireClaudeHandoffSupport(): Promise<void> {
  const child = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 2_000);
  try {
    const [code, version] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0 || !supportsClaudeHandoff(version)) throw new Error("Update Claude Code to 2.1.280 or later to continue with another account.");
  } finally { clearTimeout(timer); }
}

export function claudeHandoffError(request: Pick<StartSessionRequest, "backend" | "claudeSourceAccountId" | "claudeAccountId" | "resumeSessionId" | "teleportSessionId" | "cwd">): string | undefined {
  if (request.claudeSourceAccountId === undefined) return;
  if (request.backend !== "claude" || !validAccountId(request.claudeSourceAccountId)
    || !validAccountId(request.claudeAccountId)) return "Choose the source and destination Claude accounts";
  if (request.claudeSourceAccountId === request.claudeAccountId) return "Choose a different destination account";
  if (!UUID.test(request.resumeSessionId ?? "") || request.teleportSessionId !== undefined) return "Account handoff requires a local Claude conversation ID";
  if (!request.cwd?.startsWith("/")) return "Account handoff requires the original working folder";
}

export interface ClaudeHandoffManifest {
  version: 1;
  id: string;
  ownerDeviceId: string;
  provider: "claude";
  source: { accountId: string; nativeId: string; transcriptPath: string; sha256: string; bytes: number };
  destination: { accountId: string; nativeId: string };
  environment: { cwd: string; gitRoot?: string; gitCommit?: string; gitBranch?: string; dirty?: boolean };
  createdAt: number;
  state: "prepared" | "terminal-opened" | "launch-failed";
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const timer = setTimeout(() => child.kill(), 2_000);
    try {
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return code === 0 ? output.trim() : undefined;
    } finally { clearTimeout(timer); }
  } catch { return undefined; }
}

/** Copy native bytes verbatim; only decode one JSONL record at a time to verify identity. */
async function copyTranscript(sourcePath: string, transcriptPath: string, sessionId: string): Promise<{
  cwd: string; bytes: number; sha256: string;
}> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size === 0n) throw new Error("The transcript is empty or is not a regular file.");
    const destination = await open(transcriptPath, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      let offset = 0;
      let cwd: string | undefined;
      let hasConversation = false;
      let fragments: Buffer[] = [];
      let fragmentBytes = 0;
      let lastByte: number | undefined;
      let lines = 0;
      while (BigInt(offset) < before.size) {
        // A fresh buffer keeps record fragments valid across reads, including split UTF-8 characters.
        const remaining = before.size - BigInt(offset);
        const buffer = Buffer.allocUnsafe(Number(remaining < BigInt(COPY_CHUNK_BYTES) ? remaining : BigInt(COPY_CHUNK_BYTES)));
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw new Error("The conversation changed while being copied. Pause it and try again.");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(chunk, written, bytesRead - written, offset + written);
          if (!result.bytesWritten) throw new Error("The transcript snapshot could not be written. Check free disk space and try again.");
          written += result.bytesWritten;
        }
        offset += bytesRead;
        lastByte = chunk.at(-1);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          const part = chunk.subarray(start, end);
          const line = (fragments.length ? Buffer.concat([...fragments, part], fragmentBytes + part.length) : part).toString("utf8");
          fragments = []; fragmentBytes = 0;
          start = end + 1;
          if (!line.trim()) continue;
          let entry: any;
          try { entry = JSON.parse(line); } catch { throw new Error("The transcript contains an incomplete or invalid record. It was not changed."); }
          if (entry && entry.sessionId === sessionId && !entry.isSidechain) {
            // Match the resume picker's original launch folder. Later cwd values reflect
            // Claude's shell directory changes, not a change of project identity.
            if (!cwd && typeof entry.cwd === "string" && entry.cwd.startsWith("/")) cwd = entry.cwd;
            if (entry.type === "user" || entry.type === "assistant") hasConversation = true;
          }
          if (++lines % 512 === 0) await Bun.sleep(0);
        }
        if (start < chunk.length) {
          fragments.push(chunk.subarray(start));
          fragmentBytes += chunk.length - start;
        }
      }
      const after = await source.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || lastByte !== 10) {
        throw new Error("The conversation is still being written. Pause it and try again.");
      }
      if (!hasConversation || !cwd) throw new Error("No resumable conversation with an original working folder was found.");
      return { cwd, bytes: offset, sha256: hash.digest("hex") };
    } finally { await destination.close(); }
  } finally { await source.close(); }
}

/** An opaque, immutable copy for the official CLI. Never rewrite native messages or copy credentials. */
export async function prepareClaudeHandoff(request: StartSessionRequest, options: {
  accounts: ClaudeAccount[]; configDir: string; ownerDeviceId: string;
}): Promise<{ request: StartSessionRequest; manifest: ClaudeHandoffManifest; directory: string }> {
  const error = claudeHandoffError(request);
  if (error || request.claudeSourceAccountId === undefined) throw new Error(error ?? "No handoff requested");
  const source = options.accounts.find(a => a.id === request.claudeSourceAccountId);
  const destination = options.accounts.find(a => a.id === request.claudeAccountId);
  if (!source || !destination) throw new Error("Account was removed. Choose the accounts again.");
  const projects = await realpath(join(source.configDir, "projects"));
  const candidates: string[] = [];
  for (const directory of await readdir(projects, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const candidate = join(projects, directory.name, `${request.resumeSessionId}.jsonl`);
    try {
      const path = await realpath(candidate);
      const inside = relative(projects, path);
      if (!inside.startsWith("..") && !isAbsolute(inside)) candidates.push(path);
    } catch { /* Not every project contains this conversation. */ }
  }
  if (candidates.length !== 1) throw new Error("The source conversation is missing or ambiguous. Refresh the session list.");
  const id = randomUUID();
  const handoffs = join(options.configDir, "handoffs");
  await mkdir(handoffs, { recursive: true, mode: 0o700 });
  const directory = join(handoffs, id);
  await mkdir(directory, { mode: 0o700 });
  const transcriptPath = join(directory, "transcript.jsonl");
  try {
    const snapshot = await copyTranscript(candidates[0]!, transcriptPath, request.resumeSessionId!);
    const actualCwd = await realpath(snapshot.cwd);
    if (actualCwd !== await realpath(request.cwd!)) throw new Error("The conversation's working folder changed. Refresh the session list.");
    const [gitRoot, gitCommit, gitBranch, gitStatus] = await Promise.all([
      git(actualCwd, ["rev-parse", "--show-toplevel"]), git(actualCwd, ["rev-parse", "HEAD"]),
      git(actualCwd, ["branch", "--show-current"]), git(actualCwd, ["status", "--porcelain", "--untracked-files=normal"]),
    ]);
    const manifest: ClaudeHandoffManifest = {
      version: 1, id, ownerDeviceId: options.ownerDeviceId, provider: "claude",
      source: { accountId: source.id, nativeId: request.resumeSessionId!, transcriptPath: candidates[0]!, sha256: snapshot.sha256, bytes: snapshot.bytes },
      destination: { accountId: destination.id, nativeId: id },
      environment: { cwd: actualCwd, ...(gitRoot ? { gitRoot } : {}), ...(gitCommit ? { gitCommit } : {}),
        ...(gitBranch ? { gitBranch } : {}), ...(gitStatus !== undefined ? { dirty: gitStatus.length > 0 } : {}) },
      createdAt: Date.now(), state: "prepared",
    };
    // The manifest and launch request are published only after the entire snapshot is validated.
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { directory, manifest, request: { ...request, cwd: actualCwd,
      claudeHandoff: { transcriptPath, sessionId: id }, options: { ...request.options, "fork-session": true } } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function settleClaudeHandoff(directory: string, manifest: ClaudeHandoffManifest, state: ClaudeHandoffManifest["state"]): Promise<void> {
  const temp = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({ ...manifest, state }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, join(directory, "manifest.json"));
  } finally { await rm(temp, { force: true }); }
}

export function claudeHandoffReceipt(manifest: ClaudeHandoffManifest, state: "accepted" | "started" | "failed"): RecordReceipt {
  return { id: recordKey("handoff", manifest.id, state), sessionId: recordKey(manifest.ownerDeviceId, "claude", manifest.destination.nativeId),
    actionId: manifest.id, kind: "handoff", state, observedAt: Date.now(), details: { handoff: {
      sourceAccountId: manifest.source.accountId, sourceNativeId: manifest.source.nativeId,
      destinationAccountId: manifest.destination.accountId, destinationNativeId: manifest.destination.nativeId,
      ownerDeviceId: manifest.ownerDeviceId, cwd: manifest.environment.cwd, transcriptSha256: manifest.source.sha256,
    } } };
}
