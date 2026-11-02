import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import type { RunClaude } from "@/lib/claude";
import { triagePr } from "@/lib/triage";
import type { Priority, TriageItem } from "@/lib/types";
import {
  areaTarget,
  buildAreaMap,
  buildReadingPlan,
  changesNote,
  CHANGES_BEFORE_FEATURE,
  CHANGES_NOT_RETURNED,
  defaultOnlyNew,
  firstRenderedHunk,
  NO_ACTIVITY,
  priorityCounts,
  pushActivity,
} from "./review-model";

function item(hunkId: string, priority: Priority, isNew = false): TriageItem {
  return {
    hunkId,
    priority,
    category: "logic",
    title: hunkId,
    explain: "",
    why: "",
    check: "",
    highlight: [],
    lookAt: [],
    isNew,
    source: isNew ? "ai" : "inherited",
  };
}

const ids = (items: TriageItem[]) => items.map((i) => i.hunkId);

describe("defaultOnlyNew", () => {
  const previous = { headSha: "b".repeat(40), analyzedAt: "2026-10-21T05:03:00.000Z" };
  const reanalyzed = { ...item("r1", "must"), source: "ai" as const };

  it("is on only when a previous analysis exists and the filter would both show and hide something", () => {
    expect(defaultOnlyNew({ previous, items: [item("n1", "skim", true), item("o1", "should")] })).toBe(true);
    // Unchanged but classified in this run (was unclassified before): still worth filtering to.
    expect(defaultOnlyNew({ previous, items: [reanalyzed, item("o1", "skim")] })).toBe(true);
    // An inherited must is never hidden, so it gives the filter nothing to do.
    expect(defaultOnlyNew({ previous, items: [item("n1", "skim", true), item("o1", "must")] })).toBe(false);
    // Nothing analyzed in this run (reuse), or nothing inherited (full re-analysis): nothing to filter.
    expect(defaultOnlyNew({ previous, items: [item("o1", "should")] })).toBe(false);
    expect(defaultOnlyNew({ previous, items: [item("n1", "must", true), reanalyzed] })).toBe(false);
    expect(defaultOnlyNew({ previous: null, items: [item("n1", "must", true), item("o1", "must")] })).toBe(false);
  });
});

