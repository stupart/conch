import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCapabilities } from "../src/account-tools.ts";
import { applyRuntimeControlMessage, createControlServer, type ControlServer } from "../src/control-server.ts";
import { readBrowserSignIns } from "../src/browser-profiles.ts";
import {
  agentLogin,
  awsSkip,
  browserProfileLogin,
  capabilityLogins,
  CLI_PROBES,
  createLoginInventory,
  fitLoginInventoryReply,
  formatLoginTable,
  identity,
  isLoginInventoryReply,
  loginProjects,
  loginSources,
  mapLimit,
  parseAwsCallerIdentity,
  parseFlyWhoami,
  parseGcloudAuthList,
  parseGhAuthJson,
  parseGhAuthText,
  parseNetlifyStatus,
  parseNpmWhoami,
  parseRailwayWhoami,
  parseStripeConfig,
  parseVercelWhoami,
  parseWranglerWhoami,
  probeCli,
  probeEnvironment,
  readNeedsAuth,
  runProbe,
  type CliProbe,
  type LoginInventoryReply,
  type LoginRecord,
  type LoginSource,
  type ProbeContext,
  type ProbeOutput,
} from "../src/login-inventory.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import { sendControlMessage, validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";

// Every account and token here is invented (alex@example.com, a fixture key): the repo is public, and no CLI on this Mac
// is ever run by these tests. Fake tokens are short on purpose, so no secret scanner takes them for real ones.

const out = (fields: Partial<ProbeOutput> = {}): ProbeOutput => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...fields });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (prefix = "conch-logins-") => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

