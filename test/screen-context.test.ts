import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScreenContext,
  localhostPort,
  portListenerLookup,
  publishedShowing,
  resolveScreen,
  SCREEN_OBSERVERS,
  SCREEN_RESOLVERS,
  ScreenLog,
  screenContextFromPublished,
  validateScreenObservation,
  type PortListener,
  type Probe,
  type ScreenLogEntry,
  type ScreenObservation,
  type ScreenResolveContext,
  type ScreenResolver,
} from "../src/screen-context.ts";
import { createControlServer, type ControlApplication } from "../src/control-server.ts";
import { buildPublishedState, type PanelModel } from "../src/panel.ts";
import { AGENT_TUNABLE_SETTINGS, createMcpToolHandlers, defaultMcpDependencies } from "../src/mcp.ts";
import { SETTING_REGISTRY } from "../src/settings.ts";
import { loadConfig } from "../src/config.ts";
import { probeCommand } from "../src/probe.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(prefix = "conch-screen-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const AT = 1_790_000_000_000;

function observation(fields: Partial<ScreenObservation> = {}): ScreenObservation {
  return { v: 1, source: "conch-staged", at: AT, surface: { kind: "unknown" }, ...fields };
}

function context(fields: Partial<ScreenResolveContext> = {}): ScreenResolveContext {
  return {
    sessions: [],
    deliverables: [],
    now: AT,
    home: "/Users/t",
    realpath: (path) => path,
    ...fields,
  };
}

describe("an observation is checked at the socket", () => {
  test("every surface kind the contract names is accepted, and rebuilt without unknown fields", () => {
    const surfaces: ScreenObservation["surface"][] = [
      { kind: "file", path: "/Users/t/p/out.md" },
      { kind: "url", url: "http://localhost:3000/review?x=1" },
      { kind: "terminal", tty: "/dev/ttys004" },
      { kind: "terminal" },
      { kind: "simulator", udid: "0F3C-11AB", bundleId: "ai.conch.ios" },
      { kind: "app", bundleId: "com.figma.Desktop", document: "Checkout flow" },
      { kind: "design" },
      { kind: "conch", sessionId: "s1", view: "overlay" },
      { kind: "unknown" },
    ];
    for (const surface of surfaces) {
      const checked = validateScreenObservation({ ...observation(), surface, extra: "dropped" });
      expect(checked).toEqual({ ok: true, value: { ...observation(), surface } });
    }
    const full = validateScreenObservation({
      ...observation(),
      surface: { kind: "file", path: "/p/x.md", junk: 1 },
      app: { bundleId: "com.apple.Preview", pid: 42, name: "Preview", junk: 1 },
      window: { title: "x.md" },
      staged: { sessionId: "s1", reviewId: "r1", link: "/p/x.md", artifact: "/p/x.md" },
    });
    expect(full).toEqual({
      ok: true,
      value: {
        ...observation(),
        surface: { kind: "file", path: "/p/x.md" },
        app: { bundleId: "com.apple.Preview", pid: 42, name: "Preview" },
        window: { title: "x.md" },
        staged: { sessionId: "s1", reviewId: "r1", link: "/p/x.md", artifact: "/p/x.md" },
      },
    });
  });

  test("anything malformed is refused with the field that failed", () => {
    const bad: Array<[unknown, string]> = [
      [null, "must be an object"],
      [{ ...observation(), v: 2 }, "v must be 1"],
      [{ ...observation(), source: "someone-else" }, "unknown observer"],
      [{ ...observation(), at: -1 }, "at must be"],
      [{ ...observation(), at: Number.NaN }, "at must be"],
      [{ ...observation(), surface: { kind: "hologram" } }, "unknown surface kind"],
      [{ ...observation(), surface: { kind: "file" } }, "surface.path is required"],
      [{ ...observation(), surface: { kind: "file", path: "relative/x.md" } }, "must be absolute"],
      [{ ...observation(), surface: { kind: "url", url: "javascript:alert(1)" } }, "http(s) URL"],
      [{ ...observation(), surface: { kind: "terminal", tty: "; rm -rf" } }, "surface.tty is malformed"],
      [{ ...observation(), surface: { kind: "app", document: "x" } }, "surface.bundleId is required"],
      [{ ...observation(), surface: { kind: "conch", sessionId: "s", view: "sidebar" } }, "surface.view must be"],
      [{ ...observation(), surface: { kind: "conch", sessionId: "s\u0007", view: "main" } }, "control characters"],
      [{ ...observation(), app: { bundleId: "not a bundle" } }, "app.bundleId"],
      [{ ...observation(), app: { bundleId: "com.x", pid: 0 } }, "app.pid"],
      [{ ...observation(), app: null }, "app must be an object"],
      [{ ...observation(), staged: { reviewId: "r" } }, "staged.sessionId"],
      [{ ...observation(), staged: { sessionId: "s", link: "x".repeat(9_000) } }, "cannot exceed"],
    ];
    for (const [value, error] of bad) {
      const checked = validateScreenObservation(value);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.err).toContain(error);
    }
  });

  test("the observer registry is what the socket accepts: conch-staged and front-window, nothing else", () => {
    expect(SCREEN_OBSERVERS.map((observer) => observer.id)).toEqual(["conch-staged", "front-window"]);
    const front = observation({ source: "front-window", app: { bundleId: "com.google.Chrome" }, surface: { kind: "url", url: "http://localhost:5173/" } });
    expect(validateScreenObservation(front)).toEqual({ ok: true, value: front });
    for (const source of ["ax-front-window", "front_window", "", undefined]) {
      expect(validateScreenObservation({ ...front, source })).toMatchObject({ ok: false, err: expect.stringContaining("unknown observer") });
    }
  });
});

