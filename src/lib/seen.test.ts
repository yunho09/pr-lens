import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import {
  parseSeenKeys,
  seenKey,
  seenFromStorageEvent,
  seenHunkIds,
  seenStorageKey,
  serializeSeenKeys,
  toggleSeenKey,
} from "./seen";

const hunksOf = (pr: ReturnType<typeof makePr>) => pr.files.flatMap((f) => f.hunks);

describe("봤음 carry-over", () => {
  const v1 = makePr([
    ghFile("src/a.ts", "@@ -1 +1 @@\n-a\n+b"),
    ghFile("src/b.ts", "@@ -5 +5 @@\n-x\n+y"),
  ]);

  it("keeps unchanged hunks checked and un-checks changed ones after a push", () => {
    // Reviewer checked both hunks on the first version.
    let fps = new Set<string>();
    for (const h of hunksOf(v1)) fps = toggleSeenKey(fps, seenKey(h));
    const stored = serializeSeenKeys(fps);

    // New push: a.ts unchanged but moved, b.ts edited, plus a new file first in the list.
    const v2 = makePr([
      ghFile("src/new.ts", "@@ -0,0 +1 @@\n+n"),
      ghFile("src/a.ts", "@@ -40 +40 @@\n-a\n+b"),
      ghFile("src/b.ts", "@@ -5 +5 @@\n-x\n+z"),
    ]);
    const seen = seenHunkIds(parseSeenKeys(stored), hunksOf(v2));
    expect([...seen]).toEqual(["f1h0"]); // only the unchanged a.ts hunk
  });

  it("does not carry 봤음 over to the same edit in another function", () => {
    const at = (section: string) => `@@ -3,4 +3,3 @@ ${section}\n   const t = req.token;\n-  verify(t);\n   return ok();`;
    const before = makePr([ghFile("src/server.js", at("function legacyHandler(req) {"))]);
    let keys = new Set<string>();
    for (const h of hunksOf(before)) keys = toggleSeenKey(keys, seenKey(h));
    const after = makePr([ghFile("src/server.js", at("export function handler(req) {"))]);
    expect(hunksOf(after)[0].fingerprint).toBe(hunksOf(before)[0].fingerprint);
    expect(seenHunkIds(keys, hunksOf(after)).size).toBe(0);
    expect([...seenHunkIds(keys, hunksOf(before))]).toEqual(["f0h0"]);
  });

  it("toggle is pure and reversible", () => {
    const start = new Set(["x"]);
    const added = toggleSeenKey(start, "y");
    expect([...start]).toEqual(["x"]);
    expect([...added].sort()).toEqual(["x", "y"]);
    expect([...toggleSeenKey(added, "y")]).toEqual(["x"]);
  });

  it("ignores old-format or corrupt storage values", () => {
    expect(parseSeenKeys(null).size).toBe(0);
    expect(parseSeenKeys("{not json").size).toBe(0);
    expect(parseSeenKeys('{"f0h0":true}').size).toBe(0);
    expect([...parseSeenKeys('["abc", 3, null]')]).toEqual(["abc"]);
  });

  it("keys storage per PR, not per head SHA", () => {
    expect(seenStorageKey("vercel", "swr", 4298)).toBe("pr-lens:seen:v3:vercel/swr/4298");
  });

  it("follows 봤음 changes made in another tab of the same PR", () => {
    const key = seenStorageKey("acme", "app", 42);
    expect([...seenFromStorageEvent({ key, newValue: '["fp1","fp2"]' }, key)!]).toEqual(["fp1", "fp2"]);
    // Removed or the whole storage cleared: nothing is seen any more.
    expect(seenFromStorageEvent({ key, newValue: null }, key)!.size).toBe(0);
    expect(seenFromStorageEvent({ key: null, newValue: null }, key)!.size).toBe(0);
    // Another PR's key: ignore.
    expect(seenFromStorageEvent({ key: seenStorageKey("acme", "app", 7), newValue: '["x"]' }, key)).toBeNull();
  });
});
