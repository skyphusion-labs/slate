import { describe, expect, it } from "vitest";
import {
  isBlockedIp,
  isSsrfSafe,
  isSsrfSafeResolved,
  lookupDnsJson,
  MAX_FETCH_URL_LENGTH,
  parseRefreshHeader,
  resolvePublicRedirectChain,
  resolveRedirectLocation,
  shouldAbortBrowserRequest,
  shouldAbortBrowserRequestResolved,
  type DnsLookup,
} from "./src/ssrf";
import {
  capabilitySecretsReady,
  channelAllowed,
  isNonEmptyChannelId,
  sanitizeMemoryMeta,
  sanitizeSearchQuery,
} from "./src/search-input";

describe("search-worker SSRF filtering", () => {
  it("allows public http and https document URLs (sync shape)", () => {
    expect(isSsrfSafe("https://example.com/page")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/page", "document")).toBe(false);
  });

  it("rejects non-http(s) schemes and embedded credentials", () => {
    expect(isSsrfSafe("data:text/html,hi")).toBe(false);
    expect(isSsrfSafe("file:///etc/passwd")).toBe(false);
    expect(isSsrfSafe("ftp://example.com/a")).toBe(false);
    expect(isSsrfSafe("https://user:pass@example.com/")).toBe(false);
    expect(isSsrfSafe("https://user@example.com/")).toBe(false);
  });

  it("blocks redirect-chain document requests to private and metadata hosts", () => {
    for (const redirectedUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.8/admin",
      "http://172.16.1.10/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:a9fe:a9fe]/",
    ]) {
      expect(shouldAbortBrowserRequest(redirectedUrl, "document"), redirectedUrl).toBe(true);
    }
  });

  it("aborts every non-document resource type (script/xhr/css included)", () => {
    expect(shouldAbortBrowserRequest("https://example.com/app.js", "script")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/api", "xhr")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/api", "fetch")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/image.jpg", "image")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/app.css", "stylesheet")).toBe(true);
  });

  it("rejects oversized URLs", () => {
    const huge = `https://example.com/${"a".repeat(MAX_FETCH_URL_LENGTH)}`;
    expect(isSsrfSafe(huge)).toBe(false);
  });

  it("decodes IPv4-mapped IPv6 metadata / loopback as blocked", () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });

  it("blocks NAT64 and 6to4 IPv4-embedded AAAA answers", () => {
    expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isBlockedIp("64:ff9b:1:0:a9fe:a9fe")).toBe(true);
    expect(isBlockedIp("2002:a9fe:a9fe::")).toBe(true);
    expect(isBlockedIp("2002:0808:0808::")).toBe(false);
  });

  it("rejects DNS-rebinding hostnames that resolve to private/metadata IPs", async () => {
    const lookup: DnsLookup = async () => ["169.254.169.254"];
    expect(await isSsrfSafeResolved("https://rebind.example/meta", { lookup })).toBe(false);
    expect(
      await shouldAbortBrowserRequestResolved("https://rebind.example/meta", "document", { lookup }),
    ).toBe(true);
  });

  it("rejects when any resolved address is private (multi-A rebinding)", async () => {
    const lookup: DnsLookup = async () => ["93.184.216.34", "10.0.0.1"];
    expect(await isSsrfSafeResolved("https://mixed.example/", { lookup })).toBe(false);
  });

  it("allows hostnames that resolve only to public addresses", async () => {
    const lookup: DnsLookup = async () => ["93.184.216.34"];
    expect(await isSsrfSafeResolved("https://example.com/page", { lookup })).toBe(true);
    expect(
      await shouldAbortBrowserRequestResolved("https://example.com/page", "document", { lookup }),
    ).toBe(false);
  });

  it("fails closed when DNS returns no answers or throws", async () => {
    expect(
      await isSsrfSafeResolved("https://empty.example/", { lookup: async () => [] }),
    ).toBe(false);
    expect(
      await isSsrfSafeResolved("https://fail.example/", {
        lookup: async () => {
          throw new Error("DoH down");
        },
      }),
    ).toBe(false);
  });

  it("re-resolves redirect hop URLs with DNS before allowing continue (no cache)", async () => {
    let calls = 0;
    const lookup: DnsLookup = async (hostname) => {
      calls += 1;
      if (hostname === "public.example") return ["93.184.216.34"];
      if (hostname === "evil.example") return ["169.254.169.254"];
      return [];
    };
    expect(
      await shouldAbortBrowserRequestResolved("https://public.example/", "document", { lookup }),
    ).toBe(false);
    expect(
      await shouldAbortBrowserRequestResolved("https://public.example/next", "document", { lookup }),
    ).toBe(false);
    // Each hop double-resolves for rebinding stability.
    expect(calls).toBe(4);
    expect(
      await shouldAbortBrowserRequestResolved("https://evil.example/latest/meta-data/", "document", {
        lookup,
      }),
    ).toBe(true);
  });

  it("rejects unstable DNS answers (rebinding between double-lookup)", async () => {
    let n = 0;
    const lookup: DnsLookup = async () => {
      n += 1;
      return n % 2 === 1 ? ["93.184.216.34"] : ["169.254.169.254"];
    };
    expect(await isSsrfSafeResolved("https://flip.example/", { lookup })).toBe(false);
  });

  it("rejects non-http(s) Location targets when resolving redirects", () => {
    expect(resolveRedirectLocation("https://public.example/", "data:text/html,hi")).toBeNull();
    expect(resolveRedirectLocation("https://public.example/", "javascript:alert(1)")).toBeNull();
    expect(resolveRedirectLocation("https://public.example/", "vbscript:msgbox(1)")).toBeNull();
    expect(resolveRedirectLocation("https://public.example/", "file:///etc/passwd")).toBeNull();
    expect(resolveRedirectLocation("https://public.example/", "//169.254.169.254/")).toBeNull();
    expect(resolveRedirectLocation("https://public.example/", "https://ok.example/x")).toBe(
      "https://ok.example/x",
    );
  });

  it("parses Refresh headers", () => {
    expect(parseRefreshHeader("0; url=https://example.com/next")).toBe("https://example.com/next");
    expect(parseRefreshHeader('5;url="https://example.com/x"')).toBe("https://example.com/x");
    expect(parseRefreshHeader("0; https://example.com/y")).toBe("https://example.com/y");
  });

  it("pre-walks HTTP redirects and refuses a chain that lands on metadata", async () => {
    const lookup: DnsLookup = async (hostname) => {
      if (hostname === "public.example") return ["93.184.216.34"];
      return [];
    };
    const fetchImpl = async (input: string) => {
      if (input === "https://public.example/start") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    expect(
      await resolvePublicRedirectChain("https://public.example/start", { lookup, fetchImpl }),
    ).toBeNull();
  });

  it("does not treat Refresh on 2xx as a redirect hop", async () => {
    const lookup: DnsLookup = async () => ["93.184.216.34"];
    const fetchImpl = async (input: string) => {
      if (input === "https://public.example/start") {
        return new Response("ok", {
          status: 200,
          headers: { Refresh: "0; url=https://public.example/final" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    expect(
      await resolvePublicRedirectChain("https://public.example/start", { lookup, fetchImpl }),
    ).toBe("https://public.example/start");
  });

  it("pre-walks HTTP redirects to the final public document URL", async () => {
    const lookup: DnsLookup = async () => ["93.184.216.34"];
    const fetchImpl = async (input: string) => {
      if (input === "https://public.example/start") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://public.example/final" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    expect(
      await resolvePublicRedirectChain("https://public.example/start", { lookup, fetchImpl }),
    ).toBe("https://public.example/final");
  });
});

describe("search query sanitization", () => {
  it("strips controls and bounds length", () => {
    expect(sanitizeSearchQuery("  hello\u0000world  ")).toBe("helloworld");
    expect(sanitizeSearchQuery("")).toBeNull();
    expect(sanitizeSearchQuery("a".repeat(501))).toBeNull();
    expect(sanitizeSearchQuery(12)).toBeNull();
  });
});

describe("memory channel allowlist", () => {
  const a = "123456789012345678";
  const b = "234567890123456789";
  const c = "345678901234567890";
  it("allows any channel when unset; otherwise requires snowflake membership", () => {
    expect(channelAllowed(undefined, a)).toBe(true);
    expect(channelAllowed("", a)).toBe(true);
    expect(channelAllowed(`${a},${b}`, b)).toBe(true);
    expect(channelAllowed(`${a},${b}`, c)).toBe(false);
    // Short / non-snowflake allowlist entries are ignored (not valid tenants).
    expect(channelAllowed("123,456", "123")).toBe(false);
  });
});

describe("channel id + memory meta sanitize", () => {
  it("accepts Discord-length snowflakes only", () => {
    expect(isNonEmptyChannelId("123456789012345678")).toBe(true);
    expect(isNonEmptyChannelId("1234567890123456")).toBe(true); // 16 digits
    expect(isNonEmptyChannelId("12345")).toBe(false);
    expect(isNonEmptyChannelId("not-a-number")).toBe(false);
  });

  it("never lets meta overwrite reserved Vectorize keys", () => {
    expect(
      sanitizeMemoryMeta({
        channelId: "999999999999999999",
        kind: "evil",
        content: "nope",
        createdAt: "x",
        id: "y",
        method: "POST",
        path: "/api/x",
        extra: "drop-me",
      }),
    ).toEqual({ method: "POST", path: "/api/x" });
  });

  it("rejects free-form meta values (strict method/path charset)", () => {
    expect(sanitizeMemoryMeta({ method: "TRACE", path: "/ok" })).toEqual({ path: "/ok" });
    expect(sanitizeMemoryMeta({ method: "GET", path: "https://evil.example/" })).toEqual({
      method: "GET",
    });
    expect(sanitizeMemoryMeta({ method: "get", path: "/studio/api" })).toEqual({
      method: "GET",
      path: "/studio/api",
    });
  });
});

describe("capabilitySecretsReady", () => {
  it("requires four long, pairwise-distinct secrets", () => {
    expect(
      capabilitySecretsReady({
        SEARCH_SECRET: "a".repeat(16),
        FETCH_SECRET: "b".repeat(16),
        MEMORY_SECRET: "c".repeat(16),
        KNOWLEDGE_SECRET: "d".repeat(16),
      }),
    ).toBe(true);
    expect(
      capabilitySecretsReady({
        SEARCH_SECRET: "a".repeat(16),
        FETCH_SECRET: "a".repeat(16),
        MEMORY_SECRET: "c".repeat(16),
        KNOWLEDGE_SECRET: "d".repeat(16),
      }),
    ).toBe(false);
    expect(
      capabilitySecretsReady({
        SEARCH_SECRET: "a".repeat(16),
        FETCH_SECRET: "b".repeat(16),
        MEMORY_SECRET: "c".repeat(16),
        KNOWLEDGE_SECRET: "a".repeat(16),
      }),
    ).toBe(false);
    expect(
      capabilitySecretsReady({
        SEARCH_SECRET: "short",
        FETCH_SECRET: "b".repeat(16),
        MEMORY_SECRET: "c".repeat(16),
        KNOWLEDGE_SECRET: "d".repeat(16),
      }),
    ).toBe(false);
    expect(
      capabilitySecretsReady({
        SEARCH_SECRET: "a".repeat(16),
        FETCH_SECRET: "b".repeat(16),
        MEMORY_SECRET: "c".repeat(16),
      }),
    ).toBe(false);
  });
});

describe("DoH JSON validation", () => {
  it("fails closed on truncated or non-NOERROR DoH responses", async () => {
    const truncated: typeof fetch = async () =>
      new Response(JSON.stringify({ Status: 0, TC: true, Answer: [] }), { status: 200 });
    await expect(lookupDnsJson("example.com", truncated)).rejects.toThrow(/truncated/i);

    const nxdomain: typeof fetch = async () =>
      new Response(JSON.stringify({ Status: 3, TC: false, Answer: [] }), { status: 200 });
    await expect(lookupDnsJson("missing.example", nxdomain)).rejects.toThrow(/Status 3/);
  });
});
