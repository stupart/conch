import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askClaude, FAST_MODEL } from "../src/model.ts";

const roots: string[] = [];

async function script(body: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "conch-model-test-"));
  roots.push(root);
  const path = join(root, "claude-stub");
  await Bun.write(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("askClaude", () => {
  test("writes the prompt on stdin and trims, flattens, and caps stdout", async () => {
    const bin = await script(`
test "$1" = "-p"
test "$2" = "--model"
test "$3" = "${FAST_MODEL}"
prompt="$(cat)"
test "$prompt" = "the prompt"
printf '  alpha\\n beta gamma  '
`);

    expect(await askClaude("the prompt", { bin, maxChars: 10 }))
      .toBe("alpha beta");
  });

  test("returns null on a non-zero exit", async () => {
    const bin = await script(`
cat >/dev/null
exit 1
`);
    expect(await askClaude("prompt", { bin })).toBeNull();
  });

  test("returns null on empty output", async () => {
    const bin = await script(`
cat >/dev/null
printf '  \\n  '
`);
    expect(await askClaude("prompt", { bin })).toBeNull();
  });

  test("sets the internal recursion guard in the child environment", async () => {
    const bin = await script(`
cat >/dev/null
printf '%s' "$CONCH_INTERNAL"
`);
    expect(await askClaude("prompt", { bin })).toBe("1");
  });

  test("kills a timed-out child and returns promptly", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-model-timeout-"));
    roots.push(root);
    const pidPath = join(root, "pid");
    // Record the pid BEFORE reading stdin. This used to wait on `cat` first,
    // so a 100ms timeout could kill the child before it ever wrote the file
    // and the assertion below died on ENOENT instead of failing honestly —
    // roughly one run in three on a loaded machine. The race was the fixture's,
    // not the code's: askClaude was killing the child correctly every time.
    const bin = await script(`
printf '%s' "$$" > "${pidPath}"
cat >/dev/null
exec sleep 30
`);
    const started = performance.now();

    expect(await askClaude("prompt", { bin, timeoutMs: 100 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);

    const pid = readFileSync(pidPath, "utf8").trim();
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = Bun.spawnSync(["kill", "-0", pid], {
        stdout: "ignore",
        stderr: "ignore",
      });
      alive = probe.exitCode === 0;
      if (!alive) break;
      await Bun.sleep(10);
    }
    expect(alive).toBeFalse();
  });

  test("returns null when the binary cannot be spawned", async () => {
    expect(await askClaude("prompt", {
      bin: `/tmp/conch-missing-model-bin-${Date.now()}`,
    })).toBeNull();
  });
});
