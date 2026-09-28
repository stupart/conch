import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/fetch-pinned.sh is how conch's build fetches the sources it compiles
 * into the app (scripts/fetch-tmux.sh): on a slow network, so resumable; and
 * pinned, so nothing but the exact bytes ever lands. A stand-in curl plays the
 * server: it can resume or refuse to, drop the connection, or serve other bytes.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONTENT = "pinned source tarball bytes, twenty-something\n";
const SHA256 = new Bun.CryptoHasher("sha256").update(CONTENT).digest("hex");

/**
 * A curl that serves CONTENT to its -o file. Each call takes the next mode
 * (the last one repeats) and logs `have=<bytes already there> resume=<0|1>`:
 *   ranges  honours -C - (appends the rest), else writes everything
 *   norange a partial there cannot be resumed (curl exit 56, untouched)
 *   cut:K   writes K more bytes, then the connection drops (exit 28)
 *   wrong   serves other bytes, completely (exit 0)
 */
function server(modes: string[]) {
  const root = mkdtempSync(join(tmpdir(), "conch-fetch-pinned-"));
  roots.push(root);
  const source = join(root, "served");
  writeFileSync(source, CONTENT);
  writeFileSync(join(root, "modes"), modes.join("\n") + "\n");
  const log = join(root, "curl.log");
  const curl = join(root, "curl");
  writeFileSync(curl, `#!/bin/bash
out=""; resume=0
while [[ $# -gt 0 ]]; do
  case "$1" in -o) out="$2"; shift ;; -C) resume=1; shift ;; esac
  shift
done
mode="$(head -1 '${root}/modes')"
[[ "$(wc -l < '${root}/modes')" -gt 1 ]] && sed -i '' 1d '${root}/modes'
have=$(stat -f %z "$out" 2>/dev/null || echo 0)
echo "have=$have resume=$resume" >> '${log}'
case "$mode" in
  ranges) if [[ "$resume" == 1 ]]; then tail -c +$((have + 1)) '${source}' >> "$out"; else cat '${source}' > "$out"; fi ;;
  norange) if [[ "$have" -gt 0 ]]; then exit 56; fi; cat '${source}' > "$out" ;;
  cut:*) [[ "$resume" == 1 ]] || : > "$out"; tail -c +$((have + 1)) '${source}' | head -c "\${mode#cut:}" >> "$out"; exit 28 ;;
  wrong) echo "not the pinned bytes" > "$out" ;;
esac
`);
  chmodSync(curl, 0o755);
  mkdirSync(join(root, "cache"));
  const dest = join(root, "cache", "source.tar.gz");
  const run = async () => {
    const proc = Bun.spawn(["/bin/bash", repo("scripts/fetch-pinned.sh"), "https://example.invalid/source.tar.gz", SHA256, dest], {
      env: { PATH: "/usr/bin:/bin", CURL: curl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const setModes = (next: string[]) => writeFileSync(join(root, "modes"), next.join("\n") + "\n");
  return { root, dest, part: `${dest}.part`, run, calls, setModes };
}

describe("a pinned download: resumable, and only ever the pinned bytes", () => {
  test("a fresh download lands verified, with no partial left", async () => {
    const s = server(["ranges"]);
    const result = await s.run();
    expect(result.code).toBe(0);
    expect(readFileSync(s.dest, "utf8")).toBe(CONTENT);
    expect(existsSync(s.part)).toBeFalse();
    expect(s.calls()).toEqual(["have=0 resume=1"]);
  });

  test("a dropped connection is resumed where it stopped — in the same run, and in the next", async () => {
    const s = server(["cut:4", "cut:4", "cut:4"]);
    const first = await s.run();
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("stopped (curl exit 28) after 12 bytes; resuming");
    expect(readFileSync(s.part, "utf8")).toBe(CONTENT.slice(0, 12));
    expect(existsSync(s.dest)).toBeFalse();
    s.setModes(["ranges"]);
    const second = await s.run();
    expect(second.code).toBe(0);
    expect(readFileSync(s.dest, "utf8")).toBe(CONTENT);
    expect(s.calls()).toEqual(["have=0 resume=1", "have=4 resume=1", "have=8 resume=1", "have=12 resume=1"]);
  });

  test("a partial the server will not resume is started over, not retried forever", async () => {
    const s = server(["norange"]);
    writeFileSync(s.part, CONTENT.slice(0, 10));
    const result = await s.run();
    expect(result.stderr).toContain("could not be resumed (curl exit 56); starting it over");
    expect(result.code).toBe(0);
    expect(readFileSync(s.dest, "utf8")).toBe(CONTENT);
    expect(s.calls()).toEqual(["have=10 resume=1", "have=0 resume=1"]);
  });

  test("bytes that are not the pin never land, and are never resumed onto", async () => {
    const s = server(["wrong", "ranges"]);
    const result = await s.run();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("is not sha256");
    expect(readFileSync(s.dest, "utf8")).toBe(CONTENT);
    expect(s.calls()).toEqual(["have=0 resume=1", "have=0 resume=1"]);

    const bad = server(["wrong"]);
    const failed = await bad.run();
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(`could not fetch https://example.invalid/source.tar.gz as sha256 ${SHA256}`);
    expect(existsSync(bad.dest)).toBeFalse();
    expect(existsSync(bad.part)).toBeFalse();
    expect(bad.calls()).toHaveLength(3);
  });

  test("a cached copy is reused only while it verifies", async () => {
    const s = server(["ranges"]);
    writeFileSync(s.dest, CONTENT);
    expect((await s.run()).code).toBe(0);
    expect(s.calls()).toEqual([]);
    writeFileSync(s.dest, "tampered\n");
    expect((await s.run()).code).toBe(0);
    expect(readFileSync(s.dest, "utf8")).toBe(CONTENT);
    expect(s.calls()).toEqual(["have=0 resume=1"]);
  });

  test("fetch-tmux.sh gets every source through it, into the verified cache it unpacks from", () => {
    const fetch = readFileSync(repo("scripts/fetch-tmux.sh"), "utf8");
    for (const [name, file] of [["TMUX", "tmux-$TMUX_VERSION.tar.gz"], ["LIBEVENT", "libevent-$LIBEVENT_VERSION.tar.gz"], ["JEMALLOC", "jemalloc-$JEMALLOC_VERSION.tar.bz2"], ["UTF8PROC", "utf8proc-$UTF8PROC_VERSION.tar.gz"]]) {
      expect(fetch).toContain(`"$SCRIPT_DIR/fetch-pinned.sh" "$${name}_URL" "$${name}_SHA256" "$SOURCES/${file}"`);
      expect(fetch).toContain(`"$SOURCES/${file}" -C "$work"`);
    }
  });
});