describe("resolvers", () => {
  const held = [
    { sessionId: "a", reviewId: "a-1", link: "/p/a/out.md" },
    { sessionId: "a", reviewId: "a-2", link: "/p/a/out.md", artifact: "report" },
    { sessionId: "b", reviewId: "b-1", link: "http://localhost:3000/review/" },
  ];

  test("staged: exact, at 1.0, with the published record's artifact over the link", () => {
    const showing = resolveScreen(
      observation({ surface: { kind: "file", path: "/p/a/out.md" }, staged: { sessionId: "a", reviewId: "a-2", link: "/p/a/out.md" } }),
      context({ deliverables: held }),
    );
    expect(showing).toMatchObject({ sessionId: "a", reviewId: "a-2", artifact: "report", confidence: 1 });
    expect(showing.reason).toStartWith("staged:");
    // No record artifact: the link the pill opened stands in.
    expect(resolveScreen(
      observation({ surface: { kind: "terminal" }, staged: { sessionId: "a", reviewId: "a-1", link: "/p/a/out.md" } }),
      context({ deliverables: held }),
    )).toMatchObject({ sessionId: "a", reviewId: "a-1", artifact: "/p/a/out.md", confidence: 1 });
    // conch's own window names its session too.
    expect(resolveScreen(observation({ surface: { kind: "conch", sessionId: "c", view: "main" } }), context()))
      .toMatchObject({ sessionId: "c", confidence: 1, reason: "staged: conch's own window shows it" });
  });

  test("deliverable-link: a file by its real path, the newest version of it", () => {
    const realpath = (path: string) => path.replace("/link/", "/p/");
    const showing = resolveScreen(
      observation({ surface: { kind: "file", path: "/link/a/out.md" } }),
      context({ deliverables: held, realpath }),
    );
    expect(showing).toMatchObject({ sessionId: "a", reviewId: "a-2", artifact: "report", confidence: 0.9 });
    expect(showing.reason).toStartWith("deliverable-link:");
    // A document an app has open is a file too.
    expect(resolveScreen(
      observation({ surface: { kind: "app", bundleId: "com.apple.Preview", document: "/p/a/out.md" } }),
      context({ deliverables: held }),
    )).toMatchObject({ sessionId: "a", reviewId: "a-2" });
  });

  test("deliverable-link: a page by origin and path, whatever its query, fragment or trailing slash", () => {
    for (const url of ["http://localhost:3000/review", "http://LOCALHOST:3000/review/?tab=2#top"]) {
      expect(resolveScreen(observation({ surface: { kind: "url", url } }), context({ deliverables: held })))
        .toMatchObject({ sessionId: "b", reviewId: "b-1", artifact: "http://localhost:3000/review/" });
    }
    expect(resolveScreen(observation({ surface: { kind: "url", url: "http://localhost:3001/review" } }), context({ deliverables: held })).sessionId)
      .toBeUndefined();
  });

  test("deliverable-link: two sessions holding the same link is ambiguous, not a guess", () => {
    const showing = resolveScreen(
      observation({ surface: { kind: "file", path: "/p/shared.md" } }),
      context({ deliverables: [{ sessionId: "a", link: "/p/shared.md" }, { sessionId: "b", link: "/p/shared.md" }] }),
    );
    expect(showing.sessionId).toBeUndefined();
    expect(showing.candidates).toEqual(["a", "b"]);
    expect(showing.confidence).toBeCloseTo(0.45);
    expect(showing.reason).toStartWith("deliverable-link: ambiguous");
  });

  test("terminal-tty: the session on that tty, with or without /dev/", () => {
    const sessions = [{ sessionId: "a", tty: "ttys004" }, { sessionId: "b", tty: "/dev/ttys009" }];
    expect(resolveScreen(observation({ surface: { kind: "terminal", tty: "/dev/ttys004" } }), context({ sessions })))
      .toMatchObject({ sessionId: "a", confidence: 0.8 });
    expect(resolveScreen(observation({ surface: { kind: "terminal", tty: "ttys009" } }), context({ sessions })).sessionId).toBe("b");
    expect(resolveScreen(observation({ surface: { kind: "terminal" } }), context({ sessions })).sessionId).toBeUndefined();
    const twice = resolveScreen(
      observation({ surface: { kind: "terminal", tty: "ttys004" } }),
      context({ sessions: [...sessions, { sessionId: "c", tty: "ttys004" }] }),
    );
    expect(twice).toMatchObject({ candidates: ["a", "c"], reason: expect.stringContaining("ambiguous") });
  });

  test("folder: the most specific session folder, workDirs included", () => {
    const sessions = [
      { sessionId: "outer", cwd: "/Users/t/p" },
      { sessionId: "inner", cwd: "/Users/t/elsewhere", workDirs: ["/Users/t/p/app"] },
    ];
    expect(resolveScreen(observation({ surface: { kind: "file", path: "/Users/t/p/app/x.ts" } }), context({ sessions })))
      .toMatchObject({ sessionId: "inner", confidence: 0.5 });
    expect(resolveScreen(observation({ surface: { kind: "file", path: "/Users/t/p/README.md" } }), context({ sessions })).sessionId)
      .toBe("outer");
    // A sibling folder that shares a prefix is not inside.
    expect(resolveScreen(observation({ surface: { kind: "file", path: "/Users/t/p-old/x" } }), context({ sessions })).sessionId)
      .toBeUndefined();
  });

  test("folder: the home folder names no project, and a tie is ambiguous", () => {
    const home = [{ sessionId: "help", cwd: "/Users/t" }];
    const showing = resolveScreen(observation({ surface: { kind: "file", path: "/Users/t/Downloads/x.png" } }), context({ sessions: home }));
    expect(showing).toMatchObject({ confidence: 0, reason: "no resolver recognised it" });
    // Home reached through a symlink is still home.
    const linked = resolveScreen(
      observation({ surface: { kind: "file", path: "/Users/t/x" } }),
      context({ sessions: [{ sessionId: "h", cwd: "/home-link" }], realpath: (path) => path.replace("/home-link", "/Users/t") }),
    );
    expect(linked.sessionId).toBeUndefined();
    const tie = resolveScreen(
      observation({ surface: { kind: "file", path: "/Users/t/p/x" } }),
      context({ sessions: [{ sessionId: "a", cwd: "/Users/t/p" }, { sessionId: "b", cwd: "/Users/t/p/" }] }),
    );
    expect(tie.sessionId).toBeUndefined();
    expect(tie.candidates).toEqual(["a", "b"]);
  });

  describe("localhost-port", () => {
    const page = (url = "http://localhost:5173/review") => observation({ source: "front-window", surface: { kind: "url", url } });
    const sessions = [
      { sessionId: "a", cwd: "/Users/t/p/app", pid: 100 },
      { sessionId: "b", cwd: "/Users/t/p", pid: 200 },
      { sessionId: "help", cwd: "/Users/t", pid: 300 },
    ];
    const serving = (listeners: PortListener[]) => context({ sessions, listeners });

    test("a localhost, 127.0.0.1 or [::1] page names its port; anything else is not this resolver's", () => {
      expect(localhostPort({ kind: "url", url: "http://localhost:5173/x" })).toBe(5173);
      expect(localhostPort({ kind: "url", url: "http://127.0.0.1:8080" })).toBe(8080);
      expect(localhostPort({ kind: "url", url: "http://[::1]:3000/" })).toBe(3000);
      expect(localhostPort({ kind: "url", url: "http://localhost/" })).toBe(80);
      expect(localhostPort({ kind: "url", url: "https://localhost/" })).toBe(443);
      expect(localhostPort({ kind: "url", url: "https://example.com:5173/" })).toBeUndefined();
      expect(localhostPort({ kind: "file", path: "/Users/t/p/x" })).toBeUndefined();
      expect(resolveScreen(page("https://example.com:5173/"), serving([{ pid: 900, parents: [100] }])).sessionId).toBeUndefined();
    });

    test("the parent chain: the session whose process started the server, the nearest one winning", () => {
      const showing = resolveScreen(page(), serving([{ pid: 900, cwd: "/Users/t/p/app", parents: [899, 200, 1] }]));
      expect(showing).toMatchObject({ sessionId: "b", confidence: 0.7 });
      expect(showing.reason).toBe("localhost-port: the session that started the server on :5173");
      // A session started inside another's tree is the more specific.
      expect(resolveScreen(page(), serving([{ pid: 900, parents: [100, 200] }])).sessionId).toBe("a");
      // The session's own process listening is that session.
      expect(resolveScreen(page(), serving([{ pid: 200, parents: [] }])).sessionId).toBe("b");
    });

    test("the listener's folder, when no session started it, below the parent chain", () => {
      // Started from Tyler's own shell, running in a's folder: the most specific folder wins.
      const showing = resolveScreen(page(), serving([{ pid: 900, cwd: "/Users/t/p/app/web", parents: [800, 1] }]));
      expect(showing).toMatchObject({ sessionId: "a", confidence: 0.6 });
      expect(showing.reason).toBe("localhost-port: the server on :5173 runs in the session's folder");
      // The home folder names no project, as for files.
      expect(resolveScreen(page(), serving([{ pid: 900, cwd: "/Users/t/Downloads", parents: [] }])).sessionId).toBeUndefined();
      // The chain outranks the folder, even when the folder names someone else.
      expect(resolveScreen(page(), serving([{ pid: 900, cwd: "/Users/t/p/app", parents: [200] }])).sessionId).toBe("b");
    });

    test("two listeners that point at different sessions are ambiguous, never a guess", () => {
      const byChain = resolveScreen(page(), serving([{ pid: 900, parents: [100] }, { pid: 901, parents: [200] }]));
      expect(byChain).toMatchObject({ candidates: ["a", "b"], confidence: 0.35 });
      expect(byChain.sessionId).toBeUndefined();
      expect(byChain.reason).toStartWith("localhost-port: ambiguous");
      const byFolder = resolveScreen(page(), context({
        sessions: [{ sessionId: "a", cwd: "/Users/t/p" }, { sessionId: "c", cwd: "/Users/t/p/" }],
        listeners: [{ pid: 900, cwd: "/Users/t/p/web", parents: [] }],
      }));
      expect(byFolder).toMatchObject({ candidates: ["a", "c"], confidence: 0.3 });
    });

    test("nobody listening, or no lookup at all, resolves to nothing", () => {
      expect(resolveScreen(page(), serving([]))).toMatchObject({ confidence: 0, reason: "no resolver recognised it" });
      expect(resolveScreen(page(), context({ sessions })).sessionId).toBeUndefined();
      // A listener nothing points at.
      expect(resolveScreen(page(), serving([{ pid: 900, parents: [1] }])).sessionId).toBeUndefined();
    });

    test("a held deliverable at that page still outranks who serves it", () => {
      const showing = resolveScreen(page(), context({
        sessions,
        deliverables: [{ sessionId: "help", reviewId: "r", link: "http://localhost:5173/review" }],
        listeners: [{ pid: 900, parents: [100] }],
      }));
      expect(showing).toMatchObject({ sessionId: "help", reviewId: "r" });
    });
  });

  test("in order: the first that answers wins, and the list is the extension point", () => {
    expect(SCREEN_RESOLVERS.map((resolver) => resolver.id)).toEqual(["staged", "deliverable-link", "terminal-tty", "localhost-port", "folder"]);
    const sessions = [{ sessionId: "folder-owner", cwd: "/p" }];
    const deliverables = [{ sessionId: "publisher", reviewId: "r", link: "/p/a/out.md" }];
    const file = { kind: "file", path: "/p/a/out.md" } as const;
    // A held deliverable beats the folder it sits in; conch's own staging beats both.
    expect(resolveScreen(observation({ surface: file }), context({ sessions, deliverables })).sessionId).toBe("publisher");
    expect(resolveScreen(observation({ surface: file, staged: { sessionId: "stager" } }), context({ sessions, deliverables })).sessionId)
      .toBe("stager");
    // A vision resolver in the last slot answers only what nothing before it could.
    const vision: ScreenResolver = {
      id: "vision",
      resolve: () => ({ sessionId: "seen", confidence: 0.3, reason: "the screenshot matches a deliverable" }),
    };
    const withVision = [...SCREEN_RESOLVERS, vision];
    expect(resolveScreen(observation({ surface: file }), context({ sessions, deliverables }), withVision).sessionId).toBe("publisher");
    expect(resolveScreen(observation({ surface: { kind: "unknown" } }), context(), withVision))
      .toMatchObject({ sessionId: "seen", reason: "vision: the screenshot matches a deliverable" });
  });
});

