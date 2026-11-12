import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APPLE_ID, parseApnsKey, type ApnsCredentials } from "./apns.ts";
import { redactTokens, runKeychainCommand, type KeychainRunner } from "./claude-session-sign-ins.ts";
import { conchHome } from "./home.ts";

/**
 * The APNs auth key conch pushes to the phone with (apns.ts), kept the way a session sign-in's token is
 * (claude-session-sign-ins.ts):
 *  - chosen or pasted in the Mac app's Settings › Phone app, sent once over the daemon's local socket (`push-setup`;
 *    the phone bridge refuses the kind, phone-bridge.ts `MAC_APP_ONLY_DECODERS`), and written to the login Keychain by
 *    `/usr/bin/security -i`, the command on its STDIN: never in any process's argv, never in conch's own files;
 *  - read back by the daemon when it first pushes (`security find-generic-password -w`, whose argv names only the
 *    item), held in memory as a key object, and never logged, published or put in a reply.
 * What conch keeps on disk is the Key ID, the Team ID and when it was added (`push-key.json`): neither is a secret.
 */

export const PUSH_KEY_KEYCHAIN_SERVICE = "conch.apns-key";

export interface PushKeyRecord {
  keyId: string;
  teamId: string;
  /** Epoch ms. */
  addedAt: number;
}

function conchConfigDir(home = conchHome()): string {
  return process.env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch");
}

export function pushKeyPath(): string {
  return join(conchConfigDir(), "push-key.json");
}

/** The ids of the key conch has, or undefined: none set up, or a file that isn't conch's. */
export function readPushKeyRecord(file = pushKeyPath()): PushKeyRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PushKeyRecord>;
    if (typeof value.keyId === "string" && APPLE_ID.test(value.keyId) && typeof value.teamId === "string" && APPLE_ID.test(value.teamId)
      && Number.isSafeInteger(value.addedAt)) {
      return { keyId: value.keyId, teamId: value.teamId, addedAt: value.addedAt as number };
    }
  } catch {}
  return undefined;
}

function saveRecord(record: PushKeyRecord, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ keyId: record.keyId, teamId: record.teamId, addedAt: record.addedAt }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Reads one Keychain item's secret: its exit code and stdout. Injected in tests, which never touch a real Keychain. */
export type KeychainReader = (service: string, account: string) => Promise<{ code: number; stdout: string }>;

/**
 * The real one. Its argv is the service and the Key ID; the key comes back on stdout, into this process alone. Refuses
 * in conch's own tests (`CONCH_TEST_ROOT`), as `runKeychainCommand` does.
 */
