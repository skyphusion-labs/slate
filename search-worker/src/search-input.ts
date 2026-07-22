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

/** Sanitize a single allow-listed meta value (strict charset; no free-form injection). */
function sanitizeMemoryMetaValue(key: string, value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  const raw = String(value).slice(0, 200);
  if (key === "method") {
    const m = raw.trim().toUpperCase();
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m) ? m : null;
  }
  if (key === "path") {
    // Absolute URL path only (no scheme/host/credentials).
    const p = raw.trim();
    return /^\/[\w./@%&=+-]{0,199}$/.test(p) ? p : null;
  }
  return null;
}

/** Sanitize /memory/index `meta`: allow-listed keys only; never clobber reserved fields. */
export function sanitizeMemoryMeta(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>).slice(0, 10)) {
    if (MEMORY_META_RESERVED.has(k) || !MEMORY_META_ALLOWED.has(k)) continue;
    const clean = sanitizeMemoryMetaValue(k, v);
    if (clean === null) continue;
    out[k] = clean;
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

/** SEARCH/FETCH/MEMORY must each be >=16 chars and pairwise distinct. */
export function capabilitySecretsReady(env: {
  SEARCH_SECRET?: string;
  FETCH_SECRET?: string;
  MEMORY_SECRET?: string;
}): boolean {
  const s = (env.SEARCH_SECRET || "").trim();
  const f = (env.FETCH_SECRET || "").trim();
  const m = (env.MEMORY_SECRET || "").trim();
  if (s.length < 16 || f.length < 16 || m.length < 16) return false;
  return new Set([s, f, m]).size === 3;
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