describe("the port lookup", () => {
  /** A fake `lsof`/`ps`, keyed by the command; every call is recorded. */
  function probes(answers: Record<string, string | null>) {
    const calls: Array<{ argv: string[]; ok: readonly number[]; timeoutMs: number }> = [];
    const probe: Probe = async (argv, ok, timeoutMs) => {
      calls.push({ argv, ok, timeoutMs });
      const key = argv.join(" ");
      return key in answers ? answers[key]! : null;
    };
    return { probe, calls };
  }
  const WORLD = {
    "lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp": "p900\nf14\np900\nf15\n",
    "lsof -a -p 900 -d cwd -Fn": "p900\nfcwd\nn/Users/t/p/app\n",
    "ps -Ao pid=,ppid=": "    1     0\n  200     1\n  899   200\n  900   899\n",
  };

  test("lsof's listeners, each with its folder and its parents up to launchd, every probe on the leash", async () => {
    const { probe, calls } = probes(WORLD);
    expect(await portListenerLookup({ probe, timeoutMs: 750 })(5173)).toEqual([{ pid: 900, cwd: "/Users/t/p/app", parents: [899, 200] }]);
    expect(calls.map((call) => call.argv.join(" ")).sort()).toEqual(Object.keys(WORLD).sort());
    expect(calls.every((call) => call.timeoutMs === 750)).toBe(true);
    // lsof's "nothing matched" is an answer.
    expect(calls.filter((call) => call.argv[0] === "lsof").every((call) => call.ok.includes(1))).toBe(true);
  });

  test("nobody listening asks nothing more; an unknown folder or parent table leaves that part out", async () => {
    const quiet = probes({ "lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp": "" });
    expect(await portListenerLookup({ probe: quiet.probe })(5173)).toEqual([]);
    expect(quiet.calls).toHaveLength(1);
    const partial = probes({ "lsof -nP -iTCP:5173 -sTCP:LISTEN -Fp": "p900\n" });
    expect(await portListenerLookup({ probe: partial.probe })(5173)).toEqual([{ pid: 900, parents: [] }]);
  });

  test("a probe that ran out of time (or threw) is no listener, so the page resolves to nothing", async () => {
    const { probe } = probes({});
    expect(await portListenerLookup({ probe })(5173)).toEqual([]);
    const throws: Probe = async () => { throw new Error("spawn failed"); };
    expect(await portListenerLookup({ probe: throws })(5173)).toEqual([]);
  });

  test("probeCommand kills a probe that outlives its leash and answers null", async () => {
    const started = Date.now();
    expect(await probeCommand(["sleep", "5"], [0], 100)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await probeCommand(["echo", "p1"], [0], 1_000)).toBe("p1\n");
  });

  test("cached per port for the ttl, then asked again", async () => {
    const { probe, calls } = probes(WORLD);
    let now = AT;
    const lookup = portListenerLookup({ probe, ttlMs: 5_000, now: () => now });
    await lookup(5173);
    const asked = calls.length;
    now += 4_999;
    await lookup(5173);
    expect(calls).toHaveLength(asked);
    await lookup(3000); // another port is its own question
    expect(calls.length).toBeGreaterThan(asked);
    const before = calls.length;
    now += 1;
    await lookup(5173);
    expect(calls.length).toBeGreaterThan(before);
  });
});

