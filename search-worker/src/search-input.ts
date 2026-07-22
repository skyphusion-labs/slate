export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_KNOWLEDGE_CONTENT_LENGTH = 20_000;

/** Strip controls; bound length. Returns null if empty/oversized after sanitize. */
export function sanitizeSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > MAX_SEARCH_QUERY_LENGTH) return null;
  return cleaned;
}

/** Discord snowflake channel IDs (typically 17–20 digits; reject short/arbitrary tenants). */
export function isNonEmptyChannelId(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value.trim());
}

/** Reserved Vectorize metadata keys -- caller-supplied `meta` must never overwrite these. */
export const MEMORY_META_RESERVED = new Set(["channelId", "kind", "content", "createdAt", "id"]);

/** Optional caller meta keys allowed on /memory/index (bot traffic tags). */
export const MEMORY_META_ALLOWED = new Set(["method", "path"]);

/** Sanitize /memory/index `meta`: allow-listed keys only; never clobber reserved fields. */
export function sanitizeMemoryMeta(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>).slice(0, 10)) {
    if (MEMORY_META_RESERVED.has(k) || !MEMORY_META_ALLOWED.has(k)) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    out[k.slice(0, 40)] = String(v).slice(0, 200);
  }
  return out;
}

/**
 * Compare secrets without leaking configured length via early returns.
 * Always SHA-256 both sides (fixed 32-byte compare), then require configured
 * length >= 16 as part of the boolean result.
 */
export async function secretsMatch(
  provided: string,
  configured: string,
  minLength = 16,
): Promise<boolean> {
  const enc = new TextEncoder();
  const [aBuf, bBuf] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(configured)),
  ]);
  const a = new Uint8Array(aBuf);
  const b = new Uint8Array(bBuf);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  const longEnough = configured.length >= minLength ? 0 : 1;
  return (diff | longEnough) === 0;
}

export function channelAllowed(allowlist: string | undefined, channelId: string): boolean {
  const raw = allowlist?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => isNonEmptyChannelId(s)),
  );
  return allowed.has(channelId.trim());
}
