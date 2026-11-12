import { connect } from "node:net";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import {
  ageText,
  decodeResourceRequest,
  memoryText,
  type PublishedResource,
  type PublishedResources,
  type ResourceReply,
  type ResourceRequest,
  type ResourceState,
  type ResourceTarget,
} from "./resource-ledger.ts";

/**
 * `conch resources`: what agent sessions started that is still running, whose it is, and Tyler's word on it, from a
 * terminal (resource-ledger.ts). The same list the Mac app's Still running shows; the daemon holds it.
 *
 * ponytail: its own command until `conch agent` (PR #610) lands; then `conch agent resources …` should route here too,
 * so an agent's shell and Codex's `conch_run` reach it the way they reach the others.
 */

export const RESOURCES_USAGE = `usage:
  conch resources [--long] [--json]       what sessions started that is still running: whose, how old, CPU, memory
  conch resources stop <id>               stop it: colima/limactl stop, simctl shutdown, or SIGTERM then SIGKILL
  conch resources keep <id>               keep it; conch won't ask about it again
  conch resources later <id>              ask again in 4 hours
  conch resources add (--pid <pid> | --port <port> | --simulator <udid|name|booted> | --vm <colima profile>)
                      --until <turn|session-end|keep|30m|2h|1d> [--why "<one line>"]
                                          from a session's shell: this is mine, for this long, because`;

/** A `stop` waits for it: `colima stop` can take a minute or two. */
const STOP_REPLY_MS = 200_000;
const REPLY_MS = 10_000;

export function parseResourcesArgs(args: readonly string[], callerPid: number): { request: ResourceRequest; json: boolean; long: boolean } | { error: string } {
  const json = args.includes("--json");
  const long = args.includes("--long");
  const rest = args.filter((arg) => arg !== "--json" && arg !== "--long");
  const [verb, ...more] = rest;
  if (!verb || verb === "list") return more.length ? { error: `conch resources takes no arguments but --long and --json\n${RESOURCES_USAGE}` } : { request: { kind: "resources" }, json, long };
  if (verb === "help" || verb === "--help" || verb === "-h") return { error: RESOURCES_USAGE };
  if (verb === "stop" || verb === "keep" || verb === "later") {
    if (more.length !== 1) return { error: `conch resources ${verb} takes one id, as \`conch resources\` lists it\n${RESOURCES_USAGE}` };
    const decoded = decodeResourceRequest({ kind: "resource-decide", id: more[0], action: verb, callerPid });
    return !decoded || "error" in decoded ? { error: decoded?.error ?? RESOURCES_USAGE } : { request: decoded, json, long };
  }
  if (verb !== "add") return { error: `unknown: conch resources ${verb}\n${RESOURCES_USAGE}` };
  const flags = new Map<string, string>();
  for (let at = 0; at < more.length; at += 1) {
    const flag = more[at]!;
    const value = more[at + 1];
    if (!["--pid", "--port", "--simulator", "--sim", "--vm", "--until", "--why"].includes(flag) || value === undefined) {
      return { error: `conch resources add: ${value === undefined ? `${flag} needs a value` : `unknown ${flag}`}\n${RESOURCES_USAGE}` };
    }
    flags.set(flag === "--sim" ? "--simulator" : flag, value);
    at += 1;
  }
  const named = ["--pid", "--port", "--simulator", "--vm"].filter((flag) => flags.has(flag));
  if (named.length !== 1) return { error: `conch resources add: name one thing (--pid, --port, --simulator or --vm)\n${RESOURCES_USAGE}` };
  const value = flags.get(named[0]!)!;
  const target: ResourceTarget = named[0] === "--pid" ? { pid: Number(value) }
    : named[0] === "--port" ? { port: Number(value) }
      : named[0] === "--simulator" ? { simulator: value } : { vm: value };
  const decoded = decodeResourceRequest({
    kind: "resource-add", target, until: flags.get("--until"), ...(flags.has("--why") ? { why: flags.get("--why") } : {}), callerPid,
  });
  return !decoded || "error" in decoded ? { error: `${decoded?.error ?? "invalid"}\n${RESOURCES_USAGE}` } : { request: decoded, json, long };
}