describe("what is published", () => {
  const model = {
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "" },
    rows: [],
  } as unknown as PanelModel;

  test("buildPublishedState carries `showing` at the top level, and nothing when there is none", () => {
    const showing = publishedShowing(resolveScreen(observation({ surface: { kind: "conch", sessionId: "s", view: "main" } }), context()));
    const published = buildPublishedState("mac", model, new Map(), new Set(), AT, { showing });
    expect(published.showing).toEqual({
      sessionId: "s", confidence: 1, reason: "staged: conch's own window shows it",
      surface: { kind: "conch", sessionId: "s", view: "main" }, source: "conch-staged", at: AT,
    });
    expect("showing" in buildPublishedState("mac", model, new Map(), new Set(), AT)).toBe(false);
  });

  test("a surface that resolved to nobody goes out as its kind alone", () => {
    const unresolved = resolveScreen(observation({ surface: { kind: "file", path: "/Users/t/secret/tax.pdf" } }), context());
    expect(publishedShowing(unresolved).surface).toEqual({ kind: "file" });
    expect(JSON.stringify(publishedShowing(unresolved))).not.toContain("tax.pdf");
    const ambiguous = resolveScreen(
      observation({ surface: { kind: "file", path: "/p/x" } }),
      context({ sessions: [{ sessionId: "a", cwd: "/p" }, { sessionId: "b", cwd: "/p" }] }),
    );
    expect(publishedShowing(ambiguous).surface).toEqual({ kind: "file", path: "/p/x" });
  });

  test("the daemon's context comes from its published rows: folders, pids and every held deliverable", () => {
    const built = screenContextFromPublished(
      [
        { id: "a", cwd: "/p/a", workDirs: ["/p/a/app"], reviews: [{ id: "a-1", link: "/p/a/1.md" }, { id: "a-2", link: "/p/a/2.md", artifact: "spec" } as { id: string; link: string }] },
        { id: "b", review: { id: "b-1", link: "http://localhost:3000/" } },
      ],
      (sessionId) => (sessionId === "a" ? 42 : undefined),
      "/Users/t",
      AT,
    );
    expect(built.sessions).toEqual([{ sessionId: "a", cwd: "/p/a", workDirs: ["/p/a/app"], pid: 42 }, { sessionId: "b" }]);
    expect(built.deliverables).toEqual([
      { sessionId: "a", reviewId: "a-1", link: "/p/a/1.md" },
      { sessionId: "a", reviewId: "a-2", link: "/p/a/2.md", artifact: "spec" },
      { sessionId: "b", reviewId: "b-1", link: "http://localhost:3000/" },
    ]);
    expect(built).toMatchObject({ now: AT, home: "/Users/t" });
  });
});

