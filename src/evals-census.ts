/**
 * The census `conch evals` loads into the test daemon it starts (`bun --preload`): it counts every file-system call and
 * every process the daemon starts, by what it touched, and writes the counts, its CPU and its memory to a file twice a
 * second, so the harness can say what a poll costs ("a registry read, 3 stats a session, a `ps`, the published state
 * rewritten") rather than only that the daemon is busy. 2026-11-11, Tyler: "performance benchmarks evals on conch for
 * token efficiency, computer efficiency, etc."
 *
 * A preload, never imported by the daemon itself: the live daemon never runs it. Only conch's own `src/` modules are
 * rewritten to import counted copies of `node:fs` and `node:fs/promises`; `Bun.spawn`, `Bun.spawnSync`, `Bun.file` and
 * `Bun.write` are wrapped in place. Each thread (the records worker is one) writes its own file, `<out>.<thread>`.
 *
 * Env: CONCH_EVALS_CENSUS (the file to write), CONCH_EVALS_CENSUS_PATHS (JSON `[[prefix, label], …]`, longest first:
 * how a path is counted), CONCH_EVALS_SRC (the `src/` folder whose modules are rewritten).
 */
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { basename } from "node:path";
import { plugin } from "bun";

const out = process.env.CONCH_EVALS_CENSUS;
const src = process.env.CONCH_EVALS_SRC;

if (out && src) install(out, src);

interface Census {
  /** `<call> <label>` → calls. */
  calls: Record<string, number>;
  /**
   * `commit <database>` → SQLite commits, and `fsync <database>` → those that waited on an fsync of the log (WAL with
   * `synchronous` FULL or EXTRA; a NORMAL commit leaves that to a checkpoint). Counted where conch's own code commits:
   * an outermost `transaction()`, or a write statement run outside one.
   */
  sqlite: Record<string, number>;
  /** `<function> (<conch file>)` → file calls made there: where the reads and stats come from. */
  sites: Record<string, number>;
  /** `<label>` → bytes written there. */
  written: Record<string, number>;
  /** `<program> <subcommand> ← <function> (<conch file>)` → how often it was started. */
  spawned: Record<string, number>;
}

