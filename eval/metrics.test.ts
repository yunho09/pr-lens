import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import type { Priority, TriageItem } from "@/lib/types";
import {
  aggregate,
  compareTable,
  firstHitRank,
  fullAnalysisViolations,
  keptHunkCount,
  metricsTable,
  placeBuggyHunks,
  terminalSafe,
  type CaseOutcome,
  type HunkPlacement,
} from "./metrics";

const item = (hunkId: string, priority: Priority): TriageItem => ({
  hunkId,
  priority,
  category: "logic",
  title: "t",
  explain: "",
  why: "",
  check: "",
  highlight: [],
  lookAt: [],
  isNew: false,
  source: "ai",
});

const twoHunks = "@@ -1,1 +1,2 @@\n ctx\n+const a = alpha(1);\n@@ -20,1 +21,2 @@\n ctx\n+const b = bravo(2);";

describe("placeBuggyHunks", () => {
  const pr = makePr([
    ghFile("src/a.ts", twoHunks),
    ghFile("src/b.ts", "@@ -1,1 +1,2 @@\n ctx\n+const c = charlie(3);"),
    ghFile("package-lock.json", '@@ -1,1 +1,2 @@\n ctx\n+  "version": "1.2.3",'),
  ]);
  const [a0, a1] = pr.files[0].hunks;
  const [b0] = pr.files[1].hunks;
  const [lock] = pr.files[2].hunks;

  it("maps each label by fingerprint to its priority, noise, omitted, or missing, with readingOrder rank", () => {
    const review = { items: [item(a0.id, "must"), item(a1.id, "skim")], readingOrder: [a0.id] };
    const placed = placeBuggyHunks(pr, review, [
      { path: "src/a.ts", fingerprint: a0.fingerprint },
      { path: "src/a.ts", fingerprint: a1.fingerprint },
      { path: "src/b.ts", fingerprint: b0.fingerprint },
      { path: "package-lock.json", fingerprint: lock.fingerprint },
      { path: "src/gone.ts", fingerprint: "0".repeat(40) },
    ]);
    expect(placed.map((p) => [p.placement, p.rank])).toEqual([
      ["must", 1],
      ["skim", null],
      ["omitted", null],
      ["noise", null],
      ["missing", null],
    ]);
    expect(placed[0].hunkId).toBe(a0.id);
  });

  it("places a hunk Claude was sent but did not classify (fallback) as unclassified, not skim", () => {
    const review = {
      items: [item(a0.id, "must"), { ...item(a1.id, "skim"), source: "fallback" as const }],
      readingOrder: [a0.id],
    };
    const placed = placeBuggyHunks(pr, review, [{ path: "src/a.ts", fingerprint: a1.fingerprint }]);
    expect(placed.map((p) => p.placement)).toEqual(["unclassified"]);
  });

  it("counts kept hunks only", () => {
    expect(keptHunkCount(pr)).toBe(3);
  });
});

describe("fullAnalysisViolations", () => {
  const pr = makePr([
    ghFile("src/a.ts", twoHunks),
    ghFile("src/b.ts", "@@ -1,1 +1,2 @@\n ctx\n+const c = charlie(3);"),
    ghFile("package-lock.json", '@@ -1,1 +1,2 @@\n ctx\n+  "version": "1.2.3",'),
  ]);
  const [a0, a1] = pr.files[0].hunks;
  const [b0] = pr.files[1].hunks;

  it("accepts a full analysis: every kept hunk sent or omitted for size; noise hunks need not be sent", () => {
    const clean = {
      previous: null,
      items: [item(a0.id, "must"), item(a1.id, "skim")],
      omitted: [{ hunkId: b0.id, reason: "too big" }],
      sentHunkIds: [a0.id, a1.id],
    };
    expect(fullAnalysisViolations(pr, clean)).toEqual([]);
  });

  it("reports a previous result, inherited items, and kept hunks that were not sent", () => {
    const violations = fullAnalysisViolations(pr, {
      previous: { headSha: "b".repeat(40), analyzedAt: "2026-10-01T00:00:00Z" },
      items: [{ ...item(a0.id, "must"), source: "inherited" }, item(a1.id, "skim")],
      omitted: [],
      sentHunkIds: [a1.id],
    });
    expect(violations).toEqual([
      "previous가 null이 아님 (bbbbbbb)",
      "상속된 항목 1개",
      `Claude에게 안 보낸 hunk 2개 (${a0.id}, ${b0.id})`,
    ]);
  });
});

const p = (placement: HunkPlacement["placement"], rank: number | null = null): HunkPlacement => ({
  path: "x",
  fingerprint: "f",
  placement,
  hunkId: placement === "missing" ? null : "h",
  rank,
});