describe("the service", () => {
  test("observe resolves, keeps the published form, logs the full one, and tells the daemon", () => {
    const told: unknown[] = [];
    const recorded: ScreenLogEntry[] = [];
    const log = { record: (entry: ScreenLogEntry) => void recorded.push(entry), flush: () => {} } as unknown as ScreenLog;
    const screen = createScreenContext({
      context: () => context({ sessions: [{ sessionId: "a", cwd: "/p/a", workDirs: ["/p/a/app"] }] }),
      onShowing: (showing) => void told.push(showing),
      log,
    });
    expect(screen.showing()).toBeUndefined();
    screen.observe(observation({
      surface: { kind: "url", url: "http://localhost:5173/" },
      app: { bundleId: "com.google.Chrome" },
      staged: { sessionId: "a", reviewId: "r", link: "http://localhost:5173/" },
    }));
    expect(screen.showing()).toMatchObject({ sessionId: "a", reviewId: "r", surface: { kind: "url", url: "http://localhost:5173/" } });
    expect(told).toEqual([screen.showing()]);
    expect(recorded).toEqual([{
      sessionId: "a", artifact: "http://localhost:5173/", reviewId: "r", surfaceKind: "url",
      app: "com.google.Chrome", projectCwd: "/p/a/app", confidence: 1,
    }]);
  });

  test("a localhost page waits for who serves it, and whatever was observed meanwhile wins", async () => {
    const told: Array<string | undefined> = [];
    let answer: (listeners: PortListener[]) => void = () => {};
    const asked: number[] = [];
    const screen = createScreenContext({
      context: () => context({ sessions: [{ sessionId: "a", pid: 100 }] }),
      listeners: (port) => { asked.push(port); return new Promise((resolve) => { answer = resolve; }); },
      onShowing: (showing) => void told.push(showing.sessionId),
    });
    const page = observation({ source: "front-window", surface: { kind: "url", url: "http://localhost:5173/" } });
    const waiting = screen.observe(page);
    expect(asked).toEqual([5173]);
    expect(screen.showing()).toBeUndefined();
    answer([{ pid: 900, parents: [100] }]);
    expect(await waiting).toMatchObject({ sessionId: "a", reason: "localhost-port: the session that started the server on :5173" });
    expect(screen.showing()?.sessionId).toBe("a");

    // Tyler moves on to conch's window before the lookup answers: the late answer is not what is showing.
    const late = screen.observe(page);
    void screen.observe(observation({ surface: { kind: "conch", sessionId: "c", view: "main" } }));
    answer([{ pid: 900, parents: [100] }]);
    await late;
    expect(screen.showing()?.sessionId).toBe("c");
    expect(told).toEqual(["a", "c"]);

    // A staged page already says whose it is: no lookup.
    await screen.observe({ ...page, source: "conch-staged", staged: { sessionId: "a" } });
    expect(asked).toEqual([5173, 5173]);
  });

  test("an observer that runs in the daemon is started with the sink and stopped on close", () => {
    let stopped = false;
    const screen = createScreenContext({
      context: () => context(),
      observers: [{
        id: "vision",
        start(emit) {
          emit(observation({ surface: { kind: "conch", sessionId: "s", view: "panel" } }));
          return () => { stopped = true; };
        },
      }],
    });
    expect(screen.showing()?.sessionId).toBe("s");
    screen.close(AT);
    expect(stopped).toBe(true);
  });
});

describe("conch_on_screen", () => {
  const config = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock", sessionsPath: "/virtual/sessions.json" };
  const handlers = (published: unknown) => createMcpToolHandlers(config, {
    ...defaultMcpDependencies,
    readSessionsFile: async () => (published === null ? null : JSON.stringify(published)),
    // Caller-agnostic: nothing may ask who is calling.
    parentPid: () => { throw new Error("conch_on_screen must not bind the caller"); },
    registrySnapshot: async () => { throw new Error("conch_on_screen must not read the registry"); },
  });

  test("returns the published showing with its session's label", async () => {
    const showing = { sessionId: "s1", confidence: 1, reason: "staged: conch put it on screen", surface: { kind: "terminal" }, source: "conch-staged", at: AT };
    const answer = await handlers({ rows: [{ id: "s1", label: "api work" }], showing }).conch_on_screen({});
    expect(answer).toEqual({ showing, label: "api work" });
  });

  test("says so when nothing has been seen, or no daemon has published", async () => {
    for (const published of [null, { rows: [] }]) {
      expect(await handlers(published).conch_on_screen({})).toMatchObject({ showing: null, reason: expect.stringContaining("seen nothing") });
    }
  });

  test("takes no arguments", async () => {
    await expect(handlers(null).conch_on_screen({ session: "x" })).rejects.toThrow('unknown argument "session"');
  });
});

