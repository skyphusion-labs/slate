import { describe, expect, it } from "vitest";
import { isSsrfSafe, shouldAbortBrowserRequest } from "./src/ssrf";

describe("search-worker SSRF filtering", () => {
  it("allows public http and https URLs", () => {
    expect(isSsrfSafe("https://example.com/page")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/page", "document")).toBe(false);
  });

  it("blocks redirect-chain document requests to private and metadata hosts", () => {
    for (const redirectedUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.8/admin",
      "http://172.16.1.10/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(shouldAbortBrowserRequest(redirectedUrl, "document"), redirectedUrl).toBe(true);
    }
  });

  it("still blocks high-volume subresources from public hosts", () => {
    expect(shouldAbortBrowserRequest("https://example.com/image.jpg", "image")).toBe(true);
    expect(shouldAbortBrowserRequest("https://example.com/app.css", "stylesheet")).toBe(true);
  });
});
