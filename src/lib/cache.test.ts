import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import {
  cacheDir,
  CACHE_VERSION,
  isInheritanceSource,
  matchesBase,
  parseCacheEntry,
  pickPrevious,
  type CacheEntry,
} from "./cache";

function entry(headSha: string, mode: "deep" | "fast", analyzedAt: string): CacheEntry {
  const pr = makePr([ghFile("src/a.ts", "@@ -1 +1 @@\n-a\n+b")], { headSha });
  return {
    version: CACHE_VERSION,
    requestedMode: mode,
    pr,
    review: {
      mode,
      summary: "s",
      readingOrder: [],
      items: [],
      omitted: [],
      sentHunkIds: [],
      warnings: [],
      previous: null,
      delta: null,
      analyzedAt,
      costUsd: null,
      durationMs: null,
      toolCalls: null,
    },
  };
}

describe("parseCacheEntry", () => {
  it("accepts a current entry", () => {
    const e = entry("a".repeat(40), "fast", "2026-10-21T00:47:00.000Z");
    expect(parseCacheEntry(JSON.parse(JSON.stringify(e)))).not.toBeNull();
  });

  it("ignores entries from older versions (classified under earlier skip rules)", () => {
    for (const version of [1, 2]) {
      const old = { ...entry("a".repeat(40), "fast", "2026-10-21T00:47:00.000Z"), version };
      expect(parseCacheEntry(JSON.parse(JSON.stringify(old)))).toBeNull();
    }
  });

  it("ignores unknown versions and corrupt data instead of crashing", () => {
    expect(parseCacheEntry(null)).toBeNull();
    expect(parseCacheEntry("x")).toBeNull();
    expect(parseCacheEntry({ version: 99, pr: {}, review: {} })).toBeNull();
    expect(parseCacheEntry({ version: 1, pr: { meta: {} }, review: {} })).toBeNull();
    expect(parseCacheEntry({ version: CACHE_VERSION, pr: { meta: { title: "t" }, files: [] }, review: { items: [] } })).toBeNull();
  });
});

describe("pickPrevious", () => {
  const a = entry("a".repeat(40), "deep", "2026-10-21T01:00:00.000Z");
  const b = entry("b".repeat(40), "fast", "2026-10-21T03:00:00.000Z");
  const c = entry("c".repeat(40), "deep", "2026-10-21T02:00:00.000Z");
  const current = entry("d".repeat(40), "deep", "2026-10-21T04:00:00.000Z");

  it("picks the most recent entry of the same mode at a different head SHA", () => {
    expect(pickPrevious([a, b, c, current], "d".repeat(40), "deep")).toBe(c);
    expect(pickPrevious([a, b, c, current], "d".repeat(40), "fast")).toBe(b);
  });

  it("never falls back to the other mode", () => {
    expect(pickPrevious([a, c], "d".repeat(40), "fast")).toBeNull();
    expect(pickPrevious([b], "d".repeat(40), "deep")).toBeNull();
  });

  it("never picks the same head SHA", () => {
    expect(pickPrevious([current], "d".repeat(40), "deep")).toBeNull();
  });

  it("does not inherit from a deep request that actually ran in fast mode (too-large fallback)", () => {
    const fellBack = entry("e".repeat(40), "deep", "2026-10-21T05:00:00.000Z");
    fellBack.review.mode = "fast";
    expect(isInheritanceSource(fellBack, "deep")).toBe(false);
    expect(isInheritanceSource(fellBack, "fast")).toBe(false);
    // The older genuine deep entry is used instead.
    expect(pickPrevious([a, c, fellBack], "d".repeat(40), "deep")).toBe(c);
    expect(pickPrevious([fellBack], "d".repeat(40), "deep")).toBeNull();
  });

  it("does not inherit from an entry whose hunks have no anchorKey", () => {
    const unanchored = entry("f".repeat(40), "deep", "2026-10-21T06:00:00.000Z");
    expect(isInheritanceSource(unanchored, "deep")).toBe(true);
    delete unanchored.pr.files[0].hunks[0].anchorKey;
    expect(isInheritanceSource(unanchored, "deep")).toBe(false);
    expect(pickPrevious([c, unanchored], "d".repeat(40), "deep")).toBe(c);
  });
});

describe("cache location and base validation", () => {
  it("honours PR_LENS_CACHE_DIR, defaulting to .cache/reviews in the project", () => {
    vi.stubEnv("PR_LENS_CACHE_DIR", "");
    expect(cacheDir()).toBe(path.join(process.cwd(), ".cache", "reviews"));
    vi.stubEnv("PR_LENS_CACHE_DIR", "/var/tmp/pr-lens-eval");
    expect(cacheDir()).toBe("/var/tmp/pr-lens-eval");
    vi.unstubAllEnvs();
  });

  it("rejects an entry made against another base commit, but keeps entries without one readable", () => {
    const withBase = entry("a".repeat(40), "fast", "2026-10-21T00:00:00.000Z");
    withBase.pr.meta.baseSha = "1".repeat(40);
    expect(matchesBase(withBase, { baseSha: "1".repeat(40) })).toBe(true);
    expect(matchesBase(withBase, { baseSha: "2".repeat(40) })).toBe(false);

    const legacy = entry("a".repeat(40), "fast", "2026-10-21T00:00:00.000Z");
    delete legacy.pr.meta.baseSha;
    expect(matchesBase(legacy, { baseSha: "2".repeat(40) })).toBe(true);
  });
});