describe("buildReadingPlan", () => {
  const result = {
    readingOrder: ["m2", "s1", "m1", "m1", "ghost"],
    items: [item("m1", "must", true), item("k1", "skim"), item("m2", "must"), item("s1", "should", true), item("m3", "must"), item("k2", "skim", true)],
  };

  it("orders sections by readingOrder and appends items it misses", () => {
    const plan = buildReadingPlan(result, false);
    expect(ids(plan.steps)).toEqual(["m2", "s1", "m1"]);
    expect(ids(plan.must)).toEqual(["m2", "m1", "m3"]);
    expect(ids(plan.should)).toEqual(["s1"]);
    expect(ids(plan.skim)).toEqual(["k1", "k2"]);
    expect(plan.hidden).toEqual({ must: 0, should: 0, skim: 0 });
  });

  it("keeps new items and every must (even inherited) in steps and sections when filtering", () => {
    const plan = buildReadingPlan(result, true);
    expect(ids(plan.steps)).toEqual(["m2", "s1", "m1"]);
    expect(ids(plan.must)).toEqual(["m2", "m1", "m3"]);
    expect(ids(plan.should)).toEqual(["s1"]);
    expect(ids(plan.skim)).toEqual(["k2"]);
    expect(plan.hidden).toEqual({ must: 0, should: 0, skim: 1 });
  });

  it("hides inherited should items but keeps an unchanged hunk Claude classified in this run", () => {
    const more = {
      readingOrder: ["s2", "s3"],
      items: [...result.items, item("s2", "should"), { ...item("s3", "should"), source: "ai" as const }],
    };
    const plan = buildReadingPlan(more, true);
    expect(ids(plan.should)).toEqual(["s3", "s1"]);
    expect(ids(plan.steps)).toEqual(["s3"]);
    expect(plan.hidden).toEqual({ must: 0, should: 1, skim: 1 });
  });

  it("shows the inherited must of the real swr#4298 deep re-analysis by default", () => {
    // Item list of .cache/reviews/vercel__swr__4298__eb2cbbd…__deep.json (inherited must f7h1).
    const rows: Array<[string, Priority, boolean]> = [
      ["f0h0", "skim", false], ["f1h0", "skim", false], ["f2h0", "should", true], ["f2h1", "should", false],
      ["f2h2", "skim", false], ["f3h0", "skim", false], ["f3h1", "skim", false], ["f3h2", "should", false],
      ["f3h3", "must", true], ["f3h4", "should", true], ["f3h5", "should", false], ["f4h0", "should", false],
      ["f5h0", "skim", false], ["f5h1", "should", false], ["f5h2", "skim", false], ["f6h0", "should", false],
      ["f6h1", "should", false], ["f7h0", "skim", false], ["f7h1", "must", false], ["f8h0", "should", true],
      ["f8h1", "should", true], ["f8h2", "should", true], ["f9h0", "should", true],
    ];
    const swr = {
      previous: { headSha: "e4cfaed5dc8e8d96e55a65320aee12626cbb4cbd", analyzedAt: "2026-10-20T16:13:29.678Z" },
      readingOrder: "f2h0,f2h1,f3h2,f3h4,f3h3,f3h5,f5h1,f4h0,f6h0,f6h1,f7h1,f8h0,f8h1,f8h2,f9h0".split(","),
      items: rows.map(([id, priority, isNew]) => item(id, priority, isNew)),
    };
    const onlyNew = defaultOnlyNew(swr);
    expect(onlyNew).toBe(true);
    const plan = buildReadingPlan(swr, onlyNew);
    expect(ids(plan.must)).toEqual(["f3h3", "f7h1"]);
    expect(ids(plan.steps)).toContain("f7h1");
    expect(plan.hidden.must).toBe(0);
  });
});

describe("새로 분석한 것만 보기 after an incremental run", () => {
  // Previous run: auth must, ttl hunk unclassified (fallback), log hunk omitted (no item), test skim.
  const H_AUTH = "@@ -10,3 +10,3 @@\n a\n-if (!ok) throw err;\n+if (!ok) return;\n b";
  const H_CACHE = "@@ -40,3 +40,3 @@\n x\n-ttl = 60\n+ttl = 600\n y";
  const H_LOG = "@@ -80,2 +80,3 @@\n z\n+log('hit')\n w";
  const H_TEST = "@@ -1 +1 @@\n-it('a')\n+it('b')";
  const files = [
    ghFile("src/auth.ts", H_AUTH),
    ghFile("src/cache.ts", `${H_CACHE}\n${H_LOG}`),
    ghFile("src/a.test.ts", H_TEST),
  ];
  const before = makePr(files, { headSha: "1".repeat(40) });
  const prevItem = (hunkId: string, priority: Priority, source: TriageItem["source"] = "ai"): TriageItem => ({
    ...item(hunkId, priority),
    source,
  });
  const previous = {
    pr: before,
    review: {
      summary: "이전 요약",
      readingOrder: ["f0h0"],
      analyzedAt: "2026-10-20T05:03:00.000Z",
      items: [prevItem("f0h0", "must"), prevItem("f1h0", "skim", "fallback"), prevItem("f2h0", "skim")],
    },
  };

  it("shows the hunks sent to Claude in this run (including re-sent unclassified/omitted ones) plus inherited must", async () => {
    // New push: the same hunks plus a new file.
    const current = makePr([...files, ghFile("src/new.ts", "@@ -0,0 +1 @@\n+export const n = 1;")]);
    const run: RunClaude = async (_s, _p, schema) => ({
      data: schema.parse({
        summary: "s",
        readingOrder: ["f1h0", "f1h1"],
        items: [
          { hunkId: "f1h0", priority: "must", category: "logic", title: "ttl", explain: "", why: "w", check: "", highlight: [], lookAt: [] },
          { hunkId: "f1h1", priority: "should", category: "logic", title: "log", explain: "", why: "w", check: "", highlight: [], lookAt: [] },
          { hunkId: "f3h0", priority: "skim", category: "logic", title: "new", explain: "", why: "w", check: "", highlight: [], lookAt: [] },
        ],
      }),
      costUsd: null,
      durationMs: null,
      toolCalls: 0,
      permissionDenials: 0,
    });
    const review = await triagePr(current, { runClaude: run, previous, allowInherit: true });
    expect(review.sentHunkIds).toEqual(["f1h0", "f1h1", "f3h0"]);
    expect(review.delta).toEqual({ new: 1, unchanged: 4, resolved: 0, reanalyzed: 2 });

    const result = { ...review, analyzedAt: "2026-10-21T00:00:00.000Z", cached: false };
    const onlyNew = defaultOnlyNew(result);
    expect(onlyNew).toBe(true);
    const plan = buildReadingPlan(result, onlyNew);
    const shown = [...plan.must, ...plan.should, ...plan.skim].map((i) => i.hunkId);
    const inheritedMust = review.items.filter((i) => i.source === "inherited" && i.priority === "must").map((i) => i.hunkId);
    expect(inheritedMust).toEqual(["f0h0"]);
    expect(new Set(shown)).toEqual(new Set([...review.sentHunkIds, ...inheritedMust]));
    expect(ids(plan.must)).toEqual(["f1h0", "f0h0"]); // the formerly unclassified hunk is now must, next to the inherited one
    expect(ids(plan.steps)).toEqual(["f1h0", "f1h1", "f0h0"]);
    expect(plan.hidden).toEqual({ must: 0, should: 0, skim: 1 });
  });
});

