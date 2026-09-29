import { expect, test } from "bun:test";
import { decodeSwapDashboard, parseSwapDashboard } from "../src/claude-swap.ts";
import { deviceExecutionCatalog, parseExecutionCatalog, sessionExecution } from "../src/execution-model.ts";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";

const profile = { id: "default", label: "Personal" };
const fixture = (overrides: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{
  number: 1, email: "person@example.com", alias: "Personal", organizationUuid: "org-1", organizationName: "Personal org", active: true,
  usageStatus: "ok", usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 94, resetsAt: "2026-10-01T00:00:00Z" }, scoped: [{ name: "Sonnet", pct: 101 }] },
  usageFetchedAt: "2026-09-29T12:00:00Z", accessToken: "never-display", ...overrides,
}] });

test("account registrations are scoped to a runtime and provider; unknown identity stays unknown", () => {
  const mac = deviceExecutionCatalog("mac-a", "Laptop", [profile, profile]);
  const other = deviceExecutionCatalog("mac-b", "Desktop", [profile]);
  expect(mac.accounts).toHaveLength(1);
  expect(mac.accounts[0]!.id).not.toBe(other.accounts[0]!.id);
  expect(mac.accounts[0]!.identity).toBe("local-registration");
  expect(mac.accounts[0]!.subject).toBeUndefined();
  expect(sessionExecution("mac-a", "claude", "default").connectionId).toBe(mac.connections[0]!.id);
  expect(sessionExecution("mac-b", "claude", "default").connectionId).not.toBe(mac.connections[0]!.id);
  expect(sessionExecution("mac-a", "codex")).toEqual({ providerId: "codex", runtimeId: "device:mac-a" });
});

test("one account can connect to two devices and a provider cloud without making cloud a local device", () => {
  const catalog = deviceExecutionCatalog("mac-a", "Laptop", [profile]);
  catalog.runtimes.push({ id: "device:mac-b", kind: "device", ownerDeviceId: "mac-b", label: "Desktop" });
  catalog.runtimes.push({ id: "cloud:workspace", kind: "provider-cloud", providerId: "claude", workspaceId: "workspace", label: "Claude cloud" });
  for (const runtime of catalog.runtimes.slice(1)) catalog.connections.push({ id: `connection:${runtime.id}`, providerId: "claude", runtimeId: runtime.id, accountId: catalog.accounts[0]!.id });
  const decoded = parseExecutionCatalog(catalog)!;
  expect(decoded.accounts).toHaveLength(1);
  expect(decoded.connections).toHaveLength(3);
  expect(decoded.runtimes[2]!.kind).toBe("provider-cloud");
  expect("ownerDeviceId" in decoded.runtimes[2]!).toBe(false);
  catalog.connections[2]!.accountId = "missing";
  expect(parseExecutionCatalog(catalog)).toBeUndefined();
});

test("published sessions reference their owner runtime and account connection; existing keys remain intact", () => {
  const model = buildPanelModel({ sessions: [{ sessionId: "window#42", agentSessionId: "native", backend: "claude", claudeAccountId: "default", accountLabel: "Personal" }],
    sessionStates: new Map(), pausedSessionIds: new Set(), live: { state: "idle", label: "", partial: "" }, mode: { muted: false, paused: false, holding: 0 }, activeSessionId: null, navSelectedId: null });
  const state = buildPublishedState("mac-a", model, new Map(), new Set(), 100, { runtimeLabel: "Laptop" });
  expect(state.rows[0]!.id).toBe("window#42");
  expect(state.rows[0]!.execution?.connectionId).toBe(state.execution!.connections[0]!.id);
  expect(state.execution!.runtimes[0]).toMatchObject({ ownerDeviceId: state.ownerDeviceId, label: "Laptop" });
  expect(JSON.stringify(state.execution)).not.toContain("configDir");
});

test("usage adapter preserves measured zero, over-limit values, scoped windows, and raw reset time", () => {
  const dashboard = decodeSwapDashboard(fixture());
  expect(dashboard.state).toBe("ready");
  expect(dashboard.accounts[0]!.windows).toEqual([
    { name: "5 hour", pct: 0 }, { name: "7 day", pct: 94, resetsAt: "2026-10-01T00:00:00.000Z" }, { name: "Sonnet", pct: 101 },
  ]);
  expect(dashboard.accounts[0]!.defaultLogin).toBe(true);
  expect(JSON.stringify(dashboard)).not.toContain("never-display");
  expect(parseSwapDashboard(dashboard)).toEqual(dashboard);
});

test("missing usage never becomes zero and failed reads only use explicitly labelled last-good data", () => {
  const absent = decodeSwapDashboard(fixture({ usage: null, usageStatus: "no_credentials", usageFetchedAt: undefined }));
  expect(absent.accounts[0]!.windows).toEqual([]);
  expect(absent.accounts[0]!.fetchedAt).toBeUndefined();
  const previous = decodeSwapDashboard(fixture({ usage: null, usageStatus: "unavailable", lastGoodUsage: { fiveHour: { pct: 81 } }, lastGoodFetchedAt: "2026-09-28T00:00:00Z" }));
  expect(previous.accounts[0]).toMatchObject({ lastGood: true, fetchedAt: "2026-09-28T00:00:00.000Z", windows: [{ name: "5 hour", pct: 81 }] });
  const changed = decodeSwapDashboard(fixture({ organizationUuid: "different-org" }));
  expect(changed.accounts[0]!.id).not.toBe(absent.accounts[0]!.id);
});

test("malformed schemas and data cannot leak secrets or impersonate a usage reading", () => {
  for (const input of ["secret: invalid json", '{"schemaVersion":2,"accounts":[]}', "x".repeat(1_048_577)]) {
    expect(decodeSwapDashboard(input).state).toBe("error");
    expect(JSON.stringify(decodeSwapDashboard(input))).not.toContain("secret");
  }
  expect(decodeSwapDashboard(fixture({ usage: { fiveHour: { pct: "98" }, sevenDay: { pct: -1 } } })).accounts[0]!.windows).toEqual([]);
  expect(decodeSwapDashboard(fixture({ email: "bad\nidentity" })).state).toBe("error");
});

test("wire projection carries catalog and usage, strips arbitrary fields, and rejects broken references", () => {
  expect(validateRuntimeControlMessage({ kind: "claude-accounts", action: "usage" }).ok).toBe(true);
  const catalog = deviceExecutionCatalog("mac", "Laptop", [profile]);
  const usage = decodeSwapDashboard(fixture());
  const reply = { kind: "claude-accounts", accounts: [], execution: catalog, usage: { ...usage, accessToken: "secret" } };
  const parsed = validateControlResponse(reply);
  expect(parsed).toMatchObject({ ok: true, value: { execution: catalog, usage } });
  expect(JSON.stringify(parsed)).not.toContain("secret");
  catalog.connections[0]!.runtimeId = "other-device";
  expect(validateControlResponse(reply).ok).toBe(false);
});
