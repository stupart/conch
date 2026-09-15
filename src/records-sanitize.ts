import type { RecordValue } from "./records-types.ts";

const OMITTED_KEYS = new Set([
  "encrypted_content", "encrypted_reasoning", "ciphertext", "signature", "thinking", "reasoning",
  "base_instructions", "system_prompt", "developer_instructions", "world_state",
  "api_key", "apikey", "access_token", "refresh_token", "authorization", "cookie", "cookies",
  "accesstoken", "refreshtoken", "password", "client_secret", "secret_key", "private_key", "bearer_token",
]);
const OMITTED_TYPES = new Set(["thinking", "redacted_thinking", "reasoning", "input_audio", "output_audio"]);

/** Keep supported content, not the provider envelope. This cannot find secrets inside ordinary prose. */
export function recordValue(value: unknown): RecordValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return /^data:[^,]*;base64,/i.test(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.map(recordValue).filter((item): item is RecordValue => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.type === "string" && OMITTED_TYPES.has(object.type)) return undefined;
  if (object.type === "base64" || object.encoding === "base64") return undefined;
  const kept: { [key: string]: RecordValue } = {};
  for (const [key, field] of Object.entries(object)) {
    if (["image", "audio", "input_image"].includes(String(object.type)) && ["data", "image_data", "audio_data"].includes(key)) continue;
    if (OMITTED_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith("encrypted_")) continue;
    const clean = recordValue(field);
    if (clean !== undefined) Object.defineProperty(kept, key, { value: clean, enumerable: true, configurable: true, writable: true });
  }
  return kept;
}

/**
 * Tool protocols often JSON-encode their result into a string. Decode an object/array at that
 * boundary so structured exclusions apply; keep prose, source code, primitives and malformed
 * JSON as ordinary output. Opaque text can still contain secrets; this is not text redaction.
 */
export function recordToolResult(value: unknown): RecordValue | undefined {
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try {
      const decoded: unknown = JSON.parse(value);
      if (decoded !== null && typeof decoded === "object") return recordValue(decoded);
    } catch { /* It is ordinary output, not a structured result. */ }
  }
  return recordValue(value);
}
