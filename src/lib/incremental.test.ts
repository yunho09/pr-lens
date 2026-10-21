import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import type { RunClaude } from "./claude";
import { FULL_REANALYSIS_RATIO, planIncremental, type PreviousAnalysis } from "./incremental";
import { triagePr } from "./triage";
import type { TriageOutput } from "./triage-schema";
import type { PrData, TriageItem } from "./types";

const H_AUTH = "@@ -10,3 +10,3 @@\n a\n-if (!ok) throw err;\n+if (!ok) return;\n b";
const H_CACHE = "@@ -40,3 +40,3 @@\n x\n-ttl = 60\n+ttl = 600\n y";
const H_LOG = "@@ -80,2 +80,3 @@\n z\n+log('hit')\n w";
const H_TEST = "@@ -1 +1 @@\n-it('a')\n+it('b')";

function previousPr(): PrData {
  return makePr(
    [
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", `${H_CACHE}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ],
    { headSha: "1".repeat(40) },
  );
}

function prevItem(hunkId: string, priority: TriageItem["priority"], extra: Partial<TriageItem> = {}): TriageItem {
  return {
    hunkId,
    priority,
    category: "logic",
    title: `prev-${hunkId}`,
    explain: "e",
    why: "w",
    check: "",
    highlight: [],
    lookAt: [],
    isNew: false,
    source: "ai",
    ...extra,
  };
}

type RawItem = TriageOutput["items"][number];
const raw = (hunkId: string, priority: RawItem["priority"]): RawItem => ({
  hunkId,
  priority,
  category: "logic",
  title: `new-${hunkId}`,
  explain: "e",
  why: "w",
  check: "?",
  highlight: [],
  lookAt: [],
});

function previous(pr = previousPr(), items?: TriageItem[]): PreviousAnalysis {
  return {
    pr,
    review: {
      summary: "이전 요약",
      readingOrder: ["f0h0", "f1h0"],
      analyzedAt: "2026-10-20T05:03:00.000Z",
      items: items ?? [
        prevItem("f0h0", "must", { highlight: [{ side: "new", line: 11 }, { side: "old", line: 11 }] }),
        prevItem("f1h0", "should"),
        prevItem("f1h1", "skim"),
        prevItem("f2h0", "skim"),
      ],
    },
  };
}

describe("planIncremental", () => {
  it("inherits unchanged hunks with ids re-targeted and highlights shifted, sends only changed ones", () => {
    // Current: auth hunk moved down 5 lines (unchanged), cache ttl changed, a new file, log + test unchanged.
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH.replace("@@ -10,3 +10,3 @@", "@@ -15,3 +15,3 @@")),
      ghFile("src/new.ts", "@@ -0,0 +1 @@\n+export const n = 1;"),
      ghFile("src/cache.ts", `${H_CACHE.replace("ttl = 600", "ttl = 900")}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    const plan = planIncremental(current, previous(), { allowInherit: true });

    expect(plan.kind).toBe("partial");
    expect(plan.sendIds).toEqual(["f1h0", "f2h0"]); // new file + changed ttl hunk
    expect(plan.inherited.map((i) => [i.hunkId, i.title, i.source, i.isNew])).toEqual([
      ["f0h0", "prev-f0h0", "inherited", false],
      ["f2h1", "prev-f1h1", "inherited", false],
      ["f3h0", "prev-f2h0", "inherited", false],
    ]);
    // Moved by +5 on both sides.
    expect(plan.inherited[0].highlight).toEqual([
      { side: "new", line: 16 },
      { side: "old", line: 16 },
    ]);
    expect(plan.delta).toEqual({ new: 2, unchanged: 3, resolved: 1 });
    expect(plan.previous).toEqual({ headSha: "1".repeat(40), analyzedAt: "2026-10-20T05:03:00.000Z" });
    // Previous order f0h0 (auth, inherited → f0h0) and f1h0 (old ttl hunk, gone).
    expect(plan.mappedReadingOrder).toEqual(["f0h0"]);
    expect([...plan.newHunkIds]).toEqual(["f1h0", "f2h0"]);
  });

  it("falls back to a full analysis when more than 70% of kept hunks changed", () => {
    expect(FULL_REANALYSIS_RATIO).toBe(0.7);
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH.replace("return;", "return null;")),
      ghFile("src/cache.ts", `${H_CACHE.replace("600", "700")}\n${H_LOG.replace("hit", "miss")}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    // 3 of 4 changed = 75% > 70%.
    const plan = planIncremental(current, previous(), { allowInherit: true });
    expect(plan.kind).toBe("full");
    expect(plan.inherited).toEqual([]);
    expect(plan.sendIds).toEqual(["f0h0", "f1h0", "f1h1", "f2h0"]);
    expect(plan.delta).toEqual({ new: 3, unchanged: 1, resolved: 3 });
  });

  it("stays partial at exactly 70% or less", () => {
    const pr10 = (changed: number) =>
      makePr(
        Array.from({ length: 10 }, (_, i) =>
          ghFile(`src/f${i}.ts`, `@@ -1 +1 @@\n-a${i}\n+b${i}${i < changed ? "!" : ""}`),
        ),
      );
    const prev = pr10(0);
    const prevAnalysis: PreviousAnalysis = {
      pr: { ...prev, meta: { ...prev.meta, headSha: "2".repeat(40) } },
      review: {
        summary: "s",
        readingOrder: [],
        analyzedAt: "2026-10-20T00:00:00.000Z",
        items: prev.files.map((f) => prevItem(f.hunks[0].id, "skim")),
      },
    };
    expect(planIncremental(pr10(7), prevAnalysis, { allowInherit: true }).kind).toBe("partial");
    expect(planIncremental(pr10(8), prevAnalysis, { allowInherit: true }).kind).toBe("full");
  });

  it("reuses everything when only noise changed", () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("package-lock.json", "@@ -1 +1 @@\n-a\n+b"),
      ghFile("src/cache.ts", `${H_CACHE}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    const plan = planIncremental(current, previous(), { allowInherit: true });
    expect(plan.kind).toBe("reuse");
    expect(plan.sendIds).toEqual([]);
    expect(plan.delta).toEqual({ new: 0, unchanged: 4, resolved: 0 });
    expect(plan.mappedReadingOrder).toEqual(["f0h0", "f2h0"]);
  });

  it("re-analyzes everything instead of reusing when a hunk was removed (the summary may describe it)", () => {
    // Only the log hunk is gone; nothing new to send.
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", H_CACHE),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    const plan = planIncremental(current, previous(), { allowInherit: true });
    expect(plan.delta).toEqual({ new: 0, unchanged: 3, resolved: 1 });
    expect(plan.kind).toBe("full");
    expect(plan.sendIds).toEqual(["f0h0", "f1h0", "f2h0"]);
    expect(plan.inherited).toEqual([]);
  });

  it("re-sends a hunk whose context above the change differs (the anchor changed), instead of inheriting", () => {
    // A hunk at the top of the file: the base later adds two lines above it.
    const before = makePr([ghFile("src/top.ts", "@@ -1,4 +1,4 @@\n a\n-y\n+x\n b\n c")], { headSha: "1".repeat(40) });
    const after = makePr([ghFile("src/top.ts", "@@ -1,6 +1,6 @@\n p1\n p2\n a\n-y\n+x\n b\n c")]);
    const prev: PreviousAnalysis = {
      pr: before,
      review: { summary: "s", readingOrder: [], analyzedAt: "2026-10-20T00:00:00.000Z", items: [prevItem("f0h0", "skim")] },
    };
    const plan = planIncremental(after, prev, { allowInherit: true });
    expect(plan.inherited).toEqual([]);
    expect(plan.sendIds).toEqual(["f0h0"]);
    expect(plan.delta).toEqual({ new: 1, unchanged: 0, resolved: 1 });
  });

  it("remaps highlights from the changed lines when the hunk only moved", () => {
    const hunk = (at: number) => `@@ -${at},7 +${at},7 @@ fn\n c1\n c2\n c3\n-y\n+x\n d1\n d2\n d3`;
    const before = makePr([ghFile("src/m.ts", hunk(10))], { headSha: "1".repeat(40) });
    const after = makePr([ghFile("src/m.ts", hunk(30))]);
    const prev: PreviousAnalysis = {
      pr: before,
      review: {
        summary: "s",
        readingOrder: [],
        analyzedAt: "2026-10-20T00:00:00.000Z",
        items: [prevItem("f0h0", "skim", { highlight: [{ side: "new", line: 13 }, { side: "old", line: 13 }, { side: "new", line: 14 }] })],
      },
    };
    const plan = planIncremental(after, prev, { allowInherit: true });
    expect(plan.kind).toBe("reuse");
    expect(plan.inherited[0].highlight).toEqual([
      { side: "new", line: 33 },
      { side: "old", line: 33 },
      { side: "new", line: 34 },
    ]);
  });

  // The reviewer's relocate.mts: push 1 deleted verify() inside an unused
  // legacyHandler (classified skim); push 2 leaves that alone and deletes the
  // same line from the live handler. Same content fingerprint, different place.
  it("does not inherit a classification for the same edit moved to another function", async () => {
    const meta = (sha: string) => ({ headSha: sha.repeat(40) });
    const push1 = makePr(
      [ghFile("src/server.js", "@@ -3,5 +3,4 @@ function legacyHandler(req) { // unused\n   const t = req.token;\n-  verify(t);\n   return ok();\n }\n")],
      meta("a"),
    );
    const push2 = makePr(
      [
        ghFile("src/server.js", "@@ -40,5 +40,4 @@ export function handler(req) {\n   const t = req.token;\n-  verify(t);\n   return ok();\n }\n"),
        ghFile("README.md", "@@ -1 +1 @@\n-# App\n+# The App\n"),
      ],
      meta("b"),
    );
    expect(push2.files[0].hunks[0].fingerprint).toBe(push1.files[0].hunks[0].fingerprint);
    const prev: PreviousAnalysis = {
      pr: push1,
      review: {
        summary: "Removes dead code from legacyHandler.",
        readingOrder: [],
        analyzedAt: "2026-10-20T00:00:00.000Z",
        items: [prevItem("f0h0", "skim", { category: "refactor", title: "미사용 legacyHandler 정리" })],
      },
    };

    const plan = planIncremental(push2, prev, { allowInherit: true });
    expect(plan.inherited).toEqual([]);
    expect(plan.sendIds).toContain("f0h0");
    expect(plan.delta).toEqual({ new: 2, unchanged: 0, resolved: 1 });

    let sent = "";
    const run: RunClaude = async (_s, prompt, schema) => {
      sent = prompt;
      return {
        data: schema.parse({ summary: "s", readingOrder: ["f0h0"], items: [raw("f0h0", "must"), raw("f1h0", "skim")] }),
        costUsd: null,
        durationMs: null,
        toolCalls: 0,
        permissionDenials: 0,
      };
    };
    const review = await triagePr(push2, { runClaude: run, previous: prev, allowInherit: true });
    expect(sent).toMatch(/<hunk-[0-9a-f]+ id="f0h0"/);
    const item = review.items.find((i) => i.hunkId === "f0h0")!;
    expect([item.source, item.priority, item.isNew]).toEqual(["ai", "must", true]);
  });

  it("does not inherit from an analysis cached before anchor keys existed (delta only)", () => {
    const old = previousPr();
    for (const f of old.files) for (const h of f.hunks) delete h.anchorKey;
    const plan = planIncremental(previousPr(), previous(old), { allowInherit: true });
    expect(plan.kind).toBe("full");
    expect(plan.inherited).toEqual([]);
    expect(plan.sendIds).toEqual(["f0h0", "f1h0", "f1h1", "f2h0"]);
    expect(plan.delta).toEqual({ new: 0, unchanged: 4, resolved: 0 });
  });

  it("counts duplicate-fingerprint hunks one by one and pairs each with its own previous item", () => {
    const dup = (at: number) => `@@ -${at},3 +${at},3 @@\n a\n-x = 1\n+x = 2\n b`;
    const prevPr = makePr([ghFile("src/d.ts", `${dup(10)}\n${dup(50)}`)], { headSha: "1".repeat(40) });
    const prev: PreviousAnalysis = {
      pr: prevPr,
      review: {
        summary: "s",
        readingOrder: [],
        analyzedAt: "2026-10-20T00:00:00.000Z",
        items: [prevItem("f0h0", "must"), prevItem("f0h1", "skim")],
      },
    };
    expect(prevPr.files[0].hunks[0].fingerprint).toBe(prevPr.files[0].hunks[1].fingerprint);

    // One of the two identical hunks removed.
    const one = planIncremental(makePr([ghFile("src/d.ts", dup(10))]), prev, { allowInherit: true });
    expect(one.delta).toEqual({ new: 0, unchanged: 1, resolved: 1 });

    // A third copy added: it is new; the first two inherit their own items.
    const three = planIncremental(makePr([ghFile("src/d.ts", `${dup(10)}\n${dup(50)}\n${dup(90)}`)]), prev, {
      allowInherit: true,
    });
    expect(three.delta).toEqual({ new: 1, unchanged: 2, resolved: 0 });
    expect(three.sendIds).toEqual(["f0h2"]);
    expect([...three.newHunkIds]).toEqual(["f0h2"]);
    expect(three.inherited.map((i) => [i.hunkId, i.title])).toEqual([
      ["f0h0", "prev-f0h0"],
      ["f0h1", "prev-f0h1"],
    ]);
  });

  it("does not inherit fallback items, and inherits nothing when refresh forbids it", () => {
    const prevWithFallback = previous(undefined, [
      prevItem("f0h0", "must"),
      prevItem("f1h0", "skim", { source: "fallback" }),
      prevItem("f1h1", "skim"),
      prevItem("f2h0", "skim"),
    ]);
    const current = previousPr();
    const plan = planIncremental(current, prevWithFallback, { allowInherit: true });
    expect(plan.sendIds).toEqual(["f1h0"]);

    const refresh = planIncremental(current, prevWithFallback, { allowInherit: false });
    expect(refresh.kind).toBe("full");
    expect(refresh.delta).toEqual({ new: 0, unchanged: 4, resolved: 0 });
  });
});

describe("triagePr incremental", () => {
  it("sends only new hunks plus the inherited list, and merges readingOrder over inherited ids", async () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", `${H_CACHE.replace("600", "900")}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    let sentPrompt = "";
    const run: RunClaude = async (_system, prompt, schema) => {
      sentPrompt = prompt;
      return {
        // Claude puts the new must hunk first, then the inherited must one; leaves out nothing else.
        data: schema.parse({ summary: "갱신된 요약", readingOrder: ["f1h0", "f0h0"], items: [raw("f1h0", "must")] }),
        costUsd: 0.01,
        durationMs: 10,
        toolCalls: 0,
        permissionDenials: 0,
      };
    };

    const review = await triagePr(current, { runClaude: run, previous: previous(), allowInherit: true });

    expect(review.sentHunkIds).toEqual(["f1h0"]);
    expect(sentPrompt).toMatch(/<hunk-[0-9a-f]+ id="f1h0"/);
    for (const id of ["f0h0", "f1h1", "f2h0"]) expect(sentPrompt).not.toMatch(new RegExp(`<hunk-[0-9a-f]+ id="${id}"`));
    expect(sentPrompt).toMatch(/<already_reviewed-[0-9a-f]+>/);
    expect(sentPrompt).toContain("- f0h0 src/auth.ts [must] prev-f0h0");
    expect(sentPrompt).toContain("이전 요약");

    expect(review.summary).toBe("갱신된 요약");
    expect(review.items.map((i) => [i.hunkId, i.source, i.isNew])).toEqual([
      ["f0h0", "inherited", false],
      ["f1h0", "ai", true],
      ["f1h1", "inherited", false],
      ["f2h0", "inherited", false],
    ]);
    expect(review.readingOrder).toEqual(["f1h0", "f0h0"]);
    expect(review.delta).toEqual({ new: 1, unchanged: 3, resolved: 1, reanalyzed: 0 });
    expect(review.previous?.headSha).toBe("1".repeat(40));
  });

  it("appends inherited must/should ids Claude left out of readingOrder", async () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", `${H_CACHE.replace("600", "900")}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    const run: RunClaude = async (_s, _p, schema) => ({
      data: schema.parse({ summary: "s", readingOrder: ["f1h0"], items: [raw("f1h0", "should")] }),
      costUsd: null,
      durationMs: null,
      toolCalls: 0,
      permissionDenials: 0,
    });
    const review = await triagePr(current, { runClaude: run, previous: previous(), allowInherit: true });
    expect(review.readingOrder).toEqual(["f1h0", "f0h0"]);
  });

  it("skips Claude entirely when only noise changed", async () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("yarn.lock", "@@ -1 +1 @@\n-a\n+b"),
      ghFile("src/cache.ts", `${H_CACHE}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    let calls = 0;
    const run: RunClaude = async () => {
      calls++;
      throw new Error("should not be called");
    };
    const review = await triagePr(current, { runClaude: run, previous: previous(), allowInherit: true });
    expect(calls).toBe(0);
    expect(review.summary).toBe("이전 요약");
    expect(review.sentHunkIds).toEqual([]);
    expect(review.readingOrder).toEqual(["f0h0", "f2h0"]);
    expect(review.items.every((i) => i.source === "inherited" && !i.isNew)).toBe(true);
  });

  it("refresh sends everything but still reports the delta and NEW flags", async () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", `${H_CACHE.replace("600", "900")}\n${H_LOG}`),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    const run: RunClaude = async (_s, _p, schema) => ({
      data: schema.parse({
        summary: "s",
        readingOrder: [],
        items: ["f0h0", "f1h0", "f1h1", "f2h0"].map((id) => raw(id, "skim")),
      }),
      costUsd: null,
      durationMs: null,
      toolCalls: 0,
      permissionDenials: 0,
    });
    const review = await triagePr(current, { runClaude: run, previous: previous(), allowInherit: false });
    expect(review.sentHunkIds).toEqual(["f0h0", "f1h0", "f1h1", "f2h0"]);
    expect(review.items.filter((i) => i.isNew).map((i) => i.hunkId)).toEqual(["f1h0"]);
    // The three unchanged hunks were classified again in this run.
    expect(review.delta).toEqual({ new: 1, unchanged: 3, resolved: 1, reanalyzed: 3 });
  });

  it("calls Claude for a fresh summary when a hunk disappeared and nothing else changed", async () => {
    const current = makePr([
      ghFile("src/auth.ts", H_AUTH),
      ghFile("src/cache.ts", H_CACHE),
      ghFile("src/a.test.ts", H_TEST),
    ]);
    let calls = 0;
    const run: RunClaude = async (_s, _p, schema) => {
      calls++;
      return {
        data: schema.parse({ summary: "새 요약", readingOrder: [], items: ["f0h0", "f1h0", "f2h0"].map((id) => raw(id, "skim")) }),
        costUsd: null,
        durationMs: null,
        toolCalls: 0,
        permissionDenials: 0,
      };
    };
    const review = await triagePr(current, { runClaude: run, previous: previous(), allowInherit: true });
    expect(calls).toBe(1);
    expect(review.summary).toBe("새 요약");
    expect(review.sentHunkIds).toEqual(["f0h0", "f1h0", "f2h0"]);
    expect(review.delta).toEqual({ new: 0, unchanged: 3, resolved: 1, reanalyzed: 3 });
  });
});
