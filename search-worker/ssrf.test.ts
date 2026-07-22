import { describe, expect, it } from "vitest";
import {
  isBlockedIp,
  isSsrfSafe,
  isSsrfSafeResolved,
  MAX_FETCH_URL_LENGTH,
  resolvePublicRedirectChain,
  shouldAbortBrowserRequest,
  shouldAbortBrowserRequestResolved,
  type DnsLookup,
} from "./src/ssrf";

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
    expect(calls).toBe(2);
    expect(
      await shouldAbortBrowserRequestResolved("https://evil.example/latest/meta-data/", "document", {
        lookup,
      }),
    ).toBe(true);
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
