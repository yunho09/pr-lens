import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import type { RunClaude } from "@/lib/claude";
import { triagePr } from "@/lib/triage";
import type { Priority, TriageItem } from "@/lib/types";
import { buildReadingPlan, defaultOnlyNew, NO_ACTIVITY, pushActivity } from "./review-model";

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
