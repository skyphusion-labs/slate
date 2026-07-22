// Returns false for schemes other than http/https, and for hosts that map to
// loopback, private, link-local, metadata, or mesh-internal addresses.
// Covers literal IPs -- decimal/hex/short-form normalize to dotted-quad via the
// WHATWG URL parser before our check -- and reserved names. Residual gap: DNS
// rebinding (public name -> private A record) requires resolving the host first.
export function isSsrfSafe(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;

  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (
      a === 0                              ||  // 0/8 unspecified
      a === 10                             ||  // 10/8 RFC1918
      a === 127                            ||  // 127/8 loopback
      (a === 100 && b >= 64 && b <= 127)   ||  // 100.64/10 CGNAT / WARP mesh
      (a === 169 && b === 254)             ||  // 169.254/16 link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31)    ||  // 172.16/12 RFC1918
      (a === 192 && b === 168)             ||  // 192.168/16 RFC1918
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
      a >= 240                                  // 240/4 reserved
    ) return false;
  }

  // Literal IPv6: URL.hostname KEEPS the brackets ("[::1]"), so strip them before matching --
  // otherwise none of these checks ever fire (the original bug let [::1] / [fe80::1] / [fc00::1] /
  // [::ffff:169.254.169.254] through). Scoping to the bracketed literal also avoids false-positives
  // on real domains like fconline.com / fd-cdn.com.
  if (host.startsWith("[") && host.endsWith("]")) {
    const h6 = host.slice(1, -1);
    if (
      h6 === "::" || h6 === "::1"                 ||  // unspecified / loopback
      h6.startsWith("::ffff:")                    ||  // IPv4-mapped (covers mapped loopback/metadata)
      h6.startsWith("fe80:")                      ||  // link-local
      h6.startsWith("fc") || h6.startsWith("fd")      // unique local fc00::/7
    ) return false;
  }

  return true;
}

const BLOCKED_RESOURCE_TYPES = new Set(["image", "stylesheet", "font", "media"]);

export function shouldAbortBrowserRequest(rawUrl: string, resourceType: string): boolean {
  return BLOCKED_RESOURCE_TYPES.has(resourceType) || !isSsrfSafe(rawUrl);
}
