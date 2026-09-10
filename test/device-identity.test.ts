import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeviceId } from "../src/device-identity.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync("/tmp/conch-device-");
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent device identity", () => {
  test("first load mints and persists a UUID in a new config directory", async () => {
    const configDir = join(directory(), "config");
    const id = await loadDeviceId(configDir);
    expect(id).toMatch(UUID);
    expect(readFileSync(join(configDir, "device-id"), "utf8")).toBe(`${id}\n`);
    expect(readdirSync(configDir)).toEqual(["device-id"]);
  });

  test("second load returns the same persisted id", async () => {
    const configDir = directory();
    const first = await loadDeviceId(configDir);
    expect(await loadDeviceId(configDir)).toBe(first);
    expect(readFileSync(join(configDir, "device-id"), "utf8").trim()).toBe(first);
  });

  test("two concurrent first loads converge on the exclusively created winner", async () => {
    const configDir = directory();
    const logs: string[] = [];
    const [first, second] = await Promise.all([
      loadDeviceId(configDir, (message) => logs.push(message)),
      loadDeviceId(configDir, (message) => logs.push(message)),
    ]);
    expect(first).toMatch(UUID);
    expect(second).toBe(first);
    expect(readFileSync(join(configDir, "device-id"), "utf8").trim()).toBe(first);
    expect(logs).toEqual([]);
    expect(readdirSync(configDir)).toEqual(["device-id"]);
  });

  test.each(["", " \n\t", "garbage", "00000000-0000-0000-0000-000000000000"])(
    "an invalid file (%j) is replaced and logged",
    async (contents) => {
      const configDir = directory();
      const path = join(configDir, "device-id");
      writeFileSync(path, contents);
      const logs: string[] = [];
      const id = await loadDeviceId(configDir, (message) => logs.push(message));
      expect(id).toMatch(UUID);
      expect(readFileSync(path, "utf8").trim()).toBe(id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("replaced invalid device identity");
      expect(logs[0]).toContain(path);
      expect(await loadDeviceId(configDir)).toBe(id);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(configDir)).toEqual(["device-id"]);
    },
  );

  test("identity files are 0600, including an existing permissive file", async () => {
    const configDir = directory();
    const id = await loadDeviceId(configDir);
    const path = join(configDir, "device-id");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    expect(await loadDeviceId(configDir)).toBe(id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("concurrent corrupt-file repairs converge on one fresh replacement", async () => {
    const configDir = directory();
    const path = join(configDir, "device-id");
    writeFileSync(path, "garbage");
    const logs: string[] = [];
    const [first, second] = await Promise.all([
      loadDeviceId(configDir, (message) => logs.push(message)),
      loadDeviceId(configDir, (message) => logs.push(message)),
    ]);
    expect(first).toMatch(UUID);
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8").trim()).toBe(first);
    expect(logs.length).toBeGreaterThan(0);
    expect(readdirSync(configDir)).toEqual(["device-id"]);
  });

  test("a startup finishes an interrupted repair using its elected identity", async () => {
    const configDir = directory();
    const elected = "01847a88-74df-4c31-a51d-9a50a701b181";
    writeFileSync(join(configDir, "device-id"), "garbage");
    writeFileSync(join(configDir, ".device-id-repair"), `${elected}\n`, { mode: 0o600 });
    const logs: string[] = [];
    expect(await loadDeviceId(configDir, (message) => logs.push(message))).toBe(elected);
    expect(readFileSync(join(configDir, "device-id"), "utf8").trim()).toBe(elected);
    expect(logs).toHaveLength(1);
    expect(readdirSync(configDir)).toEqual(["device-id"]);
  });

  test.each([true, false])("config resolution honours CONCH_CONFIG_DIR (override: %j)", async (override) => {
    // A child gives settingsPathFor a fresh HOME, including under mutations that
    // ignore the override. No test may create identity in the real config dir.
    const home = directory();
    const selected = join(home, "custom-config");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.CONCH_CONFIG_DIR;
    if (override) env.CONCH_CONFIG_DIR = selected;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { loadDeviceId } from ${JSON.stringify(new URL("../src/device-identity.ts", import.meta.url).pathname)};
      console.log(await loadDeviceId());
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const expectedDir = override ? selected : join(home, ".config", "conch");
    expect(out.trim()).toMatch(UUID);
    expect(existsSync(join(expectedDir, "device-id"))).toBe(true);
    expect(readFileSync(join(expectedDir, "device-id"), "utf8").trim()).toBe(out.trim());
    if (override) expect(existsSync(join(home, ".config", "conch", "device-id"))).toBe(false);
  });
});
