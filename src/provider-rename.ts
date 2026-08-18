import type { Config } from "./config.ts";
import {
  injectText,
  type InjectTextResult,
} from "./inject.ts";

export interface ProviderRenameTarget {
  backend?: "claude" | "codex";
  pid?: number;
}

export type ProviderRenameResult =
  | { kind: "unsupported" }
  | { kind: "unroutable"; reason: string }
  | { kind: "delivered"; via: "tmux" | "osascript-focused" };

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
  if (!target.pid) return { kind: "unroutable", reason: "session has no routable pid" };

  // This is Claude Code's local `immediate` command. It must submit even when
  // ordinary composer auto-submit is disabled, and a failed metadata sync must
  // never replace the person's clipboard with a slash command.
  const result = await inject(
    { ...cfg, autoSubmit: true },
    target.pid,
    `/rename ${label}`,
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
