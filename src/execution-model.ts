/** Identity and placement are independent. "Local" is a viewer's relation to a
 * device, never a persistent runtime kind. A provider can run in either kind. */
export type ProviderId = "claude" | "codex";
export type RuntimeLocation =
  | { id: string; kind: "device"; ownerDeviceId: string; label: string }
  | { id: string; kind: "provider-cloud"; providerId: ProviderId; workspaceId: string; label: string };

export interface ProviderAccount {
  id: string;
  providerId: ProviderId;
  label: string;
  /** A registration is not a verified provider subject. Never merge by email. */
  identity: "local-registration" | "provider-subject";
  subject?: string;
}
export interface ProviderConnection {
  id: string;
  providerId: ProviderId;
  runtimeId: string;
  accountId?: string;
  /** Opaque reference to the owner's existing launch profile, never credentials. */
  profileId?: string;
}
export interface SessionExecution {
  providerId: ProviderId;
  runtimeId: string;
  connectionId?: string;
}
export interface ExecutionCatalog {
  runtimes: RuntimeLocation[];
  accounts: ProviderAccount[];
  connections: ProviderConnection[];
}
type Profile = { id: string; label: string };
export const deviceRuntimeId = (ownerDeviceId: string) => `device:${encodeURIComponent(ownerDeviceId)}`;
const profileKey = (ownerDeviceId: string, profileId: string) => `${deviceRuntimeId(ownerDeviceId)}:claude:${encodeURIComponent(profileId)}`;

/** Existing account ids name device-local registrations. Namespace them before
 * combining snapshots; both Macs are allowed to have a profile called default. */
export function deviceExecutionCatalog(ownerDeviceId: string, label: string, profiles: readonly Profile[]): ExecutionCatalog {
  const runtimeId = deviceRuntimeId(ownerDeviceId);
  const unique = [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
  return {
    runtimes: [{ id: runtimeId, kind: "device", ownerDeviceId, label }],
    accounts: unique.map((profile) => ({ id: `account:${profileKey(ownerDeviceId, profile.id)}`, providerId: "claude", label: profile.label, identity: "local-registration" })),
    connections: unique.map((profile) => ({ id: `connection:${profileKey(ownerDeviceId, profile.id)}`, providerId: "claude", runtimeId,
      accountId: `account:${profileKey(ownerDeviceId, profile.id)}`, profileId: profile.id })),
  };
}

export function sessionExecution(ownerDeviceId: string, providerId: ProviderId, profileId?: string): SessionExecution {
  return { providerId, runtimeId: deviceRuntimeId(ownerDeviceId),
    ...(providerId === "claude" && profileId ? { connectionId: `connection:${profileKey(ownerDeviceId, profileId)}` } : {}) };
}

/** Public protocol projection; credential/config payloads cannot ride along. */
export function parseExecutionCatalog(value: unknown): ExecutionCatalog | undefined {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
  const provider = (v: unknown): v is ProviderId => v === "claude" || v === "codex";
  if (!object(value) || !Array.isArray(value.runtimes) || !Array.isArray(value.accounts) || !Array.isArray(value.connections)
    || [value.runtimes, value.accounts, value.connections].some((items) => items.length > 100)) return;
  const result: ExecutionCatalog = { runtimes: [], accounts: [], connections: [] };
  for (const row of value.runtimes) {
    if (!object(row) || !text(row.id) || !text(row.label)) return;
    if (row.kind === "device" && text(row.ownerDeviceId)) result.runtimes.push({ id: row.id, kind: "device", ownerDeviceId: row.ownerDeviceId, label: row.label });
    else if (row.kind === "provider-cloud" && provider(row.providerId) && text(row.workspaceId)) result.runtimes.push({ id: row.id, kind: "provider-cloud", providerId: row.providerId, workspaceId: row.workspaceId, label: row.label });
    else return;
  }
  for (const row of value.accounts) {
    if (!object(row) || !text(row.id) || !provider(row.providerId) || !text(row.label)
      || !["local-registration", "provider-subject"].includes(String(row.identity))) return;
    if (row.identity === "provider-subject" && !text(row.subject)) return;
    result.accounts.push({ id: row.id, providerId: row.providerId, label: row.label, identity: row.identity as ProviderAccount["identity"], ...(text(row.subject) ? { subject: row.subject } : {}) });
  }
  for (const row of value.connections) {
    if (!object(row) || !text(row.id) || !provider(row.providerId) || !text(row.runtimeId)
      || !result.runtimes.some((runtime) => runtime.id === row.runtimeId)
      || (row.accountId !== undefined && !result.accounts.some((account) => account.id === row.accountId && account.providerId === row.providerId))) return;
    result.connections.push({ id: row.id, providerId: row.providerId, runtimeId: row.runtimeId,
      ...(text(row.accountId) ? { accountId: row.accountId } : {}), ...(text(row.profileId) ? { profileId: row.profileId } : {}) });
  }
  if ([result.runtimes, result.accounts, result.connections].some((rows) => new Set(rows.map((row) => row.id)).size !== rows.length)) return;
  return result;
}
