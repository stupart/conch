import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlApplication } from "../src/control-server.ts";
import { createPreviewRequester, PreviewLimiter, previewFolder, WindowPreviews } from "../src/review-preview.ts";
import type { SessionReview } from "../src/panel.ts";

/**
 * An app's window, snapshotted for the phone by the Mac app: the daemon names what it wants on the published state and
 * the app answers over the socket. The app's answer is trusted for nothing, and the app takes only the window of the
 * app the session built, only while Screen Recording is already granted. Tyler (09-25): "it will also need other
 * materials sent to it if there's not an equivalent on the phone".
 */
const scratch = mkdtempSync(join(tmpdir(), "conch-window-preview-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const swift = Bun.which("swift");

function broker(timeoutMs = 2_000) {
  const folder = previewFolder(mkdtempSync(join(scratch, "t-")));
  let published = 0;
  const previews = new WindowPreviews({ publish: () => { published += 1; }, folder: () => folder, now: () => 42, timeoutMs });
  const write = (name: string, mode = 0o600, where = folder) => {
    const path = join(where, name);
    writeFileSync(path, "png");
    chmodSync(path, mode);
    return path;
  };
  return { previews, folder, write, published: () => published };
}

describe("the daemon trusts the app's answer for nothing", () => {
  test("a request is published while it waits, with the folder to write in, and gone once answered", async () => {
    const { previews, folder, write, published } = broker();
    const asked = previews.ask("s", "app-1");
    const [request] = previews.requests();
    expect(request).toMatchObject({ sessionId: "s", review: "app-1", folder });
    expect(published()).toBe(1);
    const path = write(`${request!.id}.png`);
    expect(await previews.answer({ request: request!.id, path })).toEqual({ ok: true });
    expect(await asked).toEqual({ ok: true, preview: { path: require("node:fs").realpathSync(path), kind: "image", capturedAt: 42 } });
    expect(previews.requests()).toEqual([]);
    expect(published()).toBe(2);
  });

  test("outside conch's snapshot folder, readable by others, a link out, or no request waiting: refused", async () => {
    const { previews, write, folder } = broker();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    const cases: Array<(id: string) => string> = [
      (id) => write(`${id}.png`, 0o600, elsewhere),
      (id) => write(`${id}.png`, 0o644),
      // Its owner's alone, but executable: the publish rule refuses it.
      (id) => write(`${id}.png`, 0o700),
      (id) => {
        const link = join(folder, `${id}.png`);
        symlinkSync(join(root, "package.json"), link);
        return link;
      },
      (id) => {
        mkdirSync(join(folder, ".hidden"), { recursive: true });
        return write(`${id}.png`, 0o600, join(folder, ".hidden"));
      },
    ];
    for (const make of cases) {
      const asked = previews.ask("s", "app-1");
      const id = previews.requests()[0]!.id;
      expect((await previews.answer({ request: id, path: make(id) })).ok).toBe(false);
      expect(await asked).toMatchObject({ ok: false });
    }
    expect(await previews.answer({ request: "nobody-asked", path: write("x.png") })).toMatchObject({ ok: false });
  });

  test("the app's refusal is passed on in its words; no answer at all times out", async () => {
    const { previews } = broker(50);
    const refused = previews.ask("s", "app-1");
    await previews.answer({ request: previews.requests()[0]!.id, error: "conch's Mac app hasn't been allowed Screen Recording" });
    expect(await refused).toEqual({ ok: false, error: "conch's Mac app hasn't been allowed Screen Recording" });
    expect(await previews.ask("s", "app-1")).toMatchObject({ ok: false, error: expect.stringMatching(/may not be open/) });
    expect(previews.requests()).toEqual([]);
  });

  test("an app window goes to the Mac app; a design or a terminal is refused in words, nothing taken", async () => {
    const reviews: SessionReview[] = [
      { summary: "the app", at: 1, id: "app-1", kind: "app" },
      { summary: "the design", at: 2, id: "design-1", kind: "design" },
      { summary: "the terminal", at: 3, id: "term-1", kind: "terminal" },
    ];
    const windows: string[] = [];
    const attached: string[] = [];
    const ask = createPreviewRequester({
      held: () => ({ reviews, roots: [] }),
      attach: (_session, review) => { attached.push(review); return true; },
      limiter: new PreviewLimiter(),
      folder: () => scratch,
      now: Date.now,
      probe: async () => { throw new Error("the daemon captured something itself"); },
      window: async (_session, review) => {
        windows.push(review);
        return { ok: true, preview: { path: join(scratch, "w.png"), kind: "image", capturedAt: 1 } };
      },
    });
    expect(await ask("s", "app-1")).toEqual({ status: 200 });
    expect(await ask("s", "design-1")).toMatchObject({ status: 422, error: expect.stringMatching(/which Figma window/) });
    expect(await ask("s", "term-1")).toMatchObject({ status: 422, error: expect.stringMatching(/own conversation/) });
    expect(windows).toEqual(["app-1"]);
    expect(attached).toEqual(["app-1"]);
  });

  test("over the socket, before any session is resolved", async () => {
    const dir = mkdtempSync("/tmp/conch-preview-sock-");
    const answered: unknown[] = [];
    const resolved: unknown[] = [];
    const server = createControlServer({
      socketPath: join(dir, "s.sock"),
      ownerDeviceId: "mac",
      log: () => {},
      sessions: { resolve: (value) => { resolved.push(value); return value; }, current: () => ({ published: false }) },
      application: {} as ControlApplication,
      onReviewPreview: async (message) => {
        answered.push(message);
        return message.request === "r1" ? { ok: true } : { ok: false, error: "no snapshot is waiting on that request" };
      },
    });
    expect(await server.start()).toBe(true);
    const exchange = (value: unknown) => new Promise<unknown>((resolve, reject) => {
      const socket = connect({ path: join(dir, "s.sock") });
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => resolve(JSON.parse(data)));
      socket.on("error", reject);
      socket.write(`${JSON.stringify(value)}\n`);
    });
    try {
      expect(await exchange({ kind: "review-preview", request: "r1", path: "/tmp/x.png" })).toEqual({ kind: "preview-ack" });
      expect(await exchange({ kind: "review-preview", request: "r2", path: "/tmp/x.png" }))
        .toEqual({ kind: "preview-error", error: "no snapshot is waiting on that request" });
      expect(answered).toHaveLength(2);
      expect(resolved).toEqual([]);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Mac app takes only the deliverable's own window, only with a grant it already has", () => {
  const mac = read("mac-app/conch-mac/WindowPreview.swift");
  const owner = mac.slice(mac.indexOf("enum PreviewOwner {"));

  test.skipIf(!swift)("the one app the session built into its own folder; never home, never conch, never a guess", () => {
    const dir = mkdtempSync(join(scratch, "owner-"));
    const file = join(dir, "main.swift");
    writeFileSync(file, ["import Foundation", owner,
      'let apps: [(pid: Int32, bundle: String)] = [(pid: 10, bundle: "/Users/t/proj/build/App.app"), (pid: 11, bundle: "/Applications/Figma.app"), (pid: 12, bundle: "/Users/t/Applications/Other.app"), (pid: 99, bundle: "/Users/t/proj/build/conch.app")]',
      'print(PreviewOwner.pick(apps, roots: ["/Users/t/proj"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.pick(apps, roots: ["/Users/t/elsewhere"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.pick(apps, roots: ["/Users/t"], own: 99, home: "/Users/t") ?? -1)',
      // A session started in home owns no app, even the only one under it.
      'print(PreviewOwner.pick([(pid: 12, bundle: "/Users/t/Applications/Other.app")], roots: ["/Users/t"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.pick(apps, roots: ["/"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.pick(apps + [(pid: 13, bundle: "/Users/t/proj/build/Second.app")], roots: ["/Users/t/proj"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.pick(apps, roots: ["/Users/t/pro"], own: 99, home: "/Users/t") ?? -1)',
      'print(PreviewOwner.folder("/tmp/conch-previews", temp: ["/tmp"]) ?? "nil")',
      'print(PreviewOwner.folder("/tmp/elsewhere", temp: ["/tmp"]) ?? "nil")',
      'print(PreviewOwner.folder("/Users/t/conch-previews", temp: ["/tmp"]) ?? "nil")',
      'print(PreviewOwner.folder("/tmp/x/../conch-previews", temp: ["/tmp"]) ?? "nil")',
    ].join("\n"));
    const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    expect(run.stdout.toString().trim().split("\n")).toEqual([
      "10", "-1", "-1", "-1", "-1", "-1", "-1",
      // Foundation spells `/private/tmp` as `/tmp`; the daemon compares real paths itself.
      "/tmp/conch-previews", "nil", "nil", "/tmp/conch-previews",
    ]);
  }, 60_000);

  test("Screen Recording is checked, never asked for; only that app's own ordinary window, 0600", () => {
    expect(mac).toContain("guard CGPreflightScreenCaptureAccess() else {");
    expect(mac).not.toContain("CGRequestScreenCaptureAccess(");
    expect(mac).toContain(".filter({ $0.owningApplication?.processID == owner && $0.windowLayer == 0 && $0.isOnScreen })");
    expect(mac).toContain("let filter = SCContentFilter(desktopIndependentWindow: window)");
    expect(mac).not.toContain("SCContentFilter(display:");
    expect(mac).toContain("attributes: [.posixPermissions: 0o600]");
    expect(mac).toContain("guard let folder = PreviewOwner.folder(request.folder, temp: [NSTemporaryDirectory(), \"/tmp\"]) else {");
    // Handled once however many snapshots name it; the store hands every snapshot's requests over.
    expect(read("mac-app/conch-mac/StateStore.swift")).toContain("windowPreviewer.handle(snapshot.previewRequests, rows: snapshot.rows)");
    expect(read("mac-app/conch-mac/StateStore.swift")).toContain("previewRequests: sourceState.previewRequests");
    expect(read("mac-app/conch-mac.xcodeproj/project.pbxproj").match(/\/\* WindowPreview\.swift in Sources \*\/,/g)?.length).toBe(1);
  });
});
