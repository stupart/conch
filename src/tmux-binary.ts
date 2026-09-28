import { join } from "node:path";
import { conchHome } from "./home.ts";
import { BREW_PREFIXES, conchAppCandidates, isExecutableFile } from "./speech-engine.ts";

/**
 * Which tmux conch runs its own sessions with. conch.app carries one
 * (scripts/embed-tmux.sh builds tmux 3.7c reproducibly, only the system
 * linked dynamically, into Contents/Helpers/tmux), so a Mac without Homebrew
 * can host conch's sessions: "download one thing and it works."
 *
 * The same order as the speech engine (speech-engine.ts): an explicit
 * CONCH_TMUX, then the app's own copy (CONCH_APP_BUNDLE, which the app hands its
 * daemon, or the app this executable sits in), then Homebrew's, then PATH.
 *
 * This is the tmux for a server conch owns (its own socket). A tmux server the
 * user started — the panes conch types into today, named by $TMUX or the
 * default socket — is still spoken to with the user's own tmux, the `tmux` on
 * PATH: a client of the same build as its server, never the app's.
 */

/** Where the tmux came from: CONCH_TMUX, the app, Homebrew, PATH, or nowhere. */
export type TmuxSource = "explicit" | "conch.app" | "homebrew" | "PATH" | "missing";

export interface TmuxBinary {
  path: string;
  source: TmuxSource;
  found: boolean;
}

export interface ResolveTmuxOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  execPath?: string;
  executable?: (path: string) => boolean;
  which?: (name: string) => string | null;
  /** Homebrew prefixes, Apple silicon's first. */
  brewPrefixes?: readonly string[];
}

/**
 * The tmux to run, resolved. An explicit CONCH_TMUX is taken as-is even when it
 * is not there — a setting to fix, not one to route around. Found nowhere, it
 * is bare `tmux`: what conch always spawned, found on PATH at spawn time or not
 * at all.
 */
export function resolveTmux(options: ResolveTmuxOptions = {}): TmuxBinary {
  const env = options.env ?? process.env;
  const executable = options.executable ?? isExecutableFile;
  const explicit = env.CONCH_TMUX?.trim();
  if (explicit) return { path: explicit, source: "explicit", found: executable(explicit) };

  const apps = conchAppCandidates(env, options.home ?? conchHome(), options.execPath ?? process.execPath);
  const candidates: Array<readonly [string, TmuxSource]> = [
    ...apps.map((app) => [join(app, "Contents", "Helpers", "tmux"), "conch.app"] as const),
    ...(options.brewPrefixes ?? BREW_PREFIXES).map((prefix) => [join(prefix, "bin", "tmux"), "homebrew"] as const),
  ];
  for (const [path, source] of candidates) {
    if (executable(path)) return { path, source, found: true };
  }
  const onPath = (options.which ?? Bun.which)("tmux");
  if (onPath && executable(onPath)) return { path: onPath, source: "PATH", found: true };
  return { path: "tmux", source: "missing", found: false };
}

/** One line for `conch doctor` and the logs: which tmux, and from where. */
export function describeTmux(tmux: TmuxBinary): string {
  if (tmux.source === "explicit" && !tmux.found) {
    return `tmux: CONCH_TMUX=${tmux.path} is not an executable — fix the setting or unset it`;
  }
  if (!tmux.found) {
    return "tmux: not found — the conch app carries one; sessions are typed into through their own window instead";
  }
  const from = tmux.source === "conch.app" ? "the app" : tmux.source === "explicit" ? "CONCH_TMUX" : tmux.source === "homebrew" ? "Homebrew" : "PATH";
  return `tmux from ${from} (${tmux.path}) — conch's own sessions run in it`;
}