describe("pushActivity", () => {
  it("counts distinct files read and searches, keeping the latest entries", () => {
    let state = NO_ACTIVITY;
    state = pushActivity(state, { tool: "Read", target: "src/a.ts" }, 3);
    state = pushActivity(state, { tool: "Grep", target: "unload\\(" }, 3);
    state = pushActivity(state, { tool: "Read", target: "src/a.ts" }, 3);
    state = pushActivity(state, { tool: "Glob", target: "test/**/*.ts" }, 3);
    state = pushActivity(state, { tool: "Read", target: "src/b.ts" }, 3);

    expect(state.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(state.searches).toBe(2);
    expect(state.total).toBe(5);
    expect(state.recent.map((a) => [a.seq, a.tool])).toEqual([
      [3, "Read"],
      [4, "Glob"],
      [5, "Read"],
    ]);
    expect(NO_ACTIVITY.total).toBe(0);
  });
});

describe("buildAreaMap", () => {
  const patch = "@@ -1 +1 @@\n-a\n+b";
  const file = (name: string, additions = 1, deletions = 1, filePatch: string | undefined = patch) =>
    ghFile(name, filePatch, { additions, deletions, changes: additions + deletions });
  const areas = (names: string[]) => buildAreaMap(makePr(names.map((n) => file(n))).files, []).map((r) => r.area);

  it("uses the first path segment", () => {
    expect(areas(["harness/api/a.json", "tests/e2e/a.spec.ts"])).toEqual(["harness", "tests"]);
  });

  it("uses two segments under a generic source root", () => {
    expect(
      areas(["src/components/a.ts", "packages/core/a.ts", "apps/web/a.ts", "app/api/a.ts", "lib/utils/a.ts"]),
    ).toEqual(["src/components", "packages/core", "apps/web", "app/api", "lib/utils"]);
  });

  it("keeps a file directly under a generic root in that root", () => {
    expect(areas(["src/index.ts", "lib/a.ts"])).toEqual(["src", "lib"]);
  });

  it("puts root-level files in (루트)", () => {
    expect(areas(["README.md", "package.json"])).toEqual(["(루트)"]);
  });

  it("merges files of one area and sums their numbers", () => {
    const pr = makePr([file("src/a/x.ts", 3, 1), file("src/a/y.ts", 4, 2), file("src/b/z.ts", 1, 0)]);
    expect(buildAreaMap(pr.files, [])).toMatchObject([
      { area: "src/a", fileCount: 2, additions: 7, deletions: 3 },
      { area: "src/b", fileCount: 1, additions: 1, deletions: 0 },
    ]);
  });

  it("counts skipped and unavailable files in the totals, with no jump target", () => {
    const pr = makePr([
      file("package-lock.json", 500, 400),
      ghFile("assets/logo.bin", undefined, { additions: 0, deletions: 0, changes: 0, status: "modified" }),
      file("src/a/x.ts", 1, 1),
    ]);
    expect(pr.files.map((f) => f.classification.kind)).toEqual(["skip", "unavailable", "keep"]);
    const rows = buildAreaMap(pr.files, [item("f2h0", "must")]);
    expect(rows.map((r) => [r.area, r.fileCount, r.additions + r.deletions, r.firstHunkIds, r.unanalyzed])).toEqual([
      ["(루트)", 1, 900, [], 0],
      ["src/a", 1, 2, ["f2h0"], 0],
      ["assets", 1, 0, [], 1],
    ]);
  });

  it("counts priorities and lists only hunks that have an item", () => {
    const pr = makePr([file("src/a/x.ts", 1, 1, `${patch}\n@@ -9 +9 @@\n-c\n+d`), file("src/a/y.ts"), file("src/a/z.ts")]);
    const [row] = buildAreaMap(pr.files, [item("f0h0", "must"), item("f0h1", "should"), item("f1h0", "skim")]);
    expect(row).toMatchObject({ must: 1, should: 1, skim: 1, firstHunkIds: ["f0h0", "f0h1", "f1h0"] });
  });

  it("counts fallback items, omitted hunks and unavailable files as unanalyzed, never as skim", () => {
    const pr = makePr([
      file("src/a/x.ts", 1, 1, `${patch}\n@@ -9 +9 @@\n-c\n+d`),
      file("src/a/omitted.ts"),
      ghFile("src/a/logo.bin", undefined, { additions: 0, deletions: 0, changes: 0 }),
      file("yarn.lock"),
    ]);
    expect(pr.files.map((f) => f.classification.kind)).toEqual(["keep", "keep", "unavailable", "skip"]);
    const fallback = { ...item("f0h0", "skim"), source: "fallback" as const };
    const rows = buildAreaMap(pr.files, [fallback, item("f0h1", "skim")]);
    expect(rows.find((r) => r.area === "src/a")).toMatchObject({ skim: 1, unanalyzed: 3, firstHunkIds: ["f0h0", "f0h1"] });
    // A skipped file is a rule's decision, shown in ⚫: not unanalyzed.
    expect(rows.find((r) => r.area === "(루트)")).toMatchObject({ unanalyzed: 0 });
  });

  it("sorts by additions plus deletions, keeping PR order on a tie", () => {
    const pr = makePr([file("b/x", 1, 1), file("a/x", 2, 0), file("c/x", 9, 9)]);
    expect(buildAreaMap(pr.files, []).map((r) => r.area)).toEqual(["c", "b", "a"]);
  });

  const many = (n: number) => makePr(Array.from({ length: n }, (_, i) => file(`d${i}/x`, 100 - i, 0)));

  it("keeps 8 areas as they are", () => {
    const rows = buildAreaMap(many(8).files, []);
    expect(rows).toHaveLength(8);
    expect(rows[7].area).toBe("d7");
  });

  const allSkim = (n: number) => Array.from({ length: n }, (_, i) => item(`f${i}h0`, "skim"));

  it("merges past 8 rows into one last row that keeps the totals honest", () => {
    const pr = many(11);
    const rows = buildAreaMap(pr.files, allSkim(11));
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 7).map((r) => r.area)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6"]);
    expect(rows[7]).toEqual({
      area: "그 외 4개 영역",
      mergedAreas: ["d7", "d8", "d9", "d10"],
      fileCount: 4,
      additions: 93 + 92 + 91 + 90,
      deletions: 0,
      must: 0,
      should: 0,
      skim: 4,
      unanalyzed: 0,
      firstHunkIds: ["f7h0", "f8h0", "f9h0", "f10h0"],
    });
    const sum = (key: "additions" | "fileCount") => rows.reduce((n, r) => n + r[key], 0);
    expect(sum("additions")).toBe(pr.files.reduce((n, f) => n + f.additions, 0));
    expect(sum("fileCount")).toBe(11);
  });

  it("keeps small sensitive areas out of the merged row, showing kept rows by size", () => {
    const pr = many(11);
    const items = allSkim(11);
    items[10] = item("f10h0", "must");
    items[9] = { ...item("f9h0", "skim"), source: "fallback" };
    items[8] = item("f8h0", "should");
    const rows = buildAreaMap(pr.files, items);
    expect(rows.map((r) => r.area)).toEqual(["d0", "d1", "d2", "d3", "d8", "d9", "d10", "그 외 4개 영역"]);
    expect(rows[7].mergedAreas).toEqual(["d4", "d5", "d6", "d7"]);
  });

  it("keeps the sensitive totals on the merged row when there are too many sensitive areas", () => {
    const pr = many(11);
    const rows = buildAreaMap(pr.files, Array.from({ length: 11 }, (_, i) => item(`f${i}h0`, "must")));
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 7).map((r) => r.area)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6"]);
    expect(rows[7]).toMatchObject({ must: 4, mergedAreas: ["d7", "d8", "d9", "d10"] });
    expect(rows.reduce((n, r) => n + r.must, 0)).toBe(11);
  });

  it("ranks a small 🔴 area above larger 🟡 and 🟣 areas when too many areas are sensitive", () => {
    const pr = many(11);
    const items = Array.from({ length: 11 }, (_, i) => item(`f${i}h0`, "should"));
    items[10] = item("f10h0", "must");
    items[1] = { ...item("f1h0", "skim"), source: "fallback" };
    const rows = buildAreaMap(pr.files, items);
    expect(rows.map((r) => r.area)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d10", "그 외 4개 영역"]);
    expect(rows[7]).toMatchObject({ must: 0, should: 4, mergedAreas: ["d6", "d7", "d8", "d9"] });
  });

  it("keeps 🟡 and 🟣 areas above areas with neither, by size among equals", () => {
    const pr = many(11);
    const items = allSkim(11);
    items[9] = item("f9h0", "should");
    items[10] = { ...item("f10h0", "skim"), source: "fallback" };
    const rows = buildAreaMap(pr.files, items);
    expect(rows.map((r) => r.area)).toEqual(["d0", "d1", "d2", "d3", "d4", "d9", "d10", "그 외 4개 영역"]);
  });

  it("has nothing to merge within 8 rows, so no merged names", () => {
    expect(buildAreaMap(many(8).files, allSkim(8)).every((r) => r.mergedAreas === undefined)).toBe(true);
  });
});

