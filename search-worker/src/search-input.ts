export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_KNOWLEDGE_CONTENT_LENGTH = 20_000;

/** Strip controls; bound length. Returns null if empty/oversized after sanitize. */
export function sanitizeSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > MAX_SEARCH_QUERY_LENGTH) return null;
  return cleaned;
}

/** Discord snowflake-shaped channel IDs only (rejects arbitrary tenant strings). */
export function isNonEmptyChannelId(value: unknown): value is string {
  return typeof value === "string" && /^\d{5,32}$/.test(value.trim());
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
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  return allowed.has(channelId);
}
