import type { Config } from "./config.ts";
import {
  injectText,
  type InjectTextResult,
} from "./inject.ts";

export interface ProviderRenameTarget {
  backend?: "claude" | "codex";
  pid?: number;
}

export type ProviderCommandResult =
  | { kind: "unroutable"; reason: string }
  | { kind: "delivered"; via: "tmux" | "osascript-focused" };

export type ProviderRenameResult = ProviderCommandResult | { kind: "unsupported" };

export type ProviderRenameInjector = (
  cfg: Config,
  sessionPid: number | undefined,
  text: string,
  beforeInject: undefined,
  options: {
    allowBlindFallback: false;
    copyToClipboard(text: string): Promise<void>;
  },
) => Promise<InjectTextResult>;

/** Claude Code owns a second copy of its label; Codex has no equivalent command. */
export async function renameProviderSession(
  cfg: Config,
  target: Readonly<ProviderRenameTarget>,
  label: string,
  inject: ProviderRenameInjector = injectText,
): Promise<ProviderRenameResult> {
  if (target.backend === "codex") return { kind: "unsupported" };
  return injectProviderCommand(cfg, target, `/rename ${label}`, inject);
}

/**
 * A line the agent would read as one of its own slash commands — `/compact`,
 * `/model opus`, `/ponytail:ponytail args` — as opposed to a message that
 * merely starts with a slash, such as a path (`/Users/me/x.txt`). The Mac
 * composer, the phone and the command palette (B4) all arrive as `inject`;
 * this decides which door the daemon takes.
 */
export function isProviderCommandLine(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(text.trim());
}

/**
 * Type one of the agent's own slash commands into the session's prompt, the
 * way a typed message reaches it (`injectText`), so the agent handles it
 * natively. A local command must submit even when ordinary composer
 * auto-submit is disabled, and a failed delivery must never replace the
 * person's clipboard with a slash command.
 */
export async function injectProviderCommand(
  cfg: Config,
  target: Readonly<ProviderRenameTarget>,
  line: string,
  inject: ProviderRenameInjector = injectText,
): Promise<ProviderCommandResult> {
  if (!target.pid) return { kind: "unroutable", reason: "session has no routable pid" };
  const result = await inject(
    { ...cfg, autoSubmit: true },
    target.pid,
    line,
    undefined,
    { allowBlindFallback: false, copyToClipboard: async () => {} },
  );
  if (result.via === "tmux" || result.via === "osascript-focused") {
    return { kind: "delivered", via: result.via };
  }
  return {
    kind: "unroutable",
    reason: result.reason ?? (result.interrupted ? "delivery interrupted" : "session is not routable"),
  };
}