describe("firstRenderedHunk", () => {
  const plan = buildReadingPlan(
    {
      readingOrder: ["m2", "m1", "s1"],
      items: [item("m1", "must", true), item("m2", "must", true), item("s1", "should", true), item("k1", "skim", true), item("old", "skim")],
    },
    true,
  );

  it("picks the first card in reading order, priority first", () => {
    expect(firstRenderedHunk(["k1", "s1", "m1", "m2"], plan)).toBe("m2");
    expect(firstRenderedHunk(["k1", "s1"], plan)).toBe("s1");
    expect(firstRenderedHunk(["k1"], plan)).toBe("k1");
  });

  it("ignores cards the filter hides, and returns null when none is left", () => {
    expect(firstRenderedHunk(["old", "k1"], plan)).toBe("k1");
    expect(firstRenderedHunk(["old"], plan)).toBeNull();
    expect(firstRenderedHunk([], plan)).toBeNull();
  });
});

describe("priorityCounts", () => {
  it("counts the group's items by priority and ignores ids without one", () => {
    const items = [item("a", "must"), item("b", "skim"), item("c", "skim"), item("d", "should")];
    expect(priorityCounts(["a", "b", "c", "ghost"], items)).toEqual({ must: 1, should: 0, skim: 2, unanalyzed: 0 });
  });

  it("counts a fallback item as unanalyzed, not skim", () => {
    const items = [item("a", "skim"), { ...item("b", "skim"), source: "fallback" as const }];
    expect(priorityCounts(["a", "b"], items)).toEqual({ must: 0, should: 0, skim: 1, unanalyzed: 1 });
  });
});