const outcome = (id: string, placements: HunkPlacement[], extra: Partial<CaseOutcome> = {}): CaseOutcome => ({
  id,
  analysisKey: id,
  placements,
  keptHunks: 10,
  mustCount: 2,
  costUsd: 0.1,
  durationMs: 1000,
  ...extra,
});

describe("firstHitRank", () => {
  it("is the best rank among buggy hunks, or null", () => {
    expect(firstHitRank([p("should", 3), p("must", 2), p("skim")])).toBe(2);
    expect(firstHitRank([p("skim"), p("noise")])).toBeNull();
  });
});

describe("aggregate", () => {
  const outcomes: CaseOutcome[] = [
    outcome("c1", [p("must", 1), p("skim")], { mustCount: 1, keptHunks: 4 }),
    outcome("c2", [p("should", 3)], { mustCount: 2, keptHunks: 8 }),
    outcome("c3", [p("noise"), p("skim"), p("missing")], { mustCount: 0, keptHunks: 5 }),
    // Same PR as c1: shares its analysis, so cost/time are not counted twice.
    outcome("c4", [p("omitted")], { analysisKey: "c1", mustCount: 1, keptHunks: 4 }),
    outcome("c5", [p("missing")]),
    outcome("c6", [], { error: "boom", costUsd: null, durationMs: 500 }),
  ];
  const m = aggregate(outcomes);

  it("scores only cases without errors that have a located label", () => {
    expect(m.cases).toBe(4);
    expect(m.errors).toBe(1);
    expect(m.unscorable).toBe(1);
    expect(m.buggyHunks).toBe(6);
    expect(m.missingHunks).toBe(1);
  });

  it("computes case and hunk recall", () => {
    expect(m.caseRecallMust).toBeCloseTo(1 / 4);
    expect(m.caseRecallMustShould).toBeCloseTo(2 / 4);
    expect(m.hunkRecallMust).toBeCloseTo(1 / 6);
  });

  it("computes mustRate as the mean per-case must share, and firstHitRank over cases with a hit", () => {
    expect(m.mustRate).toBeCloseTo((1 / 4 + 2 / 8 + 0 / 5 + 1 / 4) / 4);
    expect(m.firstHitRank).toBeCloseTo((1 + 3) / 2);
    expect(m.firstHitCases).toBe(2);
  });

  it("counts noise misses and sums cost/time once per analysis", () => {
    expect(m.noiseMisses).toBe(1);
    expect(m.unclassifiedHunks).toBe(0);
    expect(m.totalCostUsd).toBeCloseTo(0.1 * 4);
    expect(m.totalDurationMs).toBe(1000 * 4 + 500);
  });

  it("counts unclassified labels apart from skim, and still reads runs saved before that placement existed", () => {
    const now = aggregate([outcome("c1", [p("unclassified"), p("skim")]), outcome("c2", [p("unclassified")])]);
    expect(now.unclassifiedHunks).toBe(2);
    expect(now.buggyHunks).toBe(3);
    expect(now.caseRecallMustShould).toBe(0);
    // An old run file: same shape, no "unclassified" anywhere.
    const old = aggregate([outcome("c1", [p("skim"), p("must", 1)])]);
    expect(old.unclassifiedHunks).toBe(0);
    expect(old.caseRecallMust).toBe(1);
  });

  it("returns nulls instead of NaN when nothing is scored", () => {
    const empty = aggregate([]);
    expect(empty.caseRecallMust).toBeNull();
    expect(empty.mustRate).toBeNull();
    expect(empty.firstHitRank).toBeNull();
  });
});

describe("tables", () => {
  it("formats metrics and signed deltas", () => {
    const a = aggregate([outcome("c1", [p("should", 2)])]);
    const b = aggregate([outcome("c1", [p("must", 1)])]);
    expect(metricsTable(b)).toContain("| caseRecall@must ↑ | 100.0% |");
    const table = compareTable(a, b, ["이전", "최신"]);
    expect(table).toContain("| caseRecall@must ↑ | 0.0% | 100.0% | +100.0pp |");
    expect(table).toContain("| firstHitRank ↓ | 2.00 | 1.00 | −1.00 |");
    expect(table).toContain("| noiseMisses (0이어야 함) | 0 | 0 | ±0 |");
  });
});

describe("terminalSafe", () => {
  it("removes terminal control characters from untrusted PR text", () => {
    const title = "fix: crash\u001b]8;;https://evil.example\u0007click\u001b[2J\u0000\u007f\u009b31m";
    const out = terminalSafe(title);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out).toContain("fix: crash");
    expect(terminalSafe("a\tb\r\nc")).toBe("a b  c");
    expect(terminalSafe("line 1\nline 2\u001b", true)).toBe("line 1\nline 2 ");
  });
});
