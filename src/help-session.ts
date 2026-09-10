import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import template from "../docs/help-session/CLAUDE.md" with { type: "text" };

/**
 * The help session: Claude Code in a folder conch owns, with a CLAUDE.md conch
 * writes. Its power is the plugin and the CLI any session already has; what it
 * brings is knowing where things are on this Mac and the rules for touching them.
 *
 * A leaf module on purpose: `settings.ts` imports both `sessions.ts` and
 * `session-lifecycle.ts`, and both of those need this.
 */
export const HELP_SESSION_LABEL = "conch help";

type Env = Readonly<Record<string, string | undefined>>;

function configDir(env: Env): string {
  return env.CONCH_CONFIG_DIR ?? join(homedir(), ".config", "conch");
}

/** Under the config dir, so `CONCH_CONFIG_DIR` moves it with everything else. */
export function helpSessionDir(env: Env = process.env): string {
  return join(configDir(env), "help");
}

/** The template with this Mac's paths filled in; what the file must contain. */
export function renderHelpSessionClaudeMd(env: Env = process.env): string {
  return template.replaceAll("{{CONFIG_DIR}}", configDir(env));
}

/**
 * Create the folder and write its CLAUDE.md. Rewritten only when it differs,
 * so a newer conch's knowledge lands on the next start and an unchanged one
 * does not churn the file.
 */
export function ensureHelpSession(env: Env = process.env): string {
  const dir = helpSessionDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "CLAUDE.md");
  const wanted = renderHelpSessionClaudeMd(env);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current !== wanted) writeFileSync(path, wanted);
  return dir;
}
