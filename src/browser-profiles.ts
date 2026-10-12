import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * The Workbench's browser profiles: one per account, each its own cookies and storage (browser-workbench.ts).
 *
 * The daemon owns the list; the Mac app maps each to a WebKit data store (ConchDesign `Workbench.dataStore`). The
 * built-in `default` is `WKWebsiteDataStore.default()`, the store conch's review pane and `conch_capture` already draw
 * with, so whatever Tyler is signed in to there is signed in here too. Every other profile is
 * `WKWebsiteDataStore(forIdentifier:)` with its UUID, a store of its own that outlives the app.
 *
 * Stored in `browser-profiles.json` beside the daemon's other settings (CONCH_CONFIG_DIR, as `accountStorePath`): a
 * JSON array of `{id, name}`, never the default, written atomically and readable by its owner alone. Only names and
 * ids are ever here: a profile's cookies are WebKit's, in its own store, and never pass through conch.
 */

export interface BrowserProfile {
  id: string;
  name: string;
}

export const DEFAULT_BROWSER_PROFILE: Readonly<BrowserProfile> = Object.freeze({ id: "default", name: "Default" });
export const BROWSER_PROFILE_NAME_MAX = 60;
/** Enough for every account anyone has; a list past it is a bug, not a person. */
export const BROWSER_PROFILES_MAX = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters (C0, DEL, C1) and the line and paragraph separators: a name is one printable line. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function browserProfilesPath(): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "browser-profiles.json");
}

/** A profile's id as the app takes one: `default`, or a UUID WebKit can name a data store by. */
export function isBrowserProfileId(value: unknown): value is string {
  return value === DEFAULT_BROWSER_PROFILE.id || (typeof value === "string" && UUID.test(value));
}

/** A name, trimmed: 1 to 60 printable characters on one line. */
export function checkBrowserProfileName(value: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  const name = typeof value === "string" ? value.trim() : "";
  const length = [...name].length;
  if (!name || length > BROWSER_PROFILE_NAME_MAX || UNPRINTABLE.test(name)) {
    return { ok: false, reason: `a profile's name must be 1–${BROWSER_PROFILE_NAME_MAX} printable characters` };
  }
  return { ok: true, name };
}

/**
 * Every profile, the default first. A file that can't be read, or an entry that isn't a profile, is skipped rather than
 * thrown: a hand-edited file must never take the browser away, and the default is always there.
 */
export function readBrowserProfiles(file: string = browserProfilesPath()): BrowserProfile[] {
  const profiles: BrowserProfile[] = [{ ...DEFAULT_BROWSER_PROFILE }];
  let data: unknown;
  try {
    if (!existsSync(file)) return profiles;
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return profiles;
  }
  if (!Array.isArray(data)) return profiles;
  const ids = new Set([DEFAULT_BROWSER_PROFILE.id]);
  const names = new Set([DEFAULT_BROWSER_PROFILE.name.toLowerCase()]);
  for (const entry of data) {
    if (profiles.length > BROWSER_PROFILES_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as Record<string, unknown>;
    const checked = checkBrowserProfileName(name);
    if (typeof id !== "string" || !UUID.test(id) || !checked.ok) continue;
    const key = id.toLowerCase();
    if (ids.has(key) || names.has(checked.name.toLowerCase())) continue;
    ids.add(key);
    names.add(checked.name.toLowerCase());
    profiles.push({ id: key, name: checked.name });
  }
  return profiles;
}

function save(profiles: readonly BrowserProfile[], file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const stored = profiles.filter((profile) => profile.id !== DEFAULT_BROWSER_PROFILE.id).map(({ id, name }) => ({ id, name }));
    writeFileSync(temp, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/**
 * Add a profile by name, or find the one already called that, ignoring case: adding "Work" twice is one profile, and
 * "default" is the built-in. Returns the list as it now is and the profile the name names.
 */
export function addBrowserProfile(
  name: unknown,
  file: string = browserProfilesPath(),
  mint: () => string = () => crypto.randomUUID(),
): { profiles: BrowserProfile[]; profile: BrowserProfile; added: boolean } {
  const checked = checkBrowserProfileName(name);
  if (!checked.ok) throw new Error(checked.reason);
  const profiles = readBrowserProfiles(file);
  const existing = profiles.find((profile) => profile.name.toLowerCase() === checked.name.toLowerCase());
  if (existing) return { profiles, profile: existing, added: false };
  if (profiles.length > BROWSER_PROFILES_MAX) throw new Error(`conch keeps up to ${BROWSER_PROFILES_MAX} browser profiles`);
  const id = mint().toLowerCase();
  if (!UUID.test(id) || profiles.some((profile) => profile.id === id)) throw new Error("couldn't make the profile an id");
  const profile = { id, name: checked.name };
  const next = [...profiles, profile];
  save(next, file);
  return { profiles: next, profile, added: true };
}

/** The profile an agent or a person named: by id, or by name ignoring case. */
export function findBrowserProfile(profiles: readonly BrowserProfile[], named: string): BrowserProfile | undefined {
  const wanted = named.trim();
  return profiles.find((profile) => profile.id === wanted.toLowerCase())
    ?? profiles.find((profile) => profile.name.toLowerCase() === wanted.toLowerCase());
}
