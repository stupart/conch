import { createHash } from "node:crypto";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.ts";

/**
 * Which conch tools a build has: a fingerprint of their names and descriptions. The daemon publishes its own on the
 * sessions file (`mcpToolset`), and an MCP server started by an older build compares its own with it to learn that a
 * newer conch is installed (mcp-handoff.ts). A leaf, so the daemon names it without loading the MCP server.
 */
export function toolsetFingerprint(tools: Iterable<{ name: string; description: string }>): string {
  const sorted = [...tools].map(({ name, description }) => [name, description]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

/** This build's tools, by name, in order: `AGENT_INSTRUCTIONS.tools`' (a test holds mcp.ts to that). */
export const MCP_TOOL_NAMES: readonly string[] = Object.keys(AGENT_INSTRUCTIONS.tools);

/** This build's: its tools are `AGENT_INSTRUCTIONS.tools`' names, each described by it (a test holds mcp.ts to that). */
export const MCP_TOOLSET = toolsetFingerprint(
  Object.entries(AGENT_INSTRUCTIONS.tools).map(([name, description]) => ({ name, description })),
);