export const readKeychainSecret: KeychainReader = async (service, account) => {
  if (process.env.CONCH_TEST_ROOT) throw new Error("conch is running its tests, so it won't touch the Keychain");
  const child = Bun.spawn(["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout: stdout.trim() };
  } finally {
    clearTimeout(timer);
  }
};

export interface PushKeyStoreOptions {
  file?: string;
  keychain?: KeychainRunner;
  read?: KeychainReader;
  now?: () => number;
}

const keychainLine = (words: string): string => {
  if (/[\u0000-\u001f\u007f]/.test(words)) throw new Error("A Keychain command must be one line");
  return `${words}\n`;
};

/** The Keychain line that saves a key. Only for checked parts; exported for its test. */
export function addKeyLine(keyId: string, body: string): string {
  if (!APPLE_ID.test(keyId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("Invalid APNs key");
  return keychainLine(`add-generic-password -U -s ${PUSH_KEY_KEYCHAIN_SERVICE} -a ${keyId} -l "conch APNs key ${keyId}" -w ${body}`);
}

function deleteKeyLine(keyId: string): string {
  if (!APPLE_ID.test(keyId)) throw new Error("Invalid Key ID");
  return keychainLine(`delete-generic-password -s ${PUSH_KEY_KEYCHAIN_SERVICE} -a ${keyId}`);
}

/** Why a Key ID or Team ID won't do, or undefined. Apple shows both as ten capitals and digits. */
export function appleIdError(value: unknown, what: "Key ID" | "Team ID"): string | undefined {
  if (typeof value !== "string" || !APPLE_ID.test(value.trim().toUpperCase())) {
    return `The ${what} is the ten letters and digits Apple shows for it${what === "Key ID" ? " beside the key (it's in the file's name too: AuthKey_<Key ID>.p8)" : " in Membership details"}.`;
  }
}

// One change at a time, as sign-ins are.
let changing: Promise<unknown> = Promise.resolve();
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = changing.then(work, work);
  changing = next.catch(() => {});
  return next;
}

/**
 * Save a key: into the Keychain first, then its ids. A key that replaces another of a different id takes the old item
 * out after, so the Keychain holds one.
 */
export function setPushKey(input: { keyId: string; teamId: string; key: string }, options: PushKeyStoreOptions = {}): Promise<PushKeyRecord> {
  const keyId = typeof input.keyId === "string" ? input.keyId.trim().toUpperCase() : "";
  const teamId = typeof input.teamId === "string" ? input.teamId.trim().toUpperCase() : "";
  const idError = appleIdError(keyId, "Key ID") ?? appleIdError(teamId, "Team ID");
  if (idError) return Promise.reject(new Error(idError));
  const parsed = parseApnsKey(input.key);
  if ("error" in parsed) return Promise.reject(new Error(parsed.error));
  return serially(async () => {
    const file = options.file ?? pushKeyPath();
    const keychain = options.keychain ?? runKeychainCommand;
    const previous = readPushKeyRecord(file);
    const saved = await keychain(addKeyLine(keyId, parsed.body));
    if (saved.code !== 0) {
      const said = redactTokens(saved.stderr).replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "…");
      throw new Error(`The Keychain didn't take the key (security exited ${saved.code}${said ? `: ${said}` : ""}). Nothing was saved.`);
    }
    const record: PushKeyRecord = { keyId, teamId, addedAt: (options.now ?? Date.now)() };
    try {
      saveRecord(record, file);
    } catch (error) {
      if (previous?.keyId !== keyId) await keychain(deleteKeyLine(keyId)).catch(() => undefined);
      throw new Error(`conch couldn't save the key's ids, so it wasn't added: ${(error as Error).message}`);
    }
    if (previous && previous.keyId !== keyId) await keychain(deleteKeyLine(previous.keyId)).catch(() => undefined);
    return record;
  });
}

/** Take the key out: its Keychain item, then its ids. Nothing is pushed after. */
export function removePushKey(options: PushKeyStoreOptions = {}): Promise<PushKeyRecord | undefined> {
  return serially(async () => {
    const file = options.file ?? pushKeyPath();
    const record = readPushKeyRecord(file);
    if (!record) {
      if (existsSync(file)) unlinkSync(file);
      return undefined;
    }
    const deleted = await (options.keychain ?? runKeychainCommand)(deleteKeyLine(record.keyId));
    // 44: no such item, which is what removing it was for.
    if (deleted.code !== 0 && deleted.code !== 44) {
      throw new Error(`The Keychain didn't let conch remove the key (security exited ${deleted.code})`);
    }
    unlinkSync(file);
    return record;
  });
}

/**
 * The key to sign with, from the Keychain: undefined when none is set up, an error when one is set up but can't be read
 * (the item gone, the Keychain locked). Never says anything of the key itself.
 */
export async function loadPushKey(options: PushKeyStoreOptions = {}): Promise<ApnsCredentials | { error: string } | undefined> {
  const record = readPushKeyRecord(options.file ?? pushKeyPath());
  if (!record) return undefined;
  let read: { code: number; stdout: string };
  try {
    read = await (options.read ?? readKeychainSecret)(PUSH_KEY_KEYCHAIN_SERVICE, record.keyId);
  } catch (error) {
    return { error: `conch couldn't read the APNs key from the Keychain: ${(error as Error).message}` };
  }
  if (read.code === 44) return { error: "The APNs key isn't in this Mac's Keychain any more. Set it up again in Settings › Phone app." };
  if (read.code !== 0) return { error: `conch couldn't read the APNs key from the Keychain (security exited ${read.code}).` };
  const parsed = parseApnsKey(read.stdout);
  if ("error" in parsed) return { error: "The APNs key in the Keychain isn't one conch can sign with. Set it up again in Settings › Phone app." };
  return { keyId: record.keyId, teamId: record.teamId, key: parsed.key };
}
