import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubCacheDir, modelCacheBytes, modelRepoDir, verifyModelCache } from "../src/voice-model-cache.ts";

/**
 * Kokoro's model in the Hugging Face cache, checked file by file against its own hash, and only what is broken removed
 * so the next load fetches just that. Always a cache built here, in a temp dir: never the real one.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODEL = "mlx-community/Kokoro-82M-bf16";
const COMMIT = "a".repeat(40);

/** A cache laid out the way huggingface_hub lays it out: LFS blobs named by their sha256, small files by a git hash. */
function cache(files: Record<string, string | Uint8Array>): { hub: string; repo: string; blob: (path: string) => string } {
  const hub = mkdtempSync(join(tmpdir(), "conch-hf-test-"));
  roots.push(hub);
  const repo = modelRepoDir(hub, MODEL);
  mkdirSync(join(repo, "blobs"), { recursive: true });
  mkdirSync(join(repo, "refs"), { recursive: true });
  writeFileSync(join(repo, "refs", "main"), COMMIT);
  const blobs: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const etag = path.endsWith(".safetensors")
      ? createHash("sha256").update(bytes).digest("hex")
      : createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    writeFileSync(join(repo, "blobs", etag), bytes);
    const link = join(repo, "snapshots", COMMIT, path);
    mkdirSync(join(link, ".."), { recursive: true });
    const depth = path.split("/").length - 1;
    symlinkSync(`${"../".repeat(depth + 2)}blobs/${etag}`, link);
    blobs[path] = join(repo, "blobs", etag);
  }
  return { hub, repo, blob: (path) => blobs[path]! };
}

const weights = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
const voice = new Uint8Array(5_000).map((_, i) => (i * 7) % 253);