describe("changesNote", () => {
  const items = [item("a", "must")];

  it("says nothing when there are groups, or nothing to group", () => {
    expect(changesNote({ changes: [{ title: "t", detail: "", hunkIds: ["a"] }], items })).toBeNull();
    expect(changesNote({ changes: [], items: [] })).toBeNull();
    expect(changesNote({ items: [] })).toBeNull();
  });

  it("explains a result made before groups existed: changes is undefined", () => {
    expect(CHANGES_BEFORE_FEATURE).toBe("이 결과는 '한 일' 목록을 만들기 전에 분석했습니다. 다시 분석하면 볼 수 있습니다.");
    expect(changesNote({ items })).toBe(CHANGES_BEFORE_FEATURE);
  });

  it("does not blame age for an empty list: nothing came back", () => {
    expect(changesNote({ changes: [], items })).toBe(CHANGES_NOT_RETURNED);
  });
});

describe("areaTarget", () => {
  const fallback = { ...item("fb", "skim", true), source: "fallback" as const };
  const plan = buildReadingPlan({ readingOrder: ["m"], items: [item("m", "must", true), item("k", "skim", true), fallback, item("old", "should")] }, true);
  const row = (fields: Partial<Parameters<typeof areaTarget>[0]>) => ({ firstHunkIds: [], must: 0, should: 0, unanalyzed: 0, ...fields });

  it("sends a row with 🔴 or 🟡 to its first card, whatever else it holds", () => {
    expect(areaTarget(row({ firstHunkIds: ["k", "fb", "m"], must: 1, unanalyzed: 1 }), plan, 1)).toEqual({ kind: "card", hunkId: "m" });
  });

  it("sends a skim-only row to its first card", () => {
    expect(areaTarget(row({ firstHunkIds: ["k"] }), plan, 1)).toEqual({ kind: "card", hunkId: "k" });
  });

  it("sends a row showing only 🟣 to its own fallback card, not an ordinary ⚪ card before it", () => {
    expect(areaTarget(row({ firstHunkIds: ["k", "fb"], unanalyzed: 1 }), plan, 1)).toEqual({ kind: "card", hunkId: "fb" });
  });

  it("sends a row showing only 🟣 with no fallback card of its own to the 🟣 section", () => {
    expect(areaTarget(row({ firstHunkIds: ["k"], unanalyzed: 1 }), plan, 1)).toEqual({ kind: "attention" });
    expect(areaTarget(row({ unanalyzed: 1 }), plan, 1)).toEqual({ kind: "attention" });
  });

  it("sends a row whose 🟡 cards are filtered out to the 🟣 section when it also holds 🟣", () => {
    expect(areaTarget(row({ firstHunkIds: ["old"], should: 1, unanalyzed: 1 }), plan, 1)).toEqual({ kind: "attention" });
  });

  it("has no target when the 🟣 section would be empty or the row has nothing on screen", () => {
    expect(areaTarget(row({ unanalyzed: 1 }), plan, 0)).toBeNull();
    expect(areaTarget(row({ firstHunkIds: ["old"], should: 1 }), plan, 1)).toBeNull();
    expect(areaTarget(row({}), plan, 1)).toBeNull();
  });
});
