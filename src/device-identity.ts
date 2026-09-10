import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { settingsPathFor } from "./settings.ts";

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function read(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Device identity belongs to the daemon installation, independently of settings and pairings. */
export async function loadDeviceId(
  configDir = dirname(settingsPathFor()),
  log: (message: string) => void = console.warn,
): Promise<string> {
  const path = join(configDir, "device-id");
  const existing = await read(path);
  if (existing !== null && DEVICE_ID.test(existing)) {
    await chmod(path, 0o600);
    // A crash after the rename may leave a completed repair candidate behind.
    await unlink(join(configDir, ".device-id-repair")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return existing;
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = join(configDir, `.device-id.${id}.tmp`);
  await writeFile(temporary, `${id}\n`, { flag: "wx", mode: 0o600 });
  try {
    // link() exclusively creates the final name with already-complete contents.
    // Opening the final file with wx then writing leaves an empty-file window in
    // which a concurrent startup could mistake the winner for a corrupt file.
    try {
      await link(temporary, path);
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const winner = await read(path);
    if (winner !== null && DEVICE_ID.test(winner)) {
      await chmod(path, 0o600);
      return winner;
    }
    // Elect one replacement too: two readers of the same corrupt file must not
    // each rename a different UUID over it. The repair name contains a complete
    // candidate, so another startup can finish a repair if its creator crashes.
    const repair = join(configDir, ".device-id-repair");
    try {
      await link(temporary, repair);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const replacement = await read(repair);
    // Another repair already completed and removed its candidate.
    if (replacement === null) return await loadDeviceId(configDir, log);
    if (!DEVICE_ID.test(replacement)) throw new Error(`invalid pending device identity at ${repair}`);
    const current = await read(path);
    if (current === null || !DEVICE_ID.test(current)) {
      // Use our own temporary name, so competing finishers can all publish the
      // elected value without renaming a file out from underneath one another.
      if (replacement !== id) await writeFile(temporary, `${replacement}\n`);
      await rename(temporary, path);
      log(`replaced invalid device identity at ${path}`);
    }
    await unlink(repair).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return current !== null && DEVICE_ID.test(current) ? current : replacement;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
