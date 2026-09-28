#!/usr/bin/env bun
/**
 * The tmux a built conch.app carries, run the way a downloaded one runs it:
 * the app copied to a temporary location, and tmux started with a bare PATH,
 * a temporary HOME and nothing from Homebrew. Checks that it is there, built
 * for the app's architectures, linked only against the system, signed, with
 * its notices; that conch resolves it from that app; and that it hosts a real
 * session — a login shell, TERM=screen-256color that the pane's own terminfo
 * knows, 256 colours stored and drawn, emoji two cells wide (utf8proc), jemalloc
 * and the static libevent in use — then stops its server.
 *
 *   bun scripts/tmux-bundle-e2e.ts <conch.app> [--keep]
 *   bun scripts/tmux-bundle-e2e.ts --binary <tmux> [--keep]    (a fetch-tmux.sh build)
 *
 * Never touches another tmux server: its own socket name (conch-bundle-test-*,
 * in tmux's usual /tmp/tmux-<uid>), no TMUX in the environment, and the server
 * it started is killed by that name and its socket file removed. --keep leaves
 * the temp dir for inspection.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveTmux } from "../src/tmux-binary.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const binaryArg = args.includes("--binary") ? resolve(args[args.indexOf("--binary") + 1] ?? "") : "";
const appArg = !binaryArg && args[0] && !args[0].startsWith("--") ? resolve(args[0]) : "";
if (!binaryArg && !appArg) {
  console.error("usage: bun scripts/tmux-bundle-e2e.ts <conch.app> [--keep] | --binary <tmux> [--keep]");
  process.exit(2);
}

const repo = join(import.meta.dir, "..");
const TMUX_VERSION = /^TMUX_VERSION=(.+)$/m.exec(readFileSync(join(repo, "scripts", "fetch-tmux.sh"), "utf8"))![1]!;
const NOTICES = ["NOTICE", "COPYING", "LICENSE.compat", "LICENSE.libevent", "COPYING.jemalloc", "LICENSE.utf8proc.md"];

const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const run = (argv: string[], options: { env?: Record<string, string>; cwd?: string } = {}) => {
  const result = Bun.spawnSync(argv, { env: options.env ?? { PATH: "/usr/bin:/bin" }, cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

const root = mkdtempSync(join(tmpdir(), "conch-tmux-e2e-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
// tmux's usual socket directory: a temp dir's path is too long for a Unix socket (104 bytes).
const socket = `conch-bundle-test-${process.pid}`;
const socketPath = join("/tmp", `tmux-${process.getuid?.() ?? 501}`, socket);

let tmux = binaryArg;
if (appArg) {
  const app = join(root, "conch.app");
  // ditto keeps the signatures and the bundle exactly as built.
  const copied = run(["/usr/bin/ditto", appArg, app]);
  check(copied.code === 0, `the app copied to a temp location: ${app}`);
  tmux = join(app, "Contents", "Helpers", "tmux");
  check(existsSync(tmux), `Contents/Helpers/tmux is there (${tmux})`);

  const appArchs = run(["/usr/bin/lipo", "-archs", join(app, "Contents", "MacOS", "conch-mac")]).out.trim().split(/\s+/).sort().join(" ");
  const tmuxArchs = run(["/usr/bin/lipo", "-archs", tmux]).out.trim().split(/\s+/).sort().join(" ");
  check(appArchs === tmuxArchs, `built for the app's architectures (${tmuxArchs}; the app is ${appArchs})`);

  const signature = run(["/usr/bin/codesign", "-dv", "--verbose=2", tmux]).err;
  const verified = run(["/usr/bin/codesign", "--verify", "--strict", tmux]).code === 0;
  const developerId = /^Authority=Developer ID Application/m.test(signature);
  const runtime = /^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime/m.test(signature);
  check(verified && (!developerId || runtime),
    developerId
      ? `signed with the Developer ID and the Hardened Runtime (${runtime ? "runtime" : "NO runtime"})`
      : `validly signed (${/Signature=adhoc/.test(signature) ? "ad hoc — an unsigned build, as the CI gate's" : "not Developer ID"})`);

  for (const notice of NOTICES) {
    const shipped = join(app, "Contents", "Resources", "ThirdParty", "tmux", notice);
    check(existsSync(shipped) && readFileSync(shipped, "utf8") === readFileSync(join(repo, "mac-app", "third-party", "tmux", notice), "utf8"), `ships ThirdParty/tmux/${notice}`);
  }

  const resolved = resolveTmux({ env: { CONCH_APP_BUNDLE: app, PATH: "/usr/bin:/bin" }, which: () => null });
  check(resolved.source === "conch.app" && resolved.path === tmux, `conch resolves the app's tmux from CONCH_APP_BUNDLE: ${resolved.source} ${resolved.path}`);
}

const links = run(["/usr/bin/otool", "-L", tmux]).out.split("\n").slice(1).map((line) => line.trim().split(" ")[0]!).filter(Boolean);
check(links.length > 0 && links.every((lib) => lib.startsWith("/usr/lib/") || lib.startsWith("/System/Library/Frameworks/")), `links only the system: ${links.join(", ")}`);
check(links.includes("/usr/lib/libncurses.5.4.dylib"), "reads terminfo through macOS's own ncurses");

// What a Finder-launched app has, minus Homebrew: nothing but the system. No TMUX.
const bare: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home };
const tmuxCmd = (...rest: string[]) => run([tmux, "-L", socket, ...rest], { env: bare, cwd: root });

say(`tmux ${tmux}`);
say(`socket ${socketPath}`);
try {
  const version = run([tmux, "-V"], { env: bare }).out.trim();
  check(version === `tmux ${TMUX_VERSION}`, `runs with a bare PATH: ${version}`);

  // -vv: the server logs the libraries it runs on, into the temp dir.
  const created = run([tmux, "-vv", "-L", socket, "new", "-d", "-s", "probe", "-x", "120", "-y", "30"], { env: bare, cwd: root });
  check(created.code === 0, `\`new -d\` started a server and a session (exit ${created.code}${created.err ? `: ${created.err.trim()}` : ""})`);
  const sessions = tmuxCmd("list-sessions", "-F", "#{session_name}");
  check(sessions.code === 0 && sessions.out.trim() === "probe", `\`list-sessions\` answers: ${sessions.out.trim() || sessions.err.trim()}`);

  const [serverPid, panePid] = tmuxCmd("display", "-p", "-t", "probe", "#{pid} #{pane_pid}").out.trim().split(" ");
  const shell = run(["/bin/ps", "-o", "args=", "-p", panePid ?? "0"]).out.trim();
  check(shell.startsWith("-"), `the pane runs a login shell: ${shell}`);
  const term = tmuxCmd("show", "-gv", "default-terminal").out.trim();
  check(term === "screen-256color", `panes get TERM=${term}`);

  const probe = [
    `echo "TERM=$TERM"`,
    `echo "colors=$(tput colors)"`,
    `infocmp "$TERM" >/dev/null 2>&1 && echo terminfo-ok`,
    `printf '\\033[38;5;196mRED\\033[48;5;21mBLUE\\033[0m\\n'`,
    `printf '\\360\\237\\220\\232x'`,
    "sleep 60",
  ].join("; ");
  check(tmuxCmd("new-window", "-d", "-t", "probe:1", "sh", "-c", probe).code === 0, "a 256-colour probe runs in a second window");
  const screen = await (async () => {
    for (let i = 0; i < 40; i++) {
      const text = tmuxCmd("capture-pane", "-p", "-t", "probe:1").out;
      if (text.includes("x")) return text;
      await Bun.sleep(100);
    }
    return tmuxCmd("capture-pane", "-p", "-t", "probe:1").out;
  })();
  check(screen.includes("TERM=screen-256color"), "inside the pane, TERM=screen-256color");
  check(screen.includes("colors=256"), "…and `tput colors` there says 256");
  check(screen.includes("terminfo-ok"), "…and the pane's own terminfo (the system's) has the entry");
  const coloured = tmuxCmd("capture-pane", "-p", "-e", "-t", "probe:1").out;
  check(coloured.includes("\x1b[38;5;196m") && coloured.includes("48;5;21"), "256-colour cells are stored as sent (38;5;196, 48;5;21)");
  const cursor = tmuxCmd("display", "-p", "-t", "probe:1", "#{cursor_x}").out.trim();
  check(cursor === "3", `an emoji is two cells wide (utf8proc): the cursor is at column ${cursor} after 🐚x`);

  // Draw it for a real terminal: a client in a pty, TERM=xterm-256color, UTF-8.
  const drawn = join(root, "client.out");
  const client = Bun.spawn(["/usr/bin/script", "-q", drawn, tmux, "-L", socket, "attach", "-t", "probe:1"], {
    env: { ...bare, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    cwd: root,
    // /dev/null, not a pipe: Bun's pipes are sockets, and script(1) needs tcgetattr on its stdin.
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let attached = false;
  for (let i = 0; i < 40 && !attached; i++) {
    await Bun.sleep(100);
    attached = tmuxCmd("list-clients", "-F", "#{client_name}").out.trim() !== "";
  }
  await Bun.sleep(500);
  tmuxCmd("detach-client", "-s", "probe");
  await Promise.race([client.exited, Bun.sleep(5_000)]);
  client.kill();
  const bytes = existsSync(drawn) ? readFileSync(drawn, "utf8") : "";
  check(attached, "a client attached through a pty with TERM=xterm-256color");
  check(bytes.includes("38;5;196") && bytes.includes("🐚"), `…and drew the 256-colour text and the emoji (${bytes.length} bytes)`);

  const log = readdirSync(root).find((name) => name.startsWith("tmux-server-") && name.endsWith(".log"));
  const serverLog = log ? readFileSync(join(root, log), "utf8") : "";
  check(/using libevent 2\.1\.13-stable select/.test(serverLog), `the server runs on the static libevent: ${/using libevent .*/.exec(serverLog)?.[0] ?? "no log"}`);
  check(/using utf8proc 2\.11\.3/.test(serverLog), `…utf8proc: ${/using utf8proc .*/.exec(serverLog)?.[0] ?? "no log"}`);
  check(/using jemalloc 5\.3\.1/.test(serverLog), `…jemalloc: ${/using jemalloc .*/.exec(serverLog)?.[0] ?? "no log"}`);
  say(`server pid ${serverPid}`);
} finally {
  const killed = tmuxCmd("kill-server");
  check(killed.code === 0, "`kill-server` stopped it, by its own socket name");
  check(tmuxCmd("has-session").code !== 0, "…and nothing answers on that socket now");
  rmSync(socketPath, { force: true });
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
