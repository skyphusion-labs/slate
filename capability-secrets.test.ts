import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Guard against capability-secret mixups the adversarial auditor keeps inventing. */
describe("bot.mjs capability secret routing", () => {
  const src = readFileSync(new URL("./bot.mjs", import.meta.url), "utf8");

  it("uses MEMORY_SECRET for /memory/* and KNOWLEDGE_SECRET for /knowledge/*", () => {
    expect(src).toMatch(/memory\/search[\s\S]{0,500}memorySecret/);
    expect(src).toMatch(/memory\/index[\s\S]{0,400}CFG\.memorySecret/);
    expect(src).toMatch(/knowledge\/search[\s\S]{0,400}CFG\.knowledgeSecret/);
    expect(src).toMatch(/knowledge\/index[\s\S]{0,400}CFG\.knowledgeSecret/);
  });

  it("does not send SEARCH_SECRET to /memory or /fetch", () => {
    const memoryBlock = src.match(/if \(name === 'search_memory'\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const fetchBlock = src.match(/if \(name === 'fetch_page'\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(memoryBlock.length).toBeGreaterThan(80);
    expect(fetchBlock.length).toBeGreaterThan(80);
    expect(memoryBlock).not.toMatch(/CFG\.searchSecret/);
    expect(fetchBlock).not.toMatch(/CFG\.searchSecret/);
    expect(fetchBlock).toMatch(/CFG\.fetchSecret/);
    expect(memoryBlock).toMatch(/memorySecret/);
  });
});
