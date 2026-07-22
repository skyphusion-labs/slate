// SSRF guards for /fetch (CF Browser Rendering).
//
// Sync checks cover scheme + literal / reserved hosts + embedded credentials.
// Async checks resolve via Cloudflare DNS-over-HTTPS (including CNAME targets)
// and reject if ANY answer is private / link-local / metadata. Fail closed on
// DNS errors, truncated answers, non-NOERROR Status, or empty answers.
//
// Browser policy: only main-frame `document` navigations are allowed (redirect
// hops included). Scripts/XHR/etc. are aborted so in-page JS cannot open a
// second SSRF path. Callers should also pre-walk HTTP redirects with
// `resolvePublicRedirectChain` before launching the browser.

export type DnsLookup = (hostname: string) => Promise<string[]>;

/** Only main-document navigations (and their HTTP redirect hops) may proceed. */
export const ALLOWED_BROWSER_RESOURCE_TYPES = new Set(["document"]);

export const MAX_FETCH_URL_LENGTH = 2048;
export const MAX_REDIRECT_HOPS = 5;
const MAX_CNAME_DEPTH = 4;

// Cloudflare DoH (valid TLS / SNI). Rebinding resistance comes from double-resolve
// in isSsrfSafeResolved, not cross-provider Answer equality (CF vs Google often
// differ on CNAME vs A shape and would self-DoS every fetch).
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TYPE_A = 1;
const DOH_TYPE_NS = 2;
const DOH_TYPE_CNAME = 5;
const DOH_TYPE_AAAA = 28;
const DOH_STATUS_NOERROR = 0;

/** True when `ip` is loopback, private, link-local, CGNAT, metadata, or reserved. */
export function isBlockedIp(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, "");

  const mappedV4 = ipv4FromMappedV6(host);
  if (mappedV4) return isBlockedIpv4(mappedV4);

  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isBlockedIpv4(host);

  // IPv6 literals (DoH returns without brackets).
  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("::ffff:") // any IPv4-mapped form we failed to decode above
  ) {
    return true;
  }

  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true;
  const octets = m.slice(1).map((x) => Number(x));
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 || // 0/8 unspecified
    a === 10 || // 10/8 RFC1918
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT / WARP mesh
    (a === 169 && b === 254) || // 169.254/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 RFC1918
    (a === 192 && b === 168) || // 192.168/16 RFC1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
    a >= 240 // 240/4 reserved
  );
}

/** Decode ::ffff:dotted or ::ffff:xxxx:yyyy into dotted-quad, else null. */
function ipv4FromMappedV6(h6: string): string | null {
  const dotted = h6.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (dotted) return `${dotted[1]}.${dotted[2]}.${dotted[3]}.${dotted[4]}`;
  const hex = h6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isIpLiteralHostname(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (host.includes(":") && !host.includes(".")) return true;
  return false;
}

export function isReservedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".internal") || h.endsWith(".local");
}

/**
 * Sync URL-shape SSRF check. Allows public hostnames without resolving them
 * (use `isSsrfSafeResolved` before any network hop).
 */
export function isSsrfSafe(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_FETCH_URL_LENGTH) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  // Explicit allow-list: http/https only (blocks data:, file:, ftp:, javascript:, ...).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // user:pass@host can confuse parsers / logs; never accept credentials in the URL.
  if (parsed.username !== "" || parsed.password !== "") return false;

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return false;
  if (isReservedHostname(host)) return false;

  if (isIpLiteralHostname(host)) {
    return !isBlockedIp(host);
  }

  return true;
}

interface DohAnswer {
  type: number;
  data: string;
}

interface DohJsonBody {
  Status?: number;
  TC?: boolean;
  Answer?: unknown;
}

function cnameTargetHostname(data: string): string {
  return data.toLowerCase().replace(/\.$/, "");
}

function parseDohAnswers(body: DohJsonBody, type: "A" | "AAAA"): DohAnswer[] {
  // Status 0 = NOERROR. Anything else (NXDOMAIN, SERVFAIL, ...) fails closed.
  if (body.Status !== undefined && body.Status !== DOH_STATUS_NOERROR) {
    throw new Error(`DoH Status ${body.Status}`);
  }
  // Truncated answers may omit private records the browser later sees -- refuse.
  if (body.TC === true) {
    throw new Error("DoH truncated");
  }
  if (body.Answer === undefined) return [];
  if (!Array.isArray(body.Answer)) {
    throw new Error(`DoH ${type} Answer is not an array`);
  }
  const out: DohAnswer[] = [];
  for (const raw of body.Answer) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`DoH ${type} Answer entry malformed`);
    }
    const ans = raw as { type?: unknown; data?: unknown };
    if (typeof ans.type !== "number" || typeof ans.data !== "string" || ans.data.length === 0) {
      throw new Error(`DoH ${type} Answer entry missing type/data`);
    }
    out.push({ type: ans.type, data: ans.data });
  }
  return out;
}

async function dohQuery(
  hostname: string,
  type: "A" | "AAAA",
  fetchImpl: typeof fetch,
): Promise<DohAnswer[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) {
    throw new Error(`DoH ${type} failed: ${res.status}`);
  }
  let body: DohJsonBody;
  try {
    body = (await res.json()) as DohJsonBody;
  } catch {
    throw new Error(`DoH ${type} JSON parse failed`);
  }
  return parseDohAnswers(body, type);
}

/**
 * Resolve A + AAAA via Cloudflare DoH JSON. Recurses into CNAME targets (bounded)
 * and unions their addresses so a public A + private CNAME chain cannot sneak past.
 * Throws on transport failure, reserved CNAME targets, truncated/non-NOERROR, or
 * excessive CNAME depth.
 */