describe("each CLI's answer, parsed for the account alone", () => {
  test("gh: every account on every host, which is active, and a token that no longer works", () => {
    const json = JSON.stringify({ hosts: {
      "github.com": [
        { state: "success", active: true, host: "github.com", login: "alex", tokenSource: "keyring", scopes: "repo", gitProtocol: "https", token: "gho_xxxxxxxxxxxx" },
        { state: "error", active: false, host: "github.com", login: "alex-work", tokenSource: "keyring", error: "The token in keyring is invalid." },
      ],
      "ghe.acme.dev": [{ state: "timeout", active: true, host: "ghe.acme.dev", login: "alex" }],
    } });
    const found = parseGhAuthJson(out({ stdout: json }))!;
    expect(found).toEqual([
      { state: "signed-in", account: "alex", scope: "github.com", detail: "active" },
      { state: "expired", account: "alex-work", scope: "github.com", detail: "not active · its token no longer works; run gh auth login" },
      { state: "unknown", account: "alex", scope: "ghe.acme.dev", detail: "active · GitHub didn't answer" },
    ]);
    expect(JSON.stringify(found)).not.toContain("gho_");
    expect(parseGhAuthJson(out({ stdout: '{"hosts":{}}' }))).toEqual([{ state: "signed-out" }]);
    // A gh from before `--json` says so; the text attempt follows.
    expect(parseGhAuthJson(out({ code: 1, stderr: "unknown flag: --json\n\nUsage: …" }))).toBeNull();
  });

  test("gh before --json: the ✓ and X lines, never the token line", () => {
    const text = [
      "github.com",
      "  ✓ Logged in to github.com account alex (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      "  - Token: gho_************************************",
      "  X Failed to log in to github.com account alex-work (keyring)",
    ].join("\n");
    const found = parseGhAuthText(out({ code: 1, stderr: text }))!;
    expect(found).toEqual([
      { state: "signed-in", account: "alex", scope: "github.com", detail: "active" },
      { state: "expired", account: "alex-work", scope: "github.com", detail: "its token no longer works; run gh auth login" },
    ]);
    expect(JSON.stringify(found)).not.toContain("gho_");
    expect(parseGhAuthText(out({ code: 1, stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }))).toEqual([{ state: "signed-out" }]);
  });

  test("vercel: JSON first, plain for an older CLI, and its failures in words", () => {
    const json = JSON.stringify({ username: "alex", email: "alex@example.com", name: "Alex", team: { id: "team_fixture", slug: "acme", name: "Acme" } });
    expect(parseVercelWhoami(out({ stdout: json, stderr: "Vercel CLI 59.0.0" }), 0)).toEqual([{ state: "signed-in", account: "alex@example.com", detail: "alex · team acme" }]);
    expect(parseVercelWhoami(out({ code: 1, stderr: "Error: unknown or unexpected option: --format" }), 0)).toBeNull();
    expect(parseVercelWhoami(out({ stdout: "alex\n", stderr: "Vercel CLI 30.0.0" }), 1)).toEqual([{ state: "signed-in", account: "alex" }]);
    expect(parseVercelWhoami(out({ code: 1, stderr: "Error: No existing credentials found. Please run `vercel login` or pass \"--token\"" }), 0)).toEqual([{ state: "signed-out" }]);
    expect(parseVercelWhoami(out({ code: 1, stderr: "Error: The specified token is not valid. Use `vercel login` to generate a new token." }), 0))
      .toEqual([{ state: "expired", detail: "its login has expired; sign in again" }]);
  });

  test("wrangler: the email it is associated with, or not authenticated", () => {
    const text = "Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email alex@example.com.\n┌──────┬──────┐\n│ Acme │ 0123 │";
    expect(parseWranglerWhoami(out({ stdout: text }))).toEqual([{ state: "signed-in", account: "alex@example.com", detail: "OAuth Token" }]);
    expect(parseWranglerWhoami(out({ stdout: "You are logged in with an User API Token. Unable to retrieve email for this user." })))
      .toEqual([{ state: "signed-in", detail: "User API Token" }]);
    expect(parseWranglerWhoami(out({ code: 1, stdout: "You are not authenticated. Please run `wrangler login`." }))).toEqual([{ state: "signed-out" }]);
  });

  test("fly, npm and gcloud", () => {
    expect(parseFlyWhoami(out({ stdout: '{"email":"alex@example.com"}' }))).toEqual([{ state: "signed-in", account: "alex@example.com" }]);
    expect(parseFlyWhoami(out({ code: 1, stderr: "Error: no access token available. Please login with 'flyctl auth login'" }))).toEqual([{ state: "signed-out" }]);
    expect(parseNpmWhoami(out({ stdout: "alex\n" }))).toEqual([{ state: "signed-in", account: "alex" }]);
    expect(parseNpmWhoami(out({ code: 1, stderr: "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in." }))).toEqual([{ state: "signed-out" }]);
    expect(parseNpmWhoami(out({ code: 1, stderr: "npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami" })))
      .toEqual([{ state: "expired", detail: "its login has expired; sign in again" }]);
    expect(parseGcloudAuthList(out({ stdout: JSON.stringify([{ account: "alex@example.com", status: "ACTIVE" }, { account: "ci@acme.iam.gserviceaccount.com", status: "" }]) })))
      .toEqual([{ state: "signed-in", account: "alex@example.com", detail: "active" }, { state: "signed-in", account: "ci@acme.iam.gserviceaccount.com" }]);
    expect(parseGcloudAuthList(out({ stdout: "[]" }))).toEqual([{ state: "signed-out" }]);
  });

  test("aws: the ARN it runs as, or why not", () => {
    const arn = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_0123456789abcdef/alex@example.com";
    expect(parseAwsCallerIdentity(out({ stdout: JSON.stringify({ UserId: "AROAFIXTURE:alex", Account: "123456789012", Arn: arn }) })))
      .toEqual([{ state: "signed-in", account: arn, scope: "default", detail: "account 123456789012" }]);
    expect(parseAwsCallerIdentity(out({ code: 253, stderr: "Unable to locate credentials. You can configure credentials by running \"aws configure\"." }))).toEqual([{ state: "signed-out" }]);
    expect(parseAwsCallerIdentity(out({ code: 255, stderr: "Error when retrieving token from sso: Token has expired and refresh failed" })))
      .toEqual([{ state: "expired", detail: "its login has expired; sign in again" }]);
  });

  test("railway and netlify", () => {
    expect(parseRailwayWhoami(out({ stdout: "Logged in as Alex Doe (alex@example.com) 👋\n" }))).toEqual([{ state: "signed-in", account: "alex@example.com", detail: "Alex Doe" }]);
    expect(parseRailwayWhoami(out({ code: 1, stderr: "Unauthorized. Please login with `railway login`" }))).toEqual([{ state: "signed-out" }]);
    const block = "──────────────────────┐\n Current Netlify User │\n──────────────────────┘\nName:  Alex Doe\nEmail: alex@example.com\nGitHub: alex\n";
    expect(parseNetlifyStatus(out({ stdout: block }))).toEqual([{ state: "signed-in", account: "alex@example.com", detail: "Alex Doe" }]);
    expect(parseNetlifyStatus(out({ stdout: JSON.stringify({ account: { Name: "Alex Doe", Email: "alex@example.com" } }) })))
      .toEqual([{ state: "signed-in", account: "alex@example.com", detail: "Alex Doe" }]);
    expect(parseNetlifyStatus(out({ stdout: "Not logged in. Please log in to see project status.\nLogin with netlify login" }))).toEqual([{ state: "signed-out" }]);
  });

  test("stripe: each profile's account and expiry from its config, and never a key", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const config = [
      'color = "auto"',
      'project-name = "work"',
      "",
      "[default]",
      'account_id = "acct_fixture1"',
      'display_name = "Acme"',
      'test_mode_api_key = "sk_test_fixture"',
      'test_mode_pub_key = "pk_test_fixture"',
      'test_mode_key_expires_at = "2026-01-02"',
      "",
      "[work]",
      'account_id = "acct_fixture2"',
      'live_mode_api_key = "rk_live_fixture"',
      'test_mode_key_expires_at = "2026-12-30"',
      "",
      "[empty]",
      'device_name = "alex-mac"',
    ].join("\n");
    const found = parseStripeConfig(config, now);
    expect(found).toEqual([
      { state: "expired", account: "Acme", scope: "default", detail: "acct_fixture1 · its keys have expired; run stripe login" },
      { state: "signed-in", account: "acct_fixture2", scope: "work", detail: "active" },
    ]);
    expect(JSON.stringify(found)).not.toMatch(/sk_test|pk_test|rk_live|fixture"/);
    expect(parseStripeConfig('color = "auto"\n[default]\ndevice_name = "alex-mac"\n', now)).toEqual([{ state: "signed-out" }]);
  });

  test("an account or detail shaped like a token never crosses", () => {
    for (const token of ["gho_xxxxxxxxxxxx", "sk_live_fixture", "xoxb-fixture", "eyJhbGciOiJIUzI1NiJ9", "AKIAFIXTUREFIXTURE", "a".repeat(40), "npm_fixturefixturefixture"]) {
      expect(identity(token), token).toBeUndefined();
      expect(identity(`signed in as ${token}`), token).toBeUndefined();
    }
    expect(identity("alex@example.com")).toBe("alex@example.com");
    expect(identity("line\nbreak")).toBeUndefined();
    // A CLI that printed a token where the account goes: the row says signed in, and nothing else.
    expect(parseNpmWhoami(out({ stdout: "npm_fixturefixturefixture\n" }))).toEqual([{ state: "signed-in" }]);
  });
});