describe("the screen-log setting", () => {
  test("is on by default, local only, and not an agent's to change", () => {
    expect(SETTING_REGISTRY.get("screen-log")).toMatchObject({ field: "screenLog", env: "CONCH_SCREEN_LOG", default: true, apply: "live" });
    expect(SETTING_REGISTRY.get("screen-log")!.help).toContain("never sent anywhere");
    expect(AGENT_TUNABLE_SETTINGS as readonly string[]).not.toContain("screen-log");
    expect(loadConfig({ env: {}, settingsPath: join(scratch(), "none.json") }).screenLog).toBe(true);
    expect(loadConfig({ env: { CONCH_SCREEN_LOG: "0" }, settingsPath: join(scratch(), "none.json") }).screenLog).toBe(false);
  });
});

describe("the local log", () => {
  const entry = (sessionId: string, extra: Partial<ScreenLogEntry> = {}): ScreenLogEntry =>
    ({ sessionId, surfaceKind: "file", confidence: 1, ...extra });
  const lines = (dir: string) => readdirSync(dir).sort().flatMap((name) =>
    readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));

  test("a state is written when it ends, once, with when it began and ended", () => {
    const dir = join(scratch(), "screen");
    const log = new ScreenLog({ dir, enabled: () => true });
    log.record(entry("a", { artifact: "/p/a.md", reviewId: "r", app: "com.apple.Preview", projectCwd: "/p" }), AT);
    log.record(entry("a", { artifact: "/p/a.md", reviewId: "r", app: "com.apple.Preview", projectCwd: "/p" }), AT + 5_000); // identical: one state
    log.record(entry("b"), AT + 10_000);
    log.record(entry("c"), AT + 20_000);
    expect(lines(dir)).toEqual([
      { v: 1, at: AT, until: AT + 10_000, sessionId: "a", artifact: "/p/a.md", reviewId: "r", surfaceKind: "file", app: "com.apple.Preview", projectCwd: "/p", confidence: 1 },
    ]);
    log.flush(AT + 30_000);
    expect(lines(dir).map((line) => [line.sessionId, line.at, line.until])).toEqual([
      ["a", AT, AT + 10_000],
      ["b", AT + 10_000, AT + 20_000],
      ["c", AT + 20_000, AT + 30_000],
    ]);
  });

  test("a glance shorter than the dwell is dropped, and the state it interrupted stays one line", () => {
    const dir = join(scratch(), "screen");
    const log = new ScreenLog({ dir, enabled: () => true });
    log.record(entry("a"), AT);
    log.record(entry("b"), AT + 10_000);
    log.record(entry("a"), AT + 11_000); // b lasted 1s
    log.record(entry("c"), AT + 30_000);
    log.record(entry("d"), AT + 31_000); // c lasted 1s
    log.flush(AT + 40_000);
    expect(lines(dir).map((line) => [line.sessionId, line.at, line.until])).toEqual([
      ["a", AT, AT + 31_000],
      ["d", AT + 31_000, AT + 40_000],
    ]);
  });

  test("files are 0600, one per day", () => {
    const dir = join(scratch(), "screen");
    const log = new ScreenLog({ dir, enabled: () => true });
    const day = Date.UTC(2026, 8, 25, 23, 59, 50);
    log.record(entry("a"), day);
    log.record(entry("b"), day + 5_000);
    log.record(entry("c"), day + 20_000); // b ends after midnight
    log.flush(day + 30_000);
    expect(readdirSync(dir).sort()).toEqual(["2026-09-25.jsonl", "2026-09-26.jsonl"]);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("old days go, then the oldest until it fits, never the file being written", () => {
    const dir = join(scratch(), "screen");
    const now = Date.UTC(2026, 8, 25, 12);
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-07-01.jsonl"), "x\n"); // past 30 days
    writeFileSync(join(dir, "2026-09-20.jsonl"), "y".repeat(600));
    writeFileSync(join(dir, "2026-09-24.jsonl"), "z".repeat(300));
    writeFileSync(join(dir, "notes.txt"), "not a log file");
    const log = new ScreenLog({ dir, enabled: () => true, maxBytes: 1_000 });
    log.record(entry("a"), now);
    log.flush(now + 5_000);
    expect(readdirSync(dir).sort()).toEqual(["2026-09-24.jsonl", "2026-09-25.jsonl", "notes.txt"]);
    // A cap smaller than today's own file keeps today's file.
    const tight = new ScreenLog({ dir, enabled: () => true, maxBytes: 1 });
    tight.record(entry("b"), now + 10_000);
    tight.flush(now + 15_000);
    expect(readdirSync(dir).sort()).toEqual(["2026-09-25.jsonl", "notes.txt"]);
  });

  test("off writes nothing, and forgets what it was holding", () => {
    const dir = join(scratch(), "screen");
    let on = false;
    const log = new ScreenLog({ dir, enabled: () => on });
    log.record(entry("a"), AT);
    log.record(entry("b"), AT + 10_000);
    log.flush(AT + 20_000);
    expect(existsSync(dir)).toBe(false);
    // Switched on mid-state and off again before anything ended: still nothing.
    on = true;
    log.record(entry("c"), AT + 30_000);
    on = false;
    log.record(entry("d"), AT + 40_000);
    on = true;
    log.flush(AT + 50_000);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the socket", () => {
  async function exchange(socketPath: string, value: unknown): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath });
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => resolve(JSON.parse(data)));
      socket.on("error", reject);
      socket.write(`${JSON.stringify(value)}\n`);
    });
  }

  test("a valid observation reaches the screen context before any session is resolved; a bad one never does", async () => {
    const root = mkdtempSync("/tmp/conch-screen-");
    roots.push(root);
    const seen: ScreenObservation[] = [];
    const resolved: unknown[] = [];
    const application = {} as ControlApplication;
    const server = createControlServer({
      socketPath: join(root, "s.sock"),
      ownerDeviceId: "mac",
      log: () => {},
      sessions: { resolve: (value) => { resolved.push(value); return value; }, current: () => ({ published: false }) },
      application,
      onScreenObservation: (observed) => void seen.push(observed),
    });
    expect(await server.start()).toBe(true);
    try {
      const good = observation({ surface: { kind: "terminal" }, staged: { sessionId: "s1" } });
      expect(await exchange(join(root, "s.sock"), { kind: "screen-observation", observation: good })).toEqual({ kind: "screen-ack" });
      expect(seen).toEqual([good]);
      expect(await exchange(join(root, "s.sock"), { kind: "screen-observation", observation: { ...good, source: "spoofed" } }))
        .toEqual({ kind: "screen-error", error: 'unknown observer "spoofed"' });
      expect(seen).toHaveLength(1);
      expect(resolved).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("the Mac app's conch-staged observer (source guards)", () => {
  const root = join(import.meta.dir, "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const item = read("mac-app/conch-mac/StatusItem.swift");
  const store = read("mac-app/conch-mac/StateStore.swift");
  const client = read("mac-app/conch-mac/ConchSocketClient.swift");
  const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    return text.slice(from, text.indexOf(end, from + start.length));
  };

  test("ConchStatusItem.stage reports every scene it hands off, with the session and the review", () => {
    const stage = between(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {", "private static func bringConchForward()");
    expect(stage).toContain("let staged = ConchScreenStaged(sessionId: row.id, reviewId: review?.id, link: review?.link)");
    // The link: reported from the open's own completion, with the app that took it, before the handoff counts.
    expect(stage).toMatch(/onOpened: \{ app in\s*store\.reportShowing\(ConchScreenSurface\(opened: url\), app: app, staged: staged\)\s*done\.resume\(returning: true\)/);
    // The terminal, once the daemon's ack said there was one to raise.
    expect(stage).toMatch(/if await store\.reveal\(row\)\.value \{[\s\S]*store\.reportShowing\(\.terminal, app: ConchScreenApp\(bundleId: "com\.apple\.Terminal"\), staged: staged\)\s*return true/);
    // conch's own window.
    expect(stage).toContain('openSession(row.id)\n                store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: staged)');
    // A failed open reports nothing: it falls through to the next scene.
    expect(between(stage, "}) { _ in", "}")).not.toContain("reportShowing");
  });

  test("StateStore sends it: the app NSWorkspace.open names, and a fire-and-forget report", () => {
    const door = between(store, "func openLink(", "private var errorStateSnapshot");
    expect(door).toContain("onOpened: @escaping @MainActor (ConchScreenApp?) -> Void = { _ in },");
    expect(door).toContain("NSWorkspace.shared.open(url, configuration: configuration) { app, error in");
    expect(door).toContain("app.bundleIdentifier.map { ConchScreenApp(bundleId: $0, pid: app.processIdentifier, name: app.localizedName) }");
    expect(door).toContain("guard let error else { Task { @MainActor in onOpened(opener) }; return }");
    const report = between(store, "func reportShowing(", "private func reportFrontWindow(");
    // Staged is always said, and opens the grace for the app it went to; conch's window showing a
    // session counts only while conch is in front, and never when it repeats.
    expect(report).toContain("if staged != nil {\n            screenGate.staged(surface, in: app?.bundleId, at: Date())");
    expect(report).toContain("} else if !NSApp.isActive || !screenGate.noticed(surface, in: nil, at: Date()) {\n            return");
    expect(report).toContain("let report = ConchScreenObservationReport(source: .conchStaged, surface: surface, app: app, staged: staged)");
    expect(report).toContain("sendScreenReport(report, of: surface)");
    // conch's own window following a pick, and coming back to the front, are the other reports.
    const content = read("mac-app/conch-mac/ContentView.swift");
    expect(content).toContain('FloatingPanels.picked(id)\n            // conch\'s own window now shows this session: the screen context\'s conch-staged observer.\n            store.reportShowing(.conch(sessionId: id, view: "main"))');
    expect(between(content, "publisher(for: NSApplication.didBecomeActiveNotification)", ".onChange(of: rowIDs)"))
      .toContain('guard let id = workspace.viewing else { return }\n            store.reportShowing(.conch(sessionId: id, view: "main"))');
  });

  test("the wire matches the daemon's contract", () => {
    const report = between(client, "struct ConchScreenObservationReport", "enum ConchSessionCommand");
    expect(report).toContain('let kind = "screen-observation"');
    expect(report).toContain("let v = 1");
    // The app's observers are exactly the daemon's registry.
    const sources = [...report.matchAll(/case \w+ = "([^"]+)"/g)].map((match) => match[1]);
    expect(sources).toEqual(SCREEN_OBSERVERS.map((observer) => observer.id));
    // No window title travels: the observation has no field for one.
    expect(between(report, "struct Observation", "init(")).not.toMatch(/window|title/i);
    // Every kind the app encodes is one the daemon accepts, with the fields it requires.
    const encoded = [...between(client, "enum ConchScreenSurface", "struct ConchScreenStaged").matchAll(/try container\.encode\("([a-z]+)", forKey: \.kind\)/g)]
      .map((match) => match[1]);
    expect(encoded).toEqual(["file", "url", "terminal", "simulator", "design", "app", "conch"]);
    for (const surface of [
      { kind: "file", path: "/p/x" }, { kind: "url", url: "https://x.dev/" }, { kind: "terminal" }, { kind: "simulator" }, { kind: "design" },
      { kind: "app", bundleId: "com.apple.Preview" }, { kind: "conch", sessionId: "s", view: "main" },
    ]) expect(validateScreenObservation(observation({ surface: surface as ScreenObservation["surface"] })).ok).toBe(true);
  });
});

describe("the Mac app's front-window observer (source guards)", () => {
  const root = join(import.meta.dir, "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const observer = read("mac-app/conch-mac/FrontWindowObserver.swift");
  const store = read("mac-app/conch-mac/StateStore.swift");
  /** The Swift with its comments taken out, so a rule is about code, not about prose naming it. */
  const code = observer.replace(/\/\/.*$/gm, "");

  test("Accessibility is checked, never asked for: no prompt from this app, onboarding's job", () => {
    expect(code).toContain("AXIsProcessTrusted()");
    // Every read of another app sits behind the check.
    expect(code).toContain("guard trusted else { return app }");
    for (const file of ["FrontWindowObserver.swift", "StateStore.swift", "StatusItem.swift", "ContentView.swift", "ConchMacApp.swift"]) {
      const swift = read(`mac-app/conch-mac/${file}`);
      expect(swift).not.toContain("AXIsProcessTrustedWithOptions");
      expect(swift).not.toContain("kAXTrustedCheckOptionPrompt");
    }
  });

  test("no AppleScript, so no Automation prompt", () => {
    for (const forbidden of ["NSAppleScript", "OSAScript", "osascript", "NSAppleEventDescriptor", "AEDeterminePermissionToAutomateTarget", "tell application"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  test("a window title is never read, so it can never be sent", () => {
    expect(code).not.toMatch(/kAXTitleAttribute|"AXTitle"|\.title\b/);
  });

  test("driven by app activation and a slow poll, never a tight loop", () => {
    expect(code).toContain("NSWorkspace.didActivateApplicationNotification");
    const interval = Number(/Timer\(timeInterval: ([\d.]+), repeats: true\)/.exec(code)?.[1]);
    expect(interval).toBeGreaterThanOrEqual(2);
    // The poll reads only with the grant: without it, activations already say everything.
    expect(code).toContain("if AXIsProcessTrusted() { self?.read(after: .zero) }");
    expect(code).not.toMatch(/while\s+(true|!Task\.isCancelled)/);
    // One reading at a time: a newer request replaces one still waiting.
    expect(code).toContain("reading?.cancel()");
    // Accessibility waits on another app: off the main thread, on a short leash, the walk bounded.
    expect(code).toContain("await Task.detached {");
    expect(code).toContain("AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)");
    expect(code).toContain("queue += children(element).prefix(budget - queue.count)");
    // Never into a page: the address isn't in there, and walking one makes a browser switch its
    // own accessibility on, which Tyler would feel in every tab.
    expect(code).toContain('if role == "AXWebArea" || leaves.contains(role) { continue }');
  });

  test("conch's own windows are left to reportShowing, and the gate stands between it and the daemon", () => {
    expect(code).toContain("front.processIdentifier != ProcessInfo.processInfo.processIdentifier");
    const front = store.slice(store.indexOf("private func reportFrontWindow("), store.indexOf("func removeDeliverable("));
    expect(front).toContain("guard screenGate.noticed(surface, in: app.bundleId, at: Date()) else { return }");
    expect(front).toContain("ConchScreenObservationReport(source: .frontWindow, surface: surface, app: app, staged: nil)");
    expect(store).toContain("frontWindow = FrontWindowObserver { [weak self] surface, app in");
  });

  test("while the panel fills the screen the app behind it is not said, and it is read again the moment it stops", () => {
    // The gate holds every reading while covered (`ScreenReportGate.covered`, ScreenObservingTests); the store sets it
    // from the panel, and uncovered reads the app in front at once rather than on the next poll.
    const covered = store.slice(store.indexOf("func screenCovered(_ covered: Bool) {"), store.indexOf("/// Take an artifact"));
    expect(covered).toContain("guard covered != screenGate.covered else { return }\n        screenGate.covered = covered\n        if !covered { frontWindow?.readNow() }");
    expect(code).toContain("func readNow() {\n        read(after: .zero)\n    }");
    const panels = read("mac-app/conch-mac/FloatingPanels.swift");
    expect(panels).toContain("store?.screenCovered(isFullScreen && fog.isVisible)");
    // Both ways it can stop covering: docking back (or collapsing, which docks first) and being hidden from the menu.
    const toggle = panels.slice(panels.indexOf("func toggleFullScreen() {"), panels.indexOf("func showInPanel() {"));
    expect(toggle).toMatch(/blur\.maskImage = nil\n        \}\n        coverChanged\(\)\n    \}/);
    const shown = panels.slice(panels.indexOf("private func showWhatIsOn() {"), panels.indexOf("private func coverChanged() {"));
    expect(shown).toContain("show(fog, defaults.bool(forKey: ConchStatusItem.showConversationKey))\n        coverChanged()");
    expect(panels).toContain("self.store = store");
  });

  test("a report counts as said only once the daemon acks it, and a daemon that has seen nothing is told again", () => {
    const send = store.slice(store.indexOf("private func sendScreenReport("), store.indexOf("func screenCovered("));
    expect(send).toContain('["kind"] as? String == "screen-ack" {\n                return\n            }\n            self?.screenGate.unsaid(surface)');
    expect(store.match(/sendScreenReport\(report, of: surface\)/g)?.length).toBe(2);
    // A restarted daemon publishes no `showing` until it hears something.
    expect(store).toContain("sourceState = snapshot\n        // A daemon that has seen nothing on screen is a new one (a restart): what the last one was told is news again.\n        if snapshot.showing == nil { screenGate.forget() }");
  });
});

describe("the daemon's wiring (source guard)", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
  test("observations reach the service, `showing` is published, the log lives in the config dir and closes at shutdown", () => {
    expect(daemon).toContain("onScreenObservation: (observation) => void screen.observe(observation).catch((error) => log(`screen: ${error}`)),");
    // Who serves a localhost page, through the bounded, cached lookup.
    // One lookup, shared with the phone's dev pages (`/dev`), so one cache.
    expect(daemon).toContain("const portListeners = portListenerLookup();");
    expect(daemon).toContain("listeners: portListeners,");
    expect(daemon).toContain('dir: join(dirname(daemonSettingsPath), "screen"),');
    expect(daemon).toContain("enabled: () => cfg.screenLog,");
    expect(daemon).toContain("        screen.showing(),\n");
    expect(daemon).toContain("lastPublishedPanelState = { ...lastPublishedPanelState, ts: Date.now(), showing };");
    expect(daemon.indexOf("screen.close();")).toBeGreaterThan(daemon.indexOf("const shutdown = async"));
  });
});
