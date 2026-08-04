import { expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = async (...parts: string[]) =>
  await Bun.file(join(repoRoot, ...parts)).json();

// The plugin manifests are hand-maintained, and they drifted to 0.2.0 while
// conch shipped 0.2.1. Nothing caught it, because nothing compared them.
test("every plugin manifest carries the shipped conch version", async () => {
  const { version } = await read("package.json");
  expect(version).toBeTruthy();
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    const plugin = await read("plugin", "plugins", "conch", manifest, "plugin.json");
    expect({ manifest, version: plugin.version }).toEqual({ manifest, version });
  }
});
