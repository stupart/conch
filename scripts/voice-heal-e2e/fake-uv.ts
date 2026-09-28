/**
 * A stand-in for uv, for scripts/voice-heal-e2e.ts only. The test's fake conch.app carries a `Contents/Helpers/uv` that
 * runs this, and the daemon under test builds with it exactly as it builds with the real one: `python install`, `venv`,
 * `pip sync`, in conch's own folders (the UV_* directories voice-env.ts hands every step).
 *
 * Its downloads come from the test's local server (CONCH_E2E_INDEX), so the test can take the network away; they land
 * in the uv cache it is given, so a second build fetches only what the first didn't get. Its Python is fake-python.sh,
 * its packages the lock's exact versions as dist-info records, plus the two stubs the real tts-worker.py runs on. The
 * test's switchboard (CONCH_TEST_HOOKS) can make it fill the disk (`uv-fault: enospc`) or hang mid-install (`hang`),
 * part way through the packages, the way a full disk or a killed build would.
 */
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseVoiceLock } from "../../src/voice-env.ts";

const here = import.meta.dir;
const args = process.argv.slice(2);
const env = process.env;
const hooks = env.CONCH_TEST_HOOKS ?? "";
const index = env.CONCH_E2E_INDEX ?? "";

if (hooks) appendFileSync(join(hooks, "uv-calls.log"), `${args.join(" ")}\n`);

function hook(name: string): string {
  try { return readFileSync(join(hooks, name), "utf8").trim(); } catch { return ""; }
}

/** One download, or uv's own words for a network that isn't there. */
async function download(path: string): Promise<void> {
  const url = `${index}/${path}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer();
  } catch {
    console.error([
      `error: Failed to download \`${url}\``,
      "  Caused by: Request failed after 3 retries",
      `  Caused by: error sending request for url (${url})`,
      "  Caused by: client error (Connect)",
      "  Caused by: tcp connect error: Connection refused (os error 61)",
    ].join("\n"));
    process.exit(2);
  }
}

function installedPython(version: string): string {
  return join(env.UV_PYTHON_INSTALL_DIR!, `cpython-${version}.14-macos-aarch64-none`, "bin", `python${version}`);
}

if (args[0] === "--version") {
  console.log("uv 0.12.19 (conch e2e stand-in)");
} else if (args[0] === "python" && args[1] === "install") {
  const version = args[2]!;
  await download(`python/cpython-${version}.tar`);
  const python = installedPython(version);
  mkdirSync(dirname(python), { recursive: true });
  writeFileSync(python, readFileSync(join(here, "fake-python.sh"), "utf8")
    .replaceAll("@SYSTEM_PYTHON@", env.CONCH_E2E_SYSTEM_PYTHON ?? "/usr/bin/python3")
    .replaceAll("@HERE@", here)
    .replaceAll("@VERSION@", `${version}.14`)
    .replaceAll("@MINOR@", version));
  chmodSync(python, 0o755);
} else if (args[0] === "venv") {
  const target = args[1]!;
  const version = args[args.indexOf("--python") + 1]!;
  const python = installedPython(version);
  if (!existsSync(python)) {
    console.error(`error: No interpreter found for Python ${version} in managed installations`);
    process.exit(2);
  }
  mkdirSync(join(target, "bin"), { recursive: true });
  mkdirSync(join(target, "lib", `python${version}`, "site-packages"), { recursive: true });
  symlinkSync(python, join(target, "bin", "python"));
  writeFileSync(join(target, "pyvenv.cfg"), `home = ${dirname(python)}\nversion_info = ${version}.14\nrelocatable = true\n`);
} else if (args[0] === "pip" && args[1] === "sync") {
  const venv = dirname(dirname(args[args.indexOf("--python") + 1]!));
  const site = join(venv, "lib", readdirSync(join(venv, "lib"))[0]!, "site-packages");
  const pins = [...parseVoiceLock(readFileSync(args.at(-1)!, "utf8")).pins.values()];
  const archive = join(env.UV_CACHE_DIR!, "archive-v0");
  mkdirSync(archive, { recursive: true });
  const delay = Number(hook("uv-delay-ms")) || 0;
  let done = 0;
  for (const pin of pins) {
    const cached = join(archive, `${pin.name}-${pin.version}`);
    if (!existsSync(cached)) {
      await download(`wheels/${pin.name}-${pin.version}.whl`);
      mkdirSync(cached, { recursive: true });
    }
    if (++done === 10) {
      const fault = hook("uv-fault");
      if (fault === "enospc") {
        console.error(`error: Failed to install: ${pin.name}-${pin.version}-py3-none-any.whl\n  Caused by: failed to write to file \`${site}/${pin.name}/__init__.py\`: No space left on device (os error 28)`);
        process.exit(2);
      }
      if (fault === "hang") {
        writeFileSync(join(hooks, "uv.pid"), String(process.pid));
        for (;;) await Bun.sleep(60_000);
      }
    }
    if (delay) await Bun.sleep(delay);
  }
  for (const pin of pins) {
    const info = join(site, `${pin.name.replace(/-/g, "_")}-${pin.version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "METADATA"), `Metadata-Version: 2.1\nName: ${pin.name}\nVersion: ${pin.version}\n`);
  }
  cpSync(join(here, "stub"), site, { recursive: true });
} else {
  console.error(`uv stand-in: unexpected \`${args.join(" ")}\``);
  process.exit(2);
}
