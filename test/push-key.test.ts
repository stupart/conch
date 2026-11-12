import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApnsKey } from "../src/apns.ts";
import {
  addKeyLine,
  loadPushKey,
  PUSH_KEY_KEYCHAIN_SERVICE,
  pushKeyPath,
  readKeychainSecret,
  readPushKeyRecord,
  removePushKey,
  setPushKey,
} from "../src/push-key.ts";

// The APNs key (push-key.ts) is kept as a sign-in's token is: into the login Keychain by `security -i`, the command on
// its stdin, and only its ids on disk. Every Keychain here is a stand-in: no test touches the real one.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-push-key-"));
  roots.push(root);
  return join(root, "push-key.json");
}

function p8() {
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const parsed = parseApnsKey(pem);
  if ("error" in parsed) throw new Error(parsed.error);
  return { pem, body: parsed.body };
}

/** A Keychain that keeps what it's told, and says what it was told. */
function fakeKeychain() {
  const items = new Map<string, string>();
  const lines: string[] = [];
  return {
    items,
    lines,
    run: async (command: string) => {
      lines.push(command);
      const add = /^add-generic-password -U -s (\S+) -a (\S+) -l "[^"]*" -w (\S+)\n$/.exec(command);
      if (add) {
        items.set(`${add[1]}/${add[2]}`, add[3]!);
        return { code: 0, stderr: "" };
      }
      const remove = /^delete-generic-password -s (\S+) -a (\S+)\n$/.exec(command);
      if (remove) return items.delete(`${remove[1]}/${remove[2]}`) ? { code: 0, stderr: "" } : { code: 44, stderr: "not found" };
      return { code: 1, stderr: "unknown" };
    },
    read: async (service: string, account: string) => {
      const value = items.get(`${service}/${account}`);
      return value === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${value}\n` };
    },
  };
}

describe("setting up the key", () => {
  test("into the Keychain on one stdin line, its ids alone on disk (0600), and read back as a key to sign with", async () => {
    const file = scratch();
    const keychain = fakeKeychain();
    const { pem, body } = p8();
    const record = await setPushKey({ keyId: " abcde12345 ", teamId: "fghij67890", key: pem }, { file, keychain: keychain.run, now: () => 7 });
    expect(record).toEqual({ keyId: "ABCDE12345", teamId: "FGHIJ67890", addedAt: 7 });
    expect(keychain.lines).toEqual([`add-generic-password -U -s ${PUSH_KEY_KEYCHAIN_SERVICE} -a ABCDE12345 -l "conch APNs key ABCDE12345" -w ${body}\n`]);
    const onDisk = readFileSync(file, "utf8");
    expect(JSON.parse(onDisk)).toEqual({ keyId: "ABCDE12345", teamId: "FGHIJ67890", addedAt: 7 });
    expect(onDisk).not.toContain(body.slice(20, 60));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readPushKeyRecord(file)).toEqual(record);

    const loaded = await loadPushKey({ file, read: keychain.read });
    if (!loaded || "error" in loaded) throw new Error("expected a key");
    expect(loaded.keyId).toBe("ABCDE12345");
    expect(loaded.teamId).toBe("FGHIJ67890");
    expect(loaded.key.asymmetricKeyType).toBe("ec");
  });

  test("a replacement with another Key ID takes the old item out; the same id is replaced in place", async () => {
    const file = scratch();
    const keychain = fakeKeychain();
    await setPushKey({ keyId: "AAAAA11111", teamId: "FGHIJ67890", key: p8().pem }, { file, keychain: keychain.run });
    await setPushKey({ keyId: "AAAAA11111", teamId: "FGHIJ67890", key: p8().pem }, { file, keychain: keychain.run });
    expect([...keychain.items.keys()]).toEqual([`${PUSH_KEY_KEYCHAIN_SERVICE}/AAAAA11111`]);
    await setPushKey({ keyId: "BBBBB22222", teamId: "FGHIJ67890", key: p8().pem }, { file, keychain: keychain.run });
    expect([...keychain.items.keys()]).toEqual([`${PUSH_KEY_KEYCHAIN_SERVICE}/BBBBB22222`]);
    expect(readPushKeyRecord(file)?.keyId).toBe("BBBBB22222");
  });

  test("ids that aren't Apple's or a key that isn't one are refused before the Keychain is asked, never repeating the key", async () => {
    const file = scratch();
    const keychain = fakeKeychain();
    const { pem } = p8();
    await expect(setPushKey({ keyId: "short", teamId: "FGHIJ67890", key: pem }, { file, keychain: keychain.run })).rejects.toThrow("Key ID");
    await expect(setPushKey({ keyId: "ABCDE12345", teamId: "FGHIJ-6789", key: pem }, { file, keychain: keychain.run })).rejects.toThrow("Team ID");
    // The kind of key Apple doesn't make.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const refused = await setPushKey({ keyId: "ABCDE12345", teamId: "FGHIJ67890", key: rsa }, { file, keychain: keychain.run }).catch((error: Error) => error.message);
    expect(refused).toContain("isn't an APNs auth key");
    expect(refused).not.toContain(rsa.slice(40, 80));
    // A key with a second word in it can't reach the line.
    expect(() => addKeyLine("ABCDE12345", "abc -U -s other")).toThrow();
    expect(keychain.lines).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test("a Keychain that won't take it saves nothing", async () => {
    const file = scratch();
    const error = await setPushKey({ keyId: "ABCDE12345", teamId: "FGHIJ67890", key: p8().pem },
      { file, keychain: async () => ({ code: 51, stderr: "User interaction is not allowed." }) }).catch((thrown: Error) => thrown.message);
    expect(error).toContain("security exited 51");
    expect(existsSync(file)).toBe(false);
  });

  test("removing takes the item and the ids; nothing set up loads as nothing, a missing item as why", async () => {
    const file = scratch();
    const keychain = fakeKeychain();
    expect(await loadPushKey({ file, read: keychain.read })).toBeUndefined();
    await setPushKey({ keyId: "ABCDE12345", teamId: "FGHIJ67890", key: p8().pem }, { file, keychain: keychain.run });
    keychain.items.clear();
    expect(await loadPushKey({ file, read: keychain.read })).toEqual({ error: expect.stringContaining("isn't in this Mac's Keychain") });
    await setPushKey({ keyId: "ABCDE12345", teamId: "FGHIJ67890", key: p8().pem }, { file, keychain: keychain.run });
    expect(await removePushKey({ file, keychain: keychain.run })).toMatchObject({ keyId: "ABCDE12345" });
    expect(keychain.items.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(await removePushKey({ file, keychain: keychain.run })).toBeUndefined();
  });

  test("the real Keychain is never reached from a test, and the ids live beside conch's other settings", async () => {
    await expect(readKeychainSecret(PUSH_KEY_KEYCHAIN_SERVICE, "ABCDE12345")).rejects.toThrow("won't touch the Keychain");
    expect(pushKeyPath()).toBe(join(process.env.CONCH_CONFIG_DIR!, "push-key.json"));
  });
});