describe("running a CLI", () => {
  const context = (files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): Partial<ProbeContext> => ({
    home: "/Users/alex", env, now: 1_000,
    readText: (path) => files[path],
    exists: (path) => path in files,
  });

  test("no probe passes a flag that prints a token, and 1Password, Supabase and Stripe are never run", () => {
    const forbidden = ["--show-token", "-t", "--token", "--access-token", "print-access-token", "token", "--reveal", "--show-secrets"];
    for (const probe of CLI_PROBES) for (const args of probe.attempts ?? []) {
      for (const arg of args) expect(forbidden, `${probe.tool} ${args.join(" ")}`).not.toContain(arg);
    }
    for (const tool of ["op", "supabase", "stripe"]) {
      const probe = CLI_PROBES.find((candidate) => candidate.tool === tool)!;
      expect(probe.attempts, tool).toBeUndefined();
      expect(probe.read, tool).toBeDefined();
    }
  });

  test("not installed, installed and only looked for, and run with a clean environment", async () => {
    const calls: Array<{ binary: string; args: readonly string[]; env: Record<string, string> }> = [];
    const run = async (binary: string, args: readonly string[], env: Record<string, string>) => {
      calls.push({ binary, args, env });
      return out({ stdout: '{"email":"alex@example.com"}' });
    };
    const fly = CLI_PROBES.find((probe) => probe.tool === "fly")!;
    const op = CLI_PROBES.find((probe) => probe.tool === "op")!;
    const leaked = { GH_TOKEN: "gho_xxxxxxxxxxxx", VERCEL_TOKEN: "fixture", AWS_SECRET_ACCESS_KEY: "fixture", NPM_TOKEN: "fixture", XDG_CONFIG_HOME: "/Users/alex/.config", PATH: "/usr/bin" };
    const none = await probeCli(fly, { run, dirs: ["/opt/bin"], executable: () => false, context: context() });
    expect(none).toEqual([{ kind: "cli", tool: "fly", checkedAt: 1_000, id: "cli:fly", installed: false, state: "signed-out", detail: "not installed" }]);
    const found = await probeCli(fly, { run, dirs: ["/opt/bin"], executable: (path) => path === "/opt/bin/flyctl", context: context({ "/Users/alex/.fly": "" }, leaked) });
    expect(found).toEqual([{ kind: "cli", tool: "fly", checkedAt: 1_000, id: "cli:fly:alex@example.com", installed: true, state: "signed-in", account: "alex@example.com", configDir: "/Users/alex/.fly" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binary).toBe("/opt/bin/flyctl");
    expect(calls[0]!.args).toEqual(["auth", "whoami", "--json"]);
    const env = calls[0]!.env;
    for (const key of ["GH_TOKEN", "VERCEL_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN"]) expect(env[key], key).toBeUndefined();
    expect(env.HOME).toBe("/Users/alex");
    expect(env.PATH!.split(":")[0]).toBe("/opt/bin");
    expect(env.XDG_CONFIG_HOME).toBe("/Users/alex/.config");
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.CLOUDSDK_CORE_DISABLE_PROMPTS).toBe("1");
    expect(env.NO_COLOR).toBe("1");
    // op is looked for, never run.
    const opRecords = await probeCli(op, { run, dirs: ["/opt/bin"], executable: () => true, context: context() });
    expect(calls).toHaveLength(1);
    expect(opRecords[0]).toMatchObject({ tool: "op", installed: true, state: "unknown" });
  });

  test("gh falls back to its text when --json is unknown, and a CLI that never answers is unknown", async () => {
    const gh = CLI_PROBES.find((probe) => probe.tool === "gh")!;
    const seen: string[] = [];
    const run = async (_: string, args: readonly string[]) => {
      seen.push(args.join(" "));
      return args.includes("--json")
        ? out({ code: 1, stderr: "unknown flag: --json" })
        : out({ code: 0, stderr: "github.com\n  ✓ Logged in to github.com as alex (/Users/alex/.config/gh/hosts.yml)\n  ✓ Token: *******************" });
    };
    const found = await probeCli(gh, { run, dirs: ["/opt/bin"], executable: () => true, context: context() });
    expect(seen).toEqual(["auth status --json hosts", "auth status"]);
    expect(found.map(({ state, account, scope }) => ({ state, account, scope }))).toEqual([{ state: "signed-in", account: "alex", scope: "github.com" }]);
    const slow = await probeCli(gh, { run: async () => out({ code: null, timedOut: true }), dirs: ["/opt/bin"], executable: () => true, context: context() });
    expect(slow.map(({ state, detail }) => ({ state, detail }))).toEqual([{ state: "unknown", detail: "didn't answer within 8 s" }]);
  });

  test("aws runs only with a default profile, and never when a profile can ask", () => {
    const config = "/Users/alex/.aws/config";
    expect(awsSkip(context() as ProbeContext)).toEqual([{ state: "signed-out", detail: "no profile configured" }]);
    expect(awsSkip(context({ [config]: "[profile work]\ncredential_process = op read op://vault/aws\n[default]\nregion = us-east-1\n" }) as ProbeContext))
      .toEqual([{ state: "unknown", detail: "a profile uses a credential process or MFA, which can ask, so conch doesn't run aws" }]);
    expect(awsSkip(context({ [config]: "[profile work]\nmfa_serial = arn:aws:iam::123456789012:mfa/alex\n" }) as ProbeContext)![0]!.state).toBe("unknown");
    expect(awsSkip(context({ [config]: "[profile work]\nregion = us-east-1\n" }) as ProbeContext))
      .toEqual([{ state: "unknown", detail: "no default profile, so conch doesn't pick one to check" }]);
    expect(awsSkip(context({ [config]: "[default]\nsso_session = acme\n" }) as ProbeContext)).toBeUndefined();
  });

  test("a real run: stdin is closed, nothing of the daemon's environment but what's passed, and the limit kills it", async () => {
    const env = probeEnvironment("/bin/sh", ["/usr/bin", "/bin"], { GH_TOKEN: "gho_xxxxxxxxxxxx", USER: "alex" }, "/Users/alex");
    const read = await runProbe("/bin/sh", ["-c", "if read line; then echo had-input; else echo eof; fi; env"], env);
    expect(read.code).toBe(0);
    expect(read.stdout.split("\n")[0]).toBe("eof");
    expect(read.stdout).not.toContain("GH_TOKEN");
    expect(read.stdout).toContain("HOME=/Users/alex");
    const started = Date.now();
    const slow = await runProbe("/bin/sh", ["-c", "sleep 30"], env, 200);
    expect(slow).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await runProbe("/nonexistent/cli", [], env)).toMatchObject({ code: null, timedOut: false });
  });
});