/** One request on the control socket, held open for the daemon's answer. */
export function requestResources(socketPath: string, request: ResourceRequest, timeoutMs: number): Promise<ResourceReply> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify(request));
    } catch (error) {
      resolve({ kind: "resource-error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (reply: ResourceReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const gone = () => (connected ? "the daemon did not answer" : "conch's daemon is not running");
    const timer = setTimeout(() => finish({ kind: "resource-error", error: `${gone()} (timed out)` }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply = JSON.parse(line) as { kind?: unknown; error?: unknown };
        if (reply.kind === "resources" || reply.kind === "resource-done" || reply.kind === "resource-error") finish(reply as ResourceReply);
        // A daemon from before the ledger answers with an error of its own kind.
        else finish({ kind: "resource-error", error: typeof reply.error === "string" ? `${reply.error} (is conch's daemon older than \`conch resources\`?)` : `the daemon answered ${String(reply.kind)}` });
      } catch (error) {
        finish({ kind: "resource-error", error: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", () => finish({ kind: "resource-error", error: gone() }));
    socket.on("close", () => finish({ kind: "resource-error", error: gone() }));
  });
}

const GROUPS: Array<{ states: ResourceState[]; heading: (count: number) => string }> = [
  { states: ["asking", "stopping"], heading: (n) => `Asking (${n}): their time is over. Stop, keep, or ask later` },
  { states: ["running"], heading: (n) => `Running (${n})` },
  { states: ["later"], heading: (n) => `Asking later (${n})` },
  { states: ["kept"], heading: (n) => `Kept (${n})` },
  { states: ["unowned"], heading: (n) => `Unowned (${n}): nothing ties these to a session` },
];

function ownerText(item: PublishedResource, now: number): string {
  if (!item.owner) return item.preexisting ? "unowned, here before conch looked" : "unowned";
  const ended = item.owner.live ? "" : item.owner.endedAt ? `, ended ${ageText(now - item.owner.endedAt)} ago` : ", ended";
  return `${item.owner.label}${ended}`;
}

/** The list, grouped as the Mac app groups it, one line a resource; `long` adds its command, folder and why. */
export function renderResources(resources: PublishedResources, now: number, long = false): string[] {
  if (!resources.items.length) return ["Nothing a session started is running."];
  const lines: string[] = [];
  const width = Math.min(16, Math.max(...resources.items.map((item) => item.id.length)));
  for (const group of GROUPS) {
    const items = resources.items.filter((item) => group.states.includes(item.state));
    if (!items.length) continue;
    if (lines.length) lines.push("");
    lines.push(group.heading(items.length));
    for (const item of items) {
      const numbers = `up ${ageText(now - item.startedAt)} · ${Math.round(item.cpu)}% CPU · ${memoryText(item.memory)}`;
      const why = item.state === "asking" || item.state === "later" || item.state === "stopping" ? ` · ${item.reason ?? item.state}` : "";
      lines.push(`  ${item.id.padEnd(width)}  ${item.title}  ·  ${ownerText(item, now)}  ·  ${numbers}${why}`);
      if (long) {
        lines.push(`  ${"".padEnd(width)}    ${item.command}`);
        if (item.cwd) lines.push(`  ${"".padEnd(width)}    in ${item.cwd}`);
        if (item.why) lines.push(`  ${"".padEnd(width)}    why: ${item.why}`);
        if (item.users?.length) lines.push(`  ${"".padEnd(width)}    used by ${item.users.join(", ")}`);
      }
    }
  }
  if (resources.items.some((item) => item.state !== "unowned")) {
    lines.push("", "conch resources stop|keep|later <id>; nothing is ever stopped unless you ask.");
  }
  return lines;
}

/** `conch resources …`: 0 done, 1 conch failed or refused, 2 the command was wrong. */
export async function runResourcesCli(args: readonly string[], socketPath: string, callerPid: number = process.pid): Promise<number> {
  const parsed = parseResourcesArgs(args, callerPid);
  if ("error" in parsed) {
    console.error(parsed.error);
    return args[0] === "help" || args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  }
  const { request, json, long } = parsed;
  const reply = await requestResources(socketPath, request, request.kind === "resource-decide" && request.action === "stop" ? STOP_REPLY_MS : REPLY_MS);
  if (json) {
    console.log(JSON.stringify(reply.kind === "resources" ? reply.resources : reply, null, 2));
    return reply.kind === "resource-error" ? 1 : 0;
  }
  if (reply.kind === "resource-error") {
    console.error(`[conch] ${reply.error}`);
    return 1;
  }
  if (reply.kind === "resources") {
    for (const line of renderResources(reply.resources, Date.now(), long)) console.log(line);
    return 0;
  }
  console.log(reply.message);
  return 0;
}