export async function lookupDnsJson(
  hostname: string,
  fetchImpl: typeof fetch = fetch,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_CNAME_DEPTH) {
    throw new Error("DoH CNAME chain too deep");
  }

  const ips: string[] = [];
  const cnames = new Set<string>();

  for (const type of ["A", "AAAA"] as const) {
    const want = type === "A" ? DOH_TYPE_A : DOH_TYPE_AAAA;
    for (const ans of await dohQuery(hostname, type, fetchImpl)) {
      if (ans.type === DOH_TYPE_CNAME) {
        cnames.add(cnameTargetHostname(ans.data));
        continue;
      }
      if (ans.type === DOH_TYPE_NS) continue;
      if (ans.type === want) {
        ips.push(ans.data);
      }
    }
  }

  for (const target of cnames) {
    if (isReservedHostname(target)) {
      throw new Error(`DoH CNAME to reserved host: ${target}`);
    }
    if (isIpLiteralHostname(target)) {
      if (isBlockedIp(target)) {
        throw new Error(`DoH CNAME to blocked IP: ${target}`);
      }
      ips.push(target.replace(/^\[|\]$/g, ""));
      continue;
    }
    const nested = await lookupDnsJson(target, fetchImpl, depth + 1);
    ips.push(...nested);
  }

  return ips;
}

export interface SsrfResolveOpts {
  lookup?: DnsLookup;
}

/**
 * Full SSRF check including DNS resolution. Fail closed if lookup throws or
 * returns no addresses. Unsafe if any resolved address is blocked.
 *
 * Intentionally does NOT cache results across hops -- rebinding TOCTOU requires
 * a fresh lookup immediately before each continue().
 */
export async function isSsrfSafeResolved(
  raw: string,
  opts: SsrfResolveOpts = {},
): Promise<boolean> {
  if (!isSsrfSafe(raw)) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (isIpLiteralHostname(host)) {
    return !isBlockedIp(host);
  }

  const lookup = opts.lookup ?? ((h: string) => lookupDnsJson(h));
  // Double-resolve and require a stable answer set so a TTL=0 rebinding name
  // that flips between the Worker DoH check and Chromium's dial is more likely
  // to be caught (true IP pinning is unavailable in Browser Rendering).
  let first: string[];
  let second: string[];
  try {
    first = await lookup(host);
    second = await lookup(host);
  } catch {
    return false;
  }

  if (first.length === 0 || second.length === 0) return false;
  const norm = (ips: string[]) => [...new Set(ips)].sort().join("\0");
  if (norm(first) !== norm(second)) return false;
  return first.every((ip) => !isBlockedIp(ip));
}

/** Sync abort decision (non-document types + URL shape / literal IP). */
export function shouldAbortBrowserRequest(rawUrl: string, resourceType: string): boolean {
  return !ALLOWED_BROWSER_RESOURCE_TYPES.has(resourceType) || !isSsrfSafe(rawUrl);
}

/**
 * Abort decision for intercepted browser requests. Only `document` hops may
 * proceed, and each hop re-resolves DNS immediately before continue.
 */
export async function shouldAbortBrowserRequestResolved(
  rawUrl: string,
  resourceType: string,
  opts: SsrfResolveOpts = {},
): Promise<boolean> {
  if (!ALLOWED_BROWSER_RESOURCE_TYPES.has(resourceType)) return true;
  if (!isSsrfSafe(rawUrl)) return true;
  return !(await isSsrfSafeResolved(rawUrl, opts));
}

export type RedirectFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Resolve a Location / Refresh URL against `base`. Only http/https survive
 * `isSsrfSafe` (allow-list -- covers javascript:/data:/vbscript:/file:/...).
 * Returns absolute href or null.
 */
export function resolveRedirectLocation(base: string, loc: string): string | null {
  const trimmed = loc.trim();
  if (!trimmed || trimmed.length > MAX_FETCH_URL_LENGTH) return null;
  try {
    const abs = new URL(trimmed, base).href;
    // Shape check (scheme allow-list / credentials / literals); caller still DoH-resolves.
    return isSsrfSafe(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Parse non-standard `Refresh: <delay>; url=<target>` (or bare url after delay). */
export function parseRefreshHeader(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const withUrl = v.match(/^\d+\s*;\s*url\s*=\s*("?)([^";]+)\1\s*$/i);
  if (withUrl) return withUrl[2].trim();
  const bare = v.match(/^\d+\s*;\s*(\S+)\s*$/i);
  if (bare && !/^\d+$/.test(bare[1])) return bare[1].trim();
  return null;
}

/**
 * Walk HTTP 3xx Location hops (and Refresh headers) with redirect:manual,
 * validating every URL with DoH before requesting it. Returns the first
 * non-redirect URL. Returns null on unsafe / too many hops.
 */
export async function resolvePublicRedirectChain(
  startUrl: string,
  opts: {
    lookup?: DnsLookup;
    fetchImpl?: RedirectFetch;
    maxHops?: number;
  } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  let current = startUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (!(await isSsrfSafeResolved(current, { lookup: opts.lookup }))) {
      return null;
    }
    if (hop === maxHops) {
      return null;
    }

    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "slate-search-ssrf-prewalk/1.0" },
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (!loc) return null;
      const next = resolveRedirectLocation(current, loc);
      if (!next) return null;
      current = next;
      continue;
    }

    // Refresh-on-2xx is a rare legacy pattern; do not follow it as a redirect hop
    // (3xx Location already handled above). Meta-refresh inside HTML is stripped
    // after setContent in handleFetch.
    return current;
  }

  return null;
}
