/** Read-only dashboard bridge to claude-swap schema v1. No switching, login,
 * credential import or quota-based routing. See third-party/claude-swap/LICENSE. */
export interface UsageWindow {
  name: string;
  pct: number;
  resetsAt?: string;
}
export interface SwapUsageAccount {
  id: string;
  number: number;
  label: string;
  email: string;
  organization?: string;
  defaultLogin: boolean;
  status: string;
  windows: UsageWindow[];
  fetchedAt?: string;
  lastGood: boolean;
}
export interface SwapDashboard {
  source: "claude-swap";
  state: "ready" | "unavailable" | "error";
  accounts: SwapUsageAccount[];
  message?: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown, max = 200): string | undefined => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : undefined;
const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;
const STATUSES = new Set(["ok", "token_expired", "no_credentials", "api_key", "keychain_unavailable", "relogin_required", "foreign_credential", "unavailable"]);

function usageWindows(usage: unknown): UsageWindow[] {
  if (!object(usage)) return [];
  const result: UsageWindow[] = [];
  const add = (name: string, value: unknown) => {
    if (!object(value) || typeof value.pct !== "number" || !Number.isFinite(value.pct) || value.pct < 0) return;
    const resetsAt = date(value.resetsAt);
    result.push({ name, pct: value.pct, ...(resetsAt ? { resetsAt } : {}) });
  };
  add("5 hour", usage.fiveHour);
  add("7 day", usage.sevenDay);
  if (Array.isArray(usage.scoped)) for (const scoped of usage.scoped.slice(0, 16)) {
    if (object(scoped) && safeText(scoped.name, 50)) add(scoped.name as string, scoped);
  }
  return result;
}

/** Project only public display fields. Never echo subprocess errors or unknown
 * properties (including credentials) into the app or shared state. */
export function decodeSwapDashboard(raw: string): SwapDashboard {
  const fail: SwapDashboard = { source: "claude-swap", state: "error", accounts: [], message: "Could not read claude-swap usage. Update claude-swap and try again." };
  try {
    if (raw.length > 1_048_576) return fail;
    const doc: unknown = JSON.parse(raw);
    if (!object(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.accounts) || doc.accounts.length > 100) return fail;
    const ids = new Set<number>();
    const accounts = doc.accounts.map((row): SwapUsageAccount => {
      if (!object(row) || !Number.isSafeInteger(row.number) || (row.number as number) < 1 || ids.has(row.number as number) || !safeText(row.email)) throw new Error();
      const number = row.number as number;
      ids.add(number);
      const email = row.email as string;
      const organizationId = safeText(row.organizationUuid) ?? "";
      const status = STATUSES.has(String(row.usageStatus)) ? String(row.usageStatus) : "unavailable";
      const lastGood = status !== "ok";
      const fetchedAt = date(lastGood ? row.lastGoodFetchedAt : row.usageFetchedAt);
      const organization = safeText(row.organizationName);
      return {
        // Slots can be reused. An old slot's measurement must never follow a new identity.
        id: JSON.stringify([number, email, organizationId]), number,
        label: safeText(row.alias) || email, email,
        ...(organization ? { organization } : {}), defaultLogin: row.active === true, status,
        windows: usageWindows(lastGood ? row.lastGoodUsage : row.usage),
        ...(fetchedAt ? { fetchedAt } : {}), lastGood,
      };
    });
    return { source: "claude-swap", state: "ready", accounts };
  } catch { return fail; }
}

export function parseSwapDashboard(value: unknown): SwapDashboard | undefined {
  if (!object(value) || value.source !== "claude-swap" || !["ready", "unavailable", "error"].includes(String(value.state))
    || !Array.isArray(value.accounts) || value.accounts.length > 100) return;
  const accounts: SwapUsageAccount[] = [];
  for (const row of value.accounts) {
    if (!object(row) || !safeText(row.id, 1024) || !safeText(row.email) || !safeText(row.label) || !Number.isSafeInteger(row.number)
      || !Array.isArray(row.windows) || row.windows.length > 18) return;
    const windows: UsageWindow[] = [];
    for (const window of row.windows) {
      if (!object(window) || !safeText(window.name, 50) || typeof window.pct !== "number" || !Number.isFinite(window.pct) || window.pct < 0) return;
      windows.push({ name: window.name as string, pct: window.pct, ...(date(window.resetsAt) ? { resetsAt: date(window.resetsAt) } : {}) });
    }
    accounts.push({ id: row.id as string, number: row.number as number, label: row.label as string, email: row.email as string,
      ...(safeText(row.organization) ? { organization: row.organization as string } : {}),
      defaultLogin: row.defaultLogin === true, status: STATUSES.has(String(row.status)) ? String(row.status) : "unavailable",
      lastGood: row.lastGood === true, windows, ...(date(row.fetchedAt) ? { fetchedAt: date(row.fetchedAt) } : {}) });
  }
  return { source: "claude-swap", state: value.state as SwapDashboard["state"], accounts,
    ...(safeText(value.message, 300) ? { message: value.message as string } : {}) };
}

/** Explicit refresh only. cswap owns its cache/backoff and may refresh OAuth.
 * It is optional and is never installed or launched as part of daemon startup. */
export async function readSwapDashboard(): Promise<SwapDashboard> {
  const executable = Bun.which("cswap");
  if (!executable) return { source: "claude-swap", state: "unavailable", accounts: [], message: "Install claude-swap and add your accounts there to read usage here. Conch launch profiles remain separate." };
  try {
    const child = Bun.spawn([executable, "list", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 12_000);
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_048_576) { child.kill("SIGKILL"); await reader.cancel(); throw new Error(); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      const code = await child.exited;
      if (timedOut || code !== 0) throw new Error();
      return decodeSwapDashboard(raw);
    } finally { clearTimeout(timer); }
  } catch {
    return { source: "claude-swap", state: "error", accounts: [], message: "claude-swap did not return usage. Check it in Terminal, then try again." };
  }
}