function install(outPath: string, srcDir: string): void {
  // Each thread its own files: a worker runs this preload too, once the main thread is already using its shims.
  let thread = "main";
  try {
    const { isMainThread, threadId } = require("node:worker_threads") as typeof import("node:worker_threads");
    if (!isMainThread) thread = `t${threadId}`;
  } catch {}
  const census: Census = { calls: {}, sites: {}, written: {}, spawned: {}, sqlite: {} };
  (globalThis as { __conchEvalsCensus?: Census }).__conchEvalsCensus = census;
  let given: Array<[string, string]> = [];
  try { given = JSON.parse(process.env.CONCH_EVALS_CENSUS_PATHS ?? "[]"); } catch {}
  // Each prefix as given and as macOS resolves it (/tmp is /private/tmp), longest first.
  const real = (path: string) => { try { return realFs.realpathSync(path); } catch { return path; } };
  const ownSources = [srcDir, real(srcDir)].map((dir) => (dir.endsWith("/") ? dir : `${dir}/`));
  const prefixes = given.flatMap(([prefix, name]): Array<[string, string]> => [[prefix, name], [real(prefix), name]])
    .sort(([a], [b]) => b.length - a.length);

  // What each open descriptor was opened on, so a readSync or closeSync counts against the file, not "fd".
  const descriptors = new Map<number, string>();
  const label = (target: unknown): string => {
    if (typeof target === "number") return descriptors.get(target) ?? "fd";
    const path = typeof target === "string" ? target : target instanceof URL ? target.pathname : "";
    if (!path) return "other";
    for (const [prefix, name] of prefixes) if (path.startsWith(prefix)) return name;
    if (path.startsWith("/dev/")) return "dev";
    if (/^\/(?:Applications|System|Library|usr|opt|bin|sbin|private\/var\/db)\//.test(path)) return "system";
    return "other";
  };
  // The innermost conch frame of the call: `<function> (<file>)`. About a microsecond a call, measured 2026-11-11.
  // A process is often started through a wrapper (runaway.ts's guardedSpawn), so a spawn names two frames.
  const site = (frames = 1): string => {
    const stack = new Error().stack?.split("\n") ?? [];
    const found: string[] = [];
    for (const line of stack) {
      const match = /at (?:(\S+) \()?([^()\s]+):\d+:\d+\)?$/.exec(line.trim());
      if (!match || match[2]!.endsWith("/evals-census.ts") || !ownSources.some((dir) => match[2]!.startsWith(dir))) continue;
      found.push(`${match[1] ?? "(top)"} (${basename(match[2]!)})`);
      if (found.length === frames) break;
    }
    return found.length ? found.join(" ← ") : "(elsewhere)";
  };
  const count = (call: string, target: unknown) => {
    const key = `${call} ${label(target)}`;
    census.calls[key] = (census.calls[key] ?? 0) + 1;
    const where = site();
    census.sites[where] = (census.sites[where] ?? 0) + 1;
  };
  const opened = (fd: unknown, target: unknown) => {
    if (typeof fd === "number") descriptors.set(fd, label(target));
  };
  const closed = (fd: unknown) => {
    if (typeof fd === "number") descriptors.delete(fd);
  };
  const wrote = (target: unknown, data: unknown) => {
    const size = typeof data === "string" ? Buffer.byteLength(data) : data instanceof Uint8Array ? data.byteLength : 0;
    if (size) census.written[label(target)] = (census.written[label(target)] ?? 0) + size;
  };

  // The counted copies of node:fs and node:fs/promises, written once beside the census file: an ES module's exports
  // are named in its source, so the list is this Bun's own.
  const shim = (module: Record<string, unknown>, real: string, file: string): string => {
    const names = Object.keys(module).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default");
    const lines = [
      `import * as real from ${JSON.stringify(real)};`,
      `const census = globalThis.__conchEvalsCensus;`,
      `const wrap = (name, fn) => typeof fn !== "function" || /^[A-Z]/.test(name) ? fn : function (...args) {`,
      `  census.__count(name, args[0]);`,
      `  if (/^(write|append)File|^write(Sync)?$/.test(name)) census.__wrote(args[0], args[1]);`,
      `  const result = fn.apply(this, args);`,
      `  if (name === "openSync") census.__opened(result, args[0]);`,
      `  else if (name === "closeSync") census.__closed(args[0]);`,
      `  return result;`,
      `};`,
      ...names.map((name) => `export const ${name} = wrap(${JSON.stringify(name)}, real.${name});`),
      `export default { ${names.join(", ")} };`,
    ];
    const path = `${outPath}.${thread}.${file}.mjs`;
    realFs.writeFileSync(path, lines.join("\n"));
    return path;
  };
  const committed = (database: string, synchronous: number) => {
    const name = basename(database || "memory");
    census.sqlite[`commit ${name}`] = (census.sqlite[`commit ${name}`] ?? 0) + 1;
    if (synchronous >= 2) census.sqlite[`fsync ${name}`] = (census.sqlite[`fsync ${name}`] ?? 0) + 1;
  };
  Object.assign(census, { __count: count, __wrote: wrote, __opened: opened, __closed: closed, __committed: committed });
  const fsShim = shim(realFs as unknown as Record<string, unknown>, "node:fs", "fs");
  const fsPromisesShim = shim(realFsPromises as unknown as Record<string, unknown>, "node:fs/promises", "fs-promises");
  // A records worker is a thread of its own, which `--preload` doesn't reach: conch's Workers are started with this
  // census as their preload.
  const workersShim = `${outPath}.${thread}.worker-threads.mjs`;
  realFs.writeFileSync(workersShim, [
    `import * as real from "node:worker_threads";`,
    `export * from "node:worker_threads";`,
    `export class Worker extends real.Worker {`,
    `  constructor(url, options = {}) { super(url, { ...options, preload: [...(options.preload ?? []), ${JSON.stringify(import.meta.path)}] }); }`,
    `}`,
    `export default { ...real, Worker };`,
  ].join("\n"));
  // SQLite, counted at its commits. The connection's `synchronous` is followed through the pragmas conch sets
  // (SQLite's default, FULL, until one does).
  const sqliteShim = `${outPath}.${thread}.sqlite.mjs`;
  realFs.writeFileSync(sqliteShim, [
    `import * as real from "bun:sqlite";`,
    `export * from "bun:sqlite";`,
    `const census = globalThis.__conchEvalsCensus;`,
    `const WRITE = /^\\s*(INSERT|UPDATE|DELETE|REPLACE)\\b/i;`,
    `export class Database extends real.Database {`,
    `  constructor(file, ...rest) { super(file, ...rest); this.__file = typeof file === "string" ? file : ""; this.__sync = 2; }`,
    `  __note(sql) {`,
    `    const sync = /PRAGMA\\s+synchronous\\s*=\\s*(\\w+)/i.exec(sql);`,
    `    if (sync) { const value = sync[1].toUpperCase(); this.__sync = ({ OFF: 0, NORMAL: 1, FULL: 2, EXTRA: 3 })[value] ?? Number(value); }`,
    `    else if (WRITE.test(sql) && !this.inTransaction) census.__committed(this.__file, this.__sync);`,
    `  }`,
    `  exec(sql, ...rest) { this.__note(String(sql)); return super.exec(sql, ...rest); }`,
    `  run(sql, ...rest) { this.__note(String(sql)); return super.run(sql, ...rest); }`,
    `  __statement(statement, sql) {`,
    `    if (!WRITE.test(sql)) return statement;`,
    `    const db = this;`,
    `    return new Proxy(statement, { get(target, key) {`,
    `      const value = Reflect.get(target, key, target);`,
    `      if (typeof value !== "function") return value;`,
    `      if (key !== "run" && key !== "get" && key !== "all" && key !== "values") return value.bind(target);`,
    `      return (...args) => { const outer = !db.inTransaction; const result = value.apply(target, args); if (outer) census.__committed(db.__file, db.__sync); return result; };`,
    `    } });`,
    `  }`,
    `  query(sql) { return this.__statement(super.query(sql), String(sql)); }`,
    `  prepare(sql, ...rest) { return this.__statement(super.prepare(sql, ...rest), String(sql)); }`,
    `  transaction(fn) {`,
    `    const tx = super.transaction(fn);`,
    `    const db = this;`,
    `    const counted = (run) => function (...args) { const outer = !db.inTransaction; const result = run.apply(this, args); if (outer) census.__committed(db.__file, db.__sync); return result; };`,
    `    const wrapped = counted(tx);`,
    `    for (const mode of ["deferred", "immediate", "exclusive"]) if (typeof tx[mode] === "function") wrapped[mode] = counted(tx[mode]);`,
    `    return wrapped;`,
    `  }`,
    `}`,
    `export default Database;`,
  ].join("\n"));

  plugin({
    name: "conch-evals-census",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, ({ path }) => {
        const text = realFs.readFileSync(path, "utf8");
        if (!ownSources.some((dir) => path.startsWith(dir))) return { contents: text, loader: "ts" };
        return {
          contents: text
            .replace(/(from\s+|import\(\s*)(["'])(?:node:)?fs\/promises\2/g, `$1${JSON.stringify(fsPromisesShim)}`)
            .replace(/(from\s+|import\(\s*)(["'])(?:node:)?fs\2/g, `$1${JSON.stringify(fsShim)}`)
            .replace(/(from\s+|import\(\s*)(["'])(?:node:)?worker_threads\2/g, `$1${JSON.stringify(workersShim)}`)
            .replace(/(from\s+|import\(\s*)(["'])bun:sqlite\2/g, `$1${JSON.stringify(sqliteShim)}`),
          loader: "ts",
        };
      });
    },
  });

  const bun = Bun as unknown as Record<string, unknown>;
  const started = (cmd: unknown) => {
    const argv = Array.isArray(cmd) ? cmd : cmd && typeof cmd === "object" && Array.isArray((cmd as { cmd?: unknown }).cmd) ? (cmd as { cmd: unknown[] }).cmd : [];
    const words = argv.map(String);
    // tmux's own socket flags first (`-L conch`), then what it was asked to do; anything else, its first argument.
    let at = 1;
    if (basename(words[0] ?? "") === "tmux") while (/^-[LSf]$/.test(words[at] ?? "")) at += 2;
    const name = `${basename(words[0] ?? "?")}${words[at] ? ` ${words[at]!.slice(0, 24)}` : ""} ← ${site(2)}`;
    census.spawned[name] = (census.spawned[name] ?? 0) + 1;
  };
  for (const name of ["spawn", "spawnSync"] as const) {
    const real = bun[name] as (...args: unknown[]) => unknown;
    try { bun[name] = function (this: unknown, ...args: unknown[]) { started(args[0]); return real.apply(Bun, args); }; } catch {}
  }
  const realFile = bun.file as (...args: unknown[]) => unknown;
  try { bun.file = function (...args: unknown[]) { count("Bun.file", args[0]); return realFile.apply(Bun, args); }; } catch {}
  const realWrite = bun.write as (...args: unknown[]) => unknown;
  try {
    bun.write = function (...args: unknown[]) {
      const target = args[0] && typeof args[0] === "object" && "name" in (args[0] as object) ? (args[0] as { name?: unknown }).name : args[0];
      count("Bun.write", target);
      wrote(target, args[1]);
      return realWrite.apply(Bun, args);
    };
  } catch {}

  // Each thread its own file; the real fs, so the census never counts itself.
  const file = `${outPath}.${thread}.json`;
  const dump = () => {
    try {
      const cpu = process.cpuUsage();
      realFs.writeFileSync(`${file}.tmp`, JSON.stringify({
        at: Date.now(), pid: process.pid, thread,
        cpuMicros: cpu.user + cpu.system, rss: process.memoryUsage().rss,
        calls: census.calls, sites: census.sites, written: census.written, spawned: census.spawned, sqlite: census.sqlite,
      }));
      realFs.renameSync(`${file}.tmp`, file);
    } catch {}
  };
  const timer = setInterval(dump, 500);
  (timer as { unref?: () => void }).unref?.();
  process.on("exit", dump);
}