describe("Kokoro's files, proved against their own hashes", () => {
  test("a sound cache checks out, and nothing is touched", async () => {
    const { hub, repo } = cache({ "config.json": '{"model_type":"kokoro"}', "kokoro-v1_0.safetensors": weights, "voices/af_heart.safetensors": voice });
    const before = readdirSync(join(repo, "blobs")).sort();
    const check = await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(check).toEqual({ ok: true, absent: false, files: 3, broken: [], removed: [] });
    expect(readdirSync(join(repo, "blobs")).sort()).toEqual(before);
  });

  test("a damaged weight file is found, and only it is removed — link and blob — so only it is fetched again", async () => {
    const { hub, repo, blob } = cache({ "config.json": '{"model_type":"kokoro"}', "kokoro-v1_0.safetensors": weights, "voices/af_heart.safetensors": voice });
    // A download cut short, or a disk error: the same length, one byte different.
    const damaged = Buffer.from(weights);
    damaged[1234] = damaged[1234]! ^ 0xff;
    writeFileSync(blob("kokoro-v1_0.safetensors"), damaged);

    const looked = await verifyModelCache({ hub, model: MODEL, repair: false });
    expect(looked).toMatchObject({ ok: false, broken: ["kokoro-v1_0.safetensors"], removed: [] });
    expect(existsSync(blob("kokoro-v1_0.safetensors"))).toBeTrue();

    const repaired = await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(repaired.broken).toEqual(["kokoro-v1_0.safetensors"]);
    expect(repaired.removed.sort()).toEqual([blob("kokoro-v1_0.safetensors"), join(repo, "snapshots", COMMIT, "kokoro-v1_0.safetensors")].sort());
    expect(existsSync(blob("voices/af_heart.safetensors"))).toBeTrue();
    expect(existsSync(blob("config.json"))).toBeTrue();
    // What is left proves good; the missing file is huggingface_hub's to fetch.
    expect(await verifyModelCache({ hub, model: MODEL, repair: true })).toMatchObject({ ok: true, files: 2 });
  });

  test("every large file failing at once is a cache named another way, not all of Kokoro damaged: left alone unless forced", async () => {
    const { hub, blob } = cache({ "config.json": '{"model_type":"kokoro"}', "kokoro-v1_0.safetensors": weights, "voices/af_heart.safetensors": voice });
    for (const path of ["kokoro-v1_0.safetensors", "voices/af_heart.safetensors"]) writeFileSync(blob(path), "named by some other hash");
    const cautious = await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(cautious).toMatchObject({ ok: true, unverifiable: true, broken: [], removed: [] });
    expect(existsSync(blob("kokoro-v1_0.safetensors"))).toBeTrue();
    // The worker failed on the model itself: now it is removed, and fetched again.
    const forced = await verifyModelCache({ hub, model: MODEL, repair: true, force: true });
    expect(forced.broken.sort()).toEqual(["kokoro-v1_0.safetensors", "voices/af_heart.safetensors"]);
    expect(forced.unverifiable).toBeUndefined();
    expect(existsSync(blob("kokoro-v1_0.safetensors"))).toBeFalse();
  });

  test("a link to nothing, an empty file and unparseable JSON are broken too", async () => {
    const { hub, blob } = cache({ "config.json": '{"model_type":"kokoro"}', "voices/af_heart.safetensors": voice, "voices/am_adam.safetensors": voice.slice(0, 10) });
    rmSync(blob("voices/af_heart.safetensors"));
    writeFileSync(blob("config.json"), "{not json");
    const check = await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(check.broken.sort()).toEqual(["config.json", "voices/af_heart.safetensors"]);
    expect(check.ok).toBeFalse();
  });

  test("nothing downloaded yet is absent, not broken; a partial download in progress is left for huggingface_hub to resume", async () => {
    const hub = mkdtempSync(join(tmpdir(), "conch-hf-test-"));
    roots.push(hub);
    expect(await verifyModelCache({ hub, model: MODEL, repair: true })).toEqual({ ok: false, absent: true, files: 0, broken: [], removed: [] });

    const { hub: partialHub, repo } = cache({ "config.json": '{"model_type":"kokoro"}' });
    const incomplete = join(repo, "blobs", `${"b".repeat(64)}.incomplete`);
    writeFileSync(incomplete, new Uint8Array(70_000));
    expect((await verifyModelCache({ hub: partialHub, model: MODEL, repair: true })).ok).toBeTrue();
    expect(existsSync(incomplete)).toBeTrue();
    // …and counts toward how far the download has got.
    expect(modelCacheBytes(partialHub, MODEL)).toBe(70_000 + '{"model_type":"kokoro"}'.length);
  });

  test("a damaged link is removed, but a blob it names outside this model's own folder never is", async () => {
    const { hub, repo, blob } = cache({ "config.json": '{"model_type":"kokoro"}', "kokoro-v1_0.safetensors": weights });
    const other = modelRepoDir(hub, "someone/else");
    mkdirSync(join(other, "blobs"), { recursive: true });
    const foreign = join(other, "blobs", "d".repeat(64));
    writeFileSync(foreign, "not what its name says");
    const link = join(repo, "snapshots", COMMIT, "voices", "af_heart.safetensors");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(foreign, link);
    const check = await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(check.broken).toEqual(["voices/af_heart.safetensors"]);
    expect(check.removed).toEqual([link]);
    expect(existsSync(link)).toBeFalse();
    expect(existsSync(foreign)).toBeTrue();
    expect(existsSync(blob("kokoro-v1_0.safetensors"))).toBeTrue();
  });

  test("another model's files are never read or touched", async () => {
    const { hub, repo } = cache({ "kokoro-v1_0.safetensors": weights });
    const other = modelRepoDir(hub, "someone/else");
    mkdirSync(join(other, "blobs"), { recursive: true });
    writeFileSync(join(other, "blobs", "c".repeat(64)), "not what its name says");
    await verifyModelCache({ hub, model: MODEL, repair: true });
    expect(existsSync(join(other, "blobs", "c".repeat(64)))).toBeTrue();
    expect(repo).toContain("models--mlx-community--Kokoro-82M-bf16");
  });

  test("the cache is where huggingface_hub keeps it", () => {
    expect(hubCacheDir({ HF_HUB_CACHE: "/x/hub", HF_HOME: "/y" })).toBe("/x/hub");
    expect(hubCacheDir({ HF_HOME: "/y" })).toBe("/y/hub");
    expect(hubCacheDir({ XDG_CACHE_HOME: "/xdg", HOME: "/h" })).toBe("/xdg/huggingface/hub");
    expect(hubCacheDir({ HOME: "/h" })).toBe("/h/.cache/huggingface/hub");
  });
});