describe("agents, and their MCP servers and plugins", () => {
  test("Claude's servers: one that asked to sign in, one with a key, one on this Mac, and a plugin's, with no secret", () => {
    const home = scratch();
    const profile = { id: "work", label: "Work", configDir: home };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {
      linear: { type: "http", url: "https://mcp.linear.example/sse?token=fixture-secret" },
      notion: { type: "http", url: "https://mcp.notion.example/mcp", headers: { Authorization: "Bearer fixture-secret" } },
      files: { command: "npx", args: ["-y", "files-server"], env: { FILES_KEY: "fixture-secret" } },
      quiet: { type: "http", url: "https://quiet.example/mcp" },
    } }));
    const plugin = join(home, "plugins", "cache", "figma");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "figma", version: "2.0.0" }));
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.example/mcp" } } }));
    writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "figma@fixture-market": [{ scope: "user", installPath: plugin, version: "2.0.0" }] } }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "figma@fixture-market": true } }));
    const now = Date.parse("2026-10-14T12:00:00Z");
    writeFileSync(join(home, "mcp-needs-auth-cache.json"), JSON.stringify({
      linear: { timestamp: now - 3 * 3_600_000 },
      "plugin:figma:figma": { timestamp: now - 10 * 60_000 },
      bogus: "not an entry",
    }));
    const needsAuth = readNeedsAuth(home);
    expect([...needsAuth.keys()]).toEqual(["linear", "plugin:figma:figma"]);
    const records = capabilityLogins(accountCapabilities("claude", profile).entities, { backend: "claude", profile, needsAuth, now });
    const rows = Object.fromEntries(records.map((item) => [item.tool, item]));
    expect(rows.linear).toMatchObject({ kind: "mcp", state: "signed-out", scope: "user", transport: "http", via: "Claude Code · Work", configDir: home });
    expect(rows.linear!.detail).toBe("mcp.linear.example · asked Claude Code to sign in 3 h ago; use /mcp in a session");
    expect(rows.figma).toMatchObject({ kind: "mcp", state: "signed-out", scope: "plugin" });
    expect(rows.figma!.detail).toContain("from figma");
    expect(rows.notion).toMatchObject({ state: "unknown", detail: "mcp.notion.example · a key in its headers" });
    expect(rows.files).toMatchObject({ state: "unknown", transport: "stdio", detail: "runs on this Mac · keys from FILES_KEY" });
    expect(rows.quiet).toMatchObject({ state: "unknown", detail: "quiet.example · OAuth if it asks; Claude Code keeps the token, which conch doesn't read" });
    expect(rows["figma@fixture-market"]).toMatchObject({ kind: "plugin", installed: true, state: "unknown", scope: "user", detail: "v2.0.0 · enabled · signs in through its MCP server" });
    expect(JSON.stringify(records)).not.toContain("fixture-secret");
    expect(JSON.stringify(records)).not.toContain("token=");
    expect(new Set(records.map((item) => item.id)).size).toBe(records.length);
    // Codex's are never known: its tokens are its own.
    const codex = capabilityLogins(accountCapabilities("claude", profile).entities, { backend: "codex", profile, needsAuth: new Map(), now });
    expect(codex.find((item) => item.tool === "linear")).toMatchObject({ state: "unknown" });
  });

  test("an agent profile's own sign-in", () => {
    const profile = { id: "default", label: "Default", configDir: "/Users/alex/.codex" };
    expect(agentLogin("codex", { ...profile, status: "signed-in", email: "alex@example.com", authType: "chatgpt", subscription: "plus" }, true, 5))
      .toEqual({ id: "agent:codex:default", kind: "agent", tool: "codex", installed: true, state: "signed-in", account: "alex@example.com", scope: "Default", configDir: "/Users/alex/.codex", checkedAt: 5, detail: "ChatGPT · plus" });
    expect(agentLogin("codex", { ...profile, status: "signed-in", authType: "apiKey" }, true, 5)).toMatchObject({ account: "API key", detail: "API key" });
    expect(agentLogin("claude", { ...profile, status: "unavailable" }, true, 5)).toMatchObject({ state: "unknown", detail: "couldn't read its status" });
    expect(agentLogin("claude", { ...profile, status: "unavailable" }, false, 5)).toMatchObject({ installed: false, detail: "not installed" });
  });

  test("the sources: each profile with its servers, a live session's project servers, and the browser profiles", async () => {
    const home = scratch();
    const project = join(home, "acme-app");
    mkdirSync(project);
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.example/mcp" } } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.example/mcp" } } }));
    const work = { id: "work", label: "Work", configDir: home };
    const sources = loginSources({
      probes: [],
      cli: { dirs: ["/opt/bin"], executable: (path) => path === "/opt/bin/claude" },
      claudeAccounts: () => [work],
      codexAccounts: () => [{ id: "default", label: "Default", configDir: join(home, "codex") }],
      claudeStatus: async (account) => ({ ...account, status: "signed-in", email: "alex@example.com", subscription: "max" }),
      codexStatus: async () => { throw new Error("must not run: codex isn't installed"); },
      browserProfiles: () => [{ id: "default", name: "Default" }, { id: "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b", name: "vercel/acme" }],
      projects: () => [{ backend: "claude", accountId: "work", cwd: project }, { backend: "claude", accountId: "personal", cwd: "/elsewhere" }],
      now: () => 7,
    });
    expect(sources.map((source) => source.key)).toEqual(["agent:claude:work", "agent:codex:default", "browser-profiles"]);
    const claude = await sources[0]!.run(false);
    expect(claude[0]).toMatchObject({ kind: "agent", tool: "claude", state: "signed-in", account: "alex@example.com", scope: "Work", detail: "max" });
    expect(claude.filter((item) => item.kind === "mcp").map((item) => [item.tool, item.scope])).toEqual([["linear", "user"], ["sentry", "project"]]);
    expect(claude.find((item) => item.tool === "sentry")!.detail).toStartWith("acme-app · ");
    expect(await sources[1]!.run(false)).toEqual([expect.objectContaining({ tool: "codex", installed: false, state: "unknown", detail: "not installed" })]);
    expect((await sources[2]!.run(false)).map(({ tool, scope, state }) => ({ tool, scope, state }))).toEqual([
      { tool: "Default", scope: "default", state: "unknown" },
      { tool: "vercel/acme", scope: undefined, state: "unknown" },
    ]);
  });

  test("the live sessions' folders, with the account each runs as", () => {
    expect(loginProjects([
      { backend: "claude", claudeAccountId: "work", cwd: "/Users/alex/acme" },
      { backend: "codex", cwd: "/Users/alex/site" },
      { cwd: "/Users/alex/notes" },
      { backend: "claude", claudeAccountId: "work" },
    ])).toEqual([
      { backend: "claude", accountId: "work", cwd: "/Users/alex/acme" },
      { backend: "codex", accountId: "default", cwd: "/Users/alex/site" },
      { backend: "claude", accountId: "default", cwd: "/Users/alex/notes" },
    ]);
  });

  test("a profile list that can't be read still has the default profile", () => {
    const sources = loginSources({
      probes: [], cli: { dirs: [], executable: () => false }, claudeDir: "/Users/alex/.claude",
      claudeAccounts: () => { throw new Error("Account profiles must have separate directories"); },
      codexAccounts: () => [], browserProfiles: () => [],
    });
    expect(sources.map((source) => source.key)).toEqual(["agent:claude:default", "browser-profiles"]);
  });
});

