export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_KNOWLEDGE_CONTENT_LENGTH = 20_000;

/** Strip controls; bound length. Returns null if empty/oversized after sanitize. */
export function sanitizeSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > MAX_SEARCH_QUERY_LENGTH) return null;
  return cleaned;
}

export function isNonEmptyChannelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function channelAllowed(allowlist: string | undefined, channelId: string): boolean {
  const raw = allowlist?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  return allowed.has(channelId);
}
