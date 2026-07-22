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
    // Absolute URL path only (no scheme/host/credentials / .. / //).
    const p = raw.trim();
    if (!/^\/[\w./@&=+-]{0,199}$/.test(p)) return null;
    if (p.includes("..") || p.includes("//")) return null;
    return p;
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
 * Constant-time compare of raw secret bytes (no digest). Pads both sides to the
 * same length so neither content nor length short-circuits the XOR fold.
 * Also requires configured length >= minLength.
 */
export async function secretsMatch(
  provided: string,
  configured: string,
  minLength = 16,
): Promise<boolean> {
  // Async signature kept for call-site stability; comparison is sync.
  await Promise.resolve();
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(configured);
  const n = Math.max(a.length, b.length, 1);
  const pa = new Uint8Array(n);
  const pb = new Uint8Array(n);
  pa.set(a);
  pb.set(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= pa[i]! ^ pb[i]!;
  const longEnough = configured.length >= minLength ? 0 : 1;
  return (diff | longEnough) === 0;
}

/** SEARCH/FETCH/MEMORY/KNOWLEDGE must each be >=16 chars and pairwise distinct. */
export function capabilitySecretsReady(env: {
  SEARCH_SECRET?: string;
  FETCH_SECRET?: string;
  MEMORY_SECRET?: string;
  KNOWLEDGE_SECRET?: string;
}): boolean {
  const s = (env.SEARCH_SECRET || "").trim();
  const f = (env.FETCH_SECRET || "").trim();
  const m = (env.MEMORY_SECRET || "").trim();
  const k = (env.KNOWLEDGE_SECRET || "").trim();
  if (s.length < 16 || f.length < 16 || m.length < 16 || k.length < 16) return false;
  return new Set([s, f, m, k]).size === 4;
}

export function channelAllowed(allowlist: string | undefined, channelId: string): boolean {
  const raw = allowlist?.trim();
  if (!raw) return true; // unset = open
  const entries = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const allowed = new Set(entries.filter((s) => isNonEmptyChannelId(s)));
  // Fail closed: a non-empty allowlist that contains zero valid snowflakes denies all.
  if (allowed.size === 0) return false;
  return allowed.has(channelId.trim());
}