describe("the cache", () => {
  const source = (key: string, runs: string[], records: (n: number) => LoginRecord[] = (n) => [{ id: `${key}:row`, kind: "cli", tool: key, installed: true, state: "signed-in", checkedAt: n }]): LoginSource => ({
    key,
    run: async (refresh) => { runs.push(`${key}${refresh ? "!" : ""}`); return records(runs.length); },
  });

  test("list reads once and then answers from memory; refresh reads again, but not twice in 15 s", async () => {
    let clock = 0;
    const runs: string[] = [];
    const inventory = createLoginInventory({ sources: () => [source("gh", runs), source("npm", runs)], now: () => clock });
    const first = await inventory.handle({ kind: "login-inventory", action: "list" });
    expect(first.items.map((item) => item.tool)).toEqual(["gh", "npm"]);
    expect(runs).toEqual(["gh", "npm"]);
    clock = 60_000;
    await inventory.handle({ kind: "login-inventory", action: "list" });
    expect(runs).toHaveLength(2);
    await inventory.handle({ kind: "login-inventory", action: "refresh" });
    expect(runs).toEqual(["gh", "npm", "gh!", "npm!"]);
    clock += 5_000;
    await inventory.handle({ kind: "login-inventory", action: "refresh" });
    expect(runs).toHaveLength(4);
    clock += 5 * 60_000;
    const later = await inventory.handle({ kind: "login-inventory", action: "list" });
    expect(runs).toHaveLength(6);
    expect(later.checkedAt).toBe(clock);
  });

  test("a row's refresh reads only its own source", async () => {
    const runs: string[] = [];
    const inventory = createLoginInventory({ sources: () => [source("gh", runs), source("npm", runs)], now: () => 0 });
    await inventory.handle({ kind: "login-inventory", action: "list" });
    await inventory.handle({ kind: "login-inventory", action: "refresh", id: "npm:row" });
    expect(runs).toEqual(["gh", "npm", "npm!"]);
  });

  test("two asks at once share one read, and probes run at most four at a time", async () => {
    let running = 0;
    let most = 0;
    let started = 0;
    const slow = (key: string): LoginSource => ({
      key,
      run: async () => {
        started++;
        running++;
        most = Math.max(most, running);
        await Bun.sleep(5);
        running--;
        return [];
      },
    });
    const inventory = createLoginInventory({ sources: () => Array.from({ length: 10 }, (_, index) => slow(`s${index}`)), now: () => 0 });
    await Promise.all([inventory.handle({ kind: "login-inventory", action: "list" }), inventory.handle({ kind: "login-inventory", action: "list" })]);
    expect(started).toBe(10);
    expect(most).toBe(4);
    expect(await mapLimit([3, 1, 2], 2, async (n) => n * 2)).toEqual([6, 2, 4]);
  });

  test("a source that fails keeps what it had", async () => {
    let fail = false;
    let clock = 0;
    const inventory = createLoginInventory({
      sources: () => [{ key: "gh", run: async () => { if (fail) throw new Error("boom"); return [{ id: "gh", kind: "cli", tool: "gh", installed: true, state: "signed-in", checkedAt: 0 }]; } }],
      now: () => clock,
    });
    await inventory.handle({ kind: "login-inventory", action: "list" });
    fail = true;
    clock = 60_000;
    const reply = await inventory.handle({ kind: "login-inventory", action: "refresh" });
    expect(reply.items.map((item) => item.id)).toEqual(["gh"]);
  });
});

describe("the wire", () => {
  const reply = (items: LoginRecord[]): LoginInventoryReply => ({ kind: "login-inventory", items, checkedAt: 1 });
  const row: LoginRecord = { id: "cli:gh:github.com:alex", kind: "cli", tool: "gh", installed: true, state: "signed-in", account: "alex", scope: "github.com", checkedAt: 1 };

  test("the request is validated like every runtime message", () => {
    expect(validateRuntimeControlMessage({ kind: "login-inventory", action: "list" })).toEqual({ ok: true, value: { kind: "login-inventory", action: "list" } });
    expect(validateRuntimeControlMessage({ kind: "login-inventory", action: "refresh", id: "cli:gh", extra: "dropped" }))
      .toEqual({ ok: true, value: { kind: "login-inventory", action: "refresh", id: "cli:gh" } });
    for (const bad of [{ action: "sign-in" }, {}, { action: "list", id: "cli:gh" }, { action: "refresh", id: 3 }, { action: "refresh", id: "a\nb" }, { action: "refresh", id: "x".repeat(600) }]) {
      expect(validateRuntimeControlMessage({ kind: "login-inventory", ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("the reply is checked field by field", () => {
    expect(validateControlResponse(reply([row])).ok).toBe(true);
    expect(isLoginInventoryReply(reply([]))).toBe(true);
    for (const bad of [{ ...row, state: "maybe" }, { ...row, kind: "password" }, { ...row, account: "a\u0000b" }, { ...row, installed: "yes" }, { ...row, checkedAt: Infinity }]) {
      expect(validateControlResponse(reply([bad as LoginRecord])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("a reply too large for one frame loses its details, then its last rows, and says so", () => {
    const many = Array.from({ length: 590 }, (_, index): LoginRecord => ({ ...row, id: `mcp:${index}`, kind: "mcp", tool: `server-${index}`, detail: "d".repeat(250) }));
    const fitted = fitLoginInventoryReply(reply(many));
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThan(64 * 1024);
    expect(fitted.truncated).toBe(true);
    expect(fitted.items[0]!.detail).toBeUndefined();
    expect(fitLoginInventoryReply(reply([row]))).toEqual(reply([row]));
  });

  test("the phone may not ask; the Mac app's socket reaches it, answered in one frame", async () => {
    for (const body of [{ kind: "login-inventory", action: "list" }, { kind: "login-inventory", action: "nope" }, { kind: "control-envelope", body: { kind: "login-inventory", action: "refresh" } }]) {
      expect(isMacAppOnlyRequest(body), JSON.stringify(body)).toBe(true);
    }
    const dir = mkdtempSync("/tmp/conch-logins-");
    dirs.push(dir);
    const socketPath = join(dir, "c.sock");
    const asked: unknown[] = [];
    const server: ControlServer = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: () => { throw new Error("never resolved: it names no session"); }, current: () => ({ published: true, label: "a" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: (message) => applyRuntimeControlMessage(message, {
          listResumable: () => ({ sessions: [], complete: true }),
          start: () => {}, close: () => {}, report: () => {},
          loginInventory: async (request) => { asked.push(request); return reply([row]); },
        }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
    });
    try {
      expect(await server.start()).toBe(true);
      const answered = await sendControlMessage(socketPath, { kind: "login-inventory", action: "list" }, 5_000);
      expect(answered).toEqual({ ok: true, response: reply([row]) });
      const refused = await sendControlMessage(socketPath, { kind: "login-inventory", action: "sign-out" } as never, 5_000);
      expect(refused.ok ? (refused.response as { kind: string }).kind : refused.reason).toBe("session-error");
      expect(asked).toEqual([{ kind: "login-inventory", action: "list" }]);
    } finally {
      await server.close();
    }
  });
});

describe("`conch logins`", () => {
  test("a block per kind, the uninstalled named once, and every state in words", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const items: LoginRecord[] = [
      { id: "agent:claude:default", kind: "agent", tool: "claude", installed: true, state: "signed-in", account: "alex@example.com", scope: "Default", checkedAt: now, detail: "max" },
      { id: "cli:gh:github.com:alex", kind: "cli", tool: "gh", installed: true, state: "signed-in", account: "alex", scope: "github.com", checkedAt: now, detail: "active" },
      { id: "cli:npm", kind: "cli", tool: "npm", installed: true, state: "signed-out", checkedAt: now },
      { id: "cli:wrangler", kind: "cli", tool: "wrangler", installed: false, state: "signed-out", checkedAt: now, detail: "not installed" },
      { id: "cli:op", kind: "cli", tool: "op", installed: false, state: "signed-out", checkedAt: now, detail: "not installed" },
      { id: "mcp:claude:default:linear:1", kind: "mcp", tool: "linear", installed: true, state: "signed-out", scope: "user", via: "Claude Code · Default", transport: "http", checkedAt: now, detail: "asked to sign in" },
      { id: "browser-profile:default", kind: "browser-profile", tool: "Default", installed: true, state: "unknown", scope: "default", checkedAt: now },
    ];
    const lines = formatLoginTable({ kind: "login-inventory", items, checkedAt: now - 2 * 60_000 }, now);
    expect(lines[0]).toBe("Logins on this Mac · checked 2 min ago");
    expect(lines.filter((line) => /^[A-Z]/.test(line)).slice(1)).toEqual(["Agents", "CLIs", "Browser profiles", "MCP servers"]);
    expect(lines).toContain("  not installed: wrangler, op");
    const text = lines.join("\n");
    expect(text).toMatch(/gh\s+github\.com\s+alex\s+signed in\s+active/);
    expect(text).toMatch(/npm\s+—\s+signed out/);
    expect(text).toMatch(/linear\s+Claude Code · Default · user · http\s+—\s+signed out\s+asked to sign in/);
    expect(text).not.toContain("wrangler  ");
  });
});

describe("browser profiles' sign-ins", () => {
  const vercel = "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

  test("the Mac app's report is read for site names and times, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-sign-ins-"));
    try {
      const file = join(dir, "browser-sign-ins.json");
      expect(readBrowserSignIns(file).size).toBe(0);
      writeFileSync(file, "{ not json");
      expect(readBrowserSignIns(file).size).toBe(0);
      writeFileSync(file, JSON.stringify({
        version: 1,
        profiles: {
          default: {
            checkedAt: 1_792_195_200_000,
            sites: [
              { domain: "mobbin.com", untilQuit: false },
              { domain: "bank.example", untilQuit: true },
              { domain: "mobbin.com" },
              { domain: "Not A Site" },
              { domain: "localhost" },
              { domain: "x.com; rm -rf /" },
              { value: "a cookie's value is never here" },
              "github.com",
            ],
          },
          [vercel.toUpperCase()]: { checkedAt: 5, sites: [] },
          "not-a-profile": { checkedAt: 5, sites: [{ domain: "evil.example" }] },
          "11111111-2222-4333-8444-555555555555": { checkedAt: "yesterday", sites: [] },
        },
      }));
      const report = readBrowserSignIns(file);
      expect([...report.keys()]).toEqual(["default", vercel]);
      expect(report.get("default")).toEqual({
        checkedAt: 1_792_195_200_000,
        sites: [{ domain: "mobbin.com", untilQuit: false }, { domain: "bank.example", untilQuit: true }],
      });
      expect(report.get(vercel)).toEqual({ checkedAt: 5, sites: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a profile's row: its sites when the app has said, unknown when it hasn't", () => {
    const profile = { id: "default", name: "Default" };
    expect(browserProfileLogin(profile, undefined, 7)).toEqual({
      id: "browser-profile:default", kind: "browser-profile", tool: "Default", installed: true, scope: "default", state: "unknown", checkedAt: 7,
      detail: "conch's own browser and review pane; who it's signed in as stays in its cookies",
    });
    expect(browserProfileLogin({ id: vercel, name: "vercel/acme" }, { checkedAt: 5, sites: [] }, 7))
      .toMatchObject({ id: `browser-profile:${vercel}`, state: "signed-out", checkedAt: 5, detail: "its own cookies · not signed in to any site" });
    const sites = ["github.com", "google.com", "mobbin.com", "vercel.com", "linear.app", "figma.com"].map((domain) => ({ domain, untilQuit: false }));
    expect(browserProfileLogin(profile, { checkedAt: 5, sites: [...sites.slice(0, 1), { domain: "bank.example", untilQuit: true }] }, 7))
      .toMatchObject({ state: "signed-in", checkedAt: 5, detail: "2 sites: github.com, bank.example (until conch quits)" });
    expect(browserProfileLogin(profile, { checkedAt: 5, sites }, 7).detail).toBe("6 sites: github.com, google.com, mobbin.com, vercel.com +2 more");
    expect(browserProfileLogin(profile, { checkedAt: 5, sites: [{ domain: "a".repeat(45) + ".example", untilQuit: false }] }, 7).detail).toBe("1 site");
    expect(browserProfileLogin(profile, { checkedAt: 5, sites }, 7).account).toBeUndefined();
  });

  test("the browser profiles' source joins the report to the profiles", async () => {
    const sources = loginSources({
      probes: [], cli: { dirs: [], executable: () => false }, claudeAccounts: () => [], codexAccounts: () => [],
      browserProfiles: () => [{ id: "default", name: "Default" }, { id: vercel, name: "vercel/acme" }],
      browserSignIns: () => new Map([["default", { checkedAt: 5, sites: [{ domain: "mobbin.com", untilQuit: false }] }]]),
      now: () => 7,
    });
    const rows = await sources.find((source) => source.key === "browser-profiles")!.run(false);
    expect(rows.map(({ tool, state, detail }) => ({ tool, state, detail }))).toEqual([
      { tool: "Default", state: "signed-in", detail: "1 site: mobbin.com" },
      { tool: "vercel/acme", state: "unknown", detail: "its own cookies; who it's signed in as stays in them" },
    ]);
  });
});
