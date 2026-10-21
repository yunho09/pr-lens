import { describe, expect, it } from "vitest";
import { ghFile, makePr, bigPatch } from "@/test/fixtures";
import type { RunClaude } from "./claude";
import { triageSystemPrompt } from "./prompt";
import { mergeTriage as mergeWith, triagePr, UNCLASSIFIED_WHY } from "./triage";
import type { PrData } from "./types";
import type { TriageOutput } from "./triage-schema";

// f0: src/types.ts   one hunk  (new lines 10-12, old 10-11)
// f1: src/use.ts     two hunks (h0 new 1-3, h1 new 50-52)
// f2: src/use.test.ts one hunk
const pr = makePr([
  ghFile("src/types.ts", "@@ -10,2 +10,3 @@\n type A = {\n+  b: string;\n }"),
  ghFile("src/use.ts", "@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -50,3 +50,3 @@\n x\n-y\n+z\n w"),
  ghFile("src/use.test.ts", "@@ -1 +1 @@\n-it('a')\n+it('b')"),
]);
const ALL = ["f0h0", "f1h0", "f1h1", "f2h0"];

type RawItem = TriageOutput["items"][number];
function item(hunkId: string, priority: RawItem["priority"], extra: Partial<RawItem> = {}): RawItem {
  return {
    hunkId,
    priority,
    category: "logic",
    title: `t-${hunkId}`,
    explain: "e",
    why: "w",
    check: "c?",
    highlight: [],
    lookAt: [],
    ...extra,
  };
}

/** mergeTriage with fast-mode lookAt rules (PR files only) and no previous analysis. */
function mergeTriage(p: PrData, ids: string[], raw: TriageOutput) {
  return mergeWith(p, ids, raw, { lookAt: { files: new Map(p.files.map((f) => [f.filename, null])) } });
}

describe("mergeTriage", () => {
  it("drops unknown ids and duplicates (first wins)", () => {
    const merged = mergeTriage(pr, ALL, {
      summary: "s",
      readingOrder: [],
      items: [
        item("f1h0", "must"),
        item("nope", "must"),
        item("f9h9", "should"),
        item("f1h0", "skim", { title: "dup" }),
        item("f0h0", "should"),
        item("f1h1", "skim"),
        item("f2h0", "skim"),
      ],
    });
    expect(merged.items.map((i) => i.hunkId)).toEqual(ALL);
    expect(merged.items.find((i) => i.hunkId === "f1h0")).toMatchObject({ priority: "must", title: "t-f1h0" });
  });

  it("drops items for hunks that were not sent (e.g. omitted by budget)", () => {
    const merged = mergeTriage(pr, ["f0h0", "f1h0"], {
      summary: "s",
      readingOrder: ["f1h1"],
      items: [item("f0h0", "should"), item("f1h0", "skim"), item("f1h1", "must")],
    });
    expect(merged.items.map((i) => i.hunkId)).toEqual(["f0h0", "f1h0"]);
    expect(merged.readingOrder).toEqual(["f0h0"]);
  });

  it("fills missing hunks as skim with a visible fallback reason", () => {
    const merged = mergeTriage(pr, ALL, {
      summary: "s",
      readingOrder: [],
      items: [item("f1h0", "must")],
    });
    const missing = merged.items.filter((i) => i.source === "fallback");
    expect(missing.map((i) => i.hunkId)).toEqual(["f0h0", "f1h1", "f2h0"]);
    for (const m of missing) {
      expect(m).toMatchObject({ priority: "skim", why: UNCLASSIFIED_WHY, check: "", highlight: [] });
    }
    expect(missing.find((m) => m.hunkId === "f2h0")?.category).toBe("test");
  });

  it("clamps highlight lines to the hunk's real line numbers and drops impossible sides", () => {
    const merged = mergeTriage(pr, ALL, {
      summary: "s",
      readingOrder: [],
      items: [
        item("f0h0", "must", {
          highlight: [
            { side: "new", line: 11 }, // valid
            { side: "new", line: 999 }, // → 12
            { side: "new", line: 1 }, // → 10
            { side: "old", line: 0 }, // → 10
            { side: "new", line: 12 }, // duplicate of clamped 999
          ],
        }),
        item("f2h0", "skim", { highlight: [{ side: "old", line: 5 }] }), // → 1
      ],
    });
    expect(merged.items[0].highlight).toEqual([
      { side: "new", line: 11 },
      { side: "new", line: 12 },
      { side: "new", line: 10 },
      { side: "old", line: 10 },
    ]);
    expect(merged.items.find((i) => i.hunkId === "f2h0")?.highlight).toEqual([{ side: "old", line: 1 }]);

    const added = makePr([ghFile("src/new.ts", "@@ -0,0 +1,2 @@\n+a\n+b", { status: "added" })]);
    const m2 = mergeTriage(added, ["f0h0"], {
      summary: "s",
      readingOrder: [],
      items: [item("f0h0", "should", { highlight: [{ side: "old", line: 1 }, { side: "new", line: 2 }] })],
    });
    expect(m2.items[0].highlight).toEqual([{ side: "new", line: 2 }]);
  });

  it("repairs readingOrder: keeps valid must/should order, drops skim/unknown/dupes, appends missing", () => {
    const merged = mergeTriage(pr, ALL, {
      summary: "s",
      readingOrder: ["f1h1", "zzz", "f2h0", "f1h1", "f0h0"],
      items: [item("f0h0", "should"), item("f1h0", "must"), item("f1h1", "should"), item("f2h0", "skim")],
    });
    // f1h1, f0h0 from Claude (f2h0 is skim, zzz unknown, dupe removed), then the missing must f1h0.
    expect(merged.readingOrder).toEqual(["f1h1", "f0h0", "f1h0"]);
  });

  it("appends missing items must-first when readingOrder is empty", () => {
    const merged = mergeTriage(pr, ALL, {
      summary: "s",
      readingOrder: [],
      items: [item("f0h0", "should"), item("f1h0", "skim"), item("f1h1", "must"), item("f2h0", "should")],
    });
    expect(merged.readingOrder).toEqual(["f1h1", "f0h0", "f2h0"]);
  });

  it("truncates long titles and fills an empty summary", () => {
    const long = "가".repeat(60);
    const merged = mergeTriage(pr, ["f0h0"], { summary: "  ", readingOrder: [], items: [item("f0h0", "skim", { title: long })] });
    expect(Array.from(merged.items[0].title)).toHaveLength(40);
    expect(merged.items[0].title.endsWith("…")).toBe(true);
    expect(merged.summary).toBe("요약을 생성하지 못했습니다.");
  });
});

/** A RunClaude stand-in that records calls and returns `output` through the real schema. */
function fakeClaude(output: unknown, extra: { costUsd: number | null; durationMs: number | null } = { costUsd: null, durationMs: null }) {
  const calls: Array<{ system: string; prompt: string }> = [];
  const run: RunClaude = async (system, prompt, schema) => {
    calls.push({ system, prompt });
    return { data: schema.parse(output), ...extra, toolCalls: 0, permissionDenials: 0 };
  };
  return { run, calls };
}

describe("triagePr with a mocked runClaude", () => {
  it("sends the prompt and merges the structured output", async () => {
    const { run, calls } = fakeClaude(
      {
        summary: "재시도 로직을 추가합니다.",
        readingOrder: ["f1h0", "f0h0"],
        items: [item("f0h0", "should"), item("f1h0", "must", { highlight: [{ side: "new", line: 2 }] }), item("bogus", "must")],
      },
      { costUsd: 0.12, durationMs: 3456 },
    );

    const review = await triagePr(pr, { runClaude: run });

    expect(calls).toHaveLength(1);
    const { system, prompt } = calls[0];
    expect(system).toBe(triageSystemPrompt("fast"));
    for (const id of ALL) expect(prompt).toContain(`id="${id}"`);

    expect(review.summary).toBe("재시도 로직을 추가합니다.");
    expect(review.readingOrder).toEqual(["f1h0", "f0h0"]);
    expect(review.items).toHaveLength(4);
    expect(review.items.filter((i) => i.source === "fallback").map((i) => i.hunkId)).toEqual(["f1h1", "f2h0"]);
    expect(review.costUsd).toBe(0.12);
    expect(review.durationMs).toBe(3456);
    expect(review.omitted).toEqual([]);
  });

  it("reports omitted hunks alongside the result", async () => {
    const big = makePr([ghFile("src/huge.ts", bigPatch(400)), ghFile("src/small.ts", "@@ -1 +1 @@\n-a\n+b")]);
    const { run } = fakeClaude({ summary: "s", readingOrder: [], items: [item("f1h0", "skim")] });
    const review = await triagePr(big, { runClaude: run, budgetChars: 2_000 });
    expect(review.omitted).toEqual([{ hunkId: "f0h0", reason: "너무 커서 분석 생략" }]);
    expect(review.items.map((i) => i.hunkId)).toEqual(["f1h0"]);
  });

  it("does not call Claude when every file is noise", async () => {
    const noise = makePr([ghFile("package-lock.json", "@@ -1 +1 @@\n-a\n+b")]);
    const { run, calls } = fakeClaude({ summary: "s", readingOrder: [], items: [] });
    const review = await triagePr(noise, { runClaude: run });
    expect(calls).toHaveLength(0);
    expect(review.items).toEqual([]);
    expect(review.summary).toMatch(/노이즈/);
  });

  it("propagates runClaude failures", async () => {
    const run: RunClaude = async () => {
      throw new Error("Claude 응답 오류");
    };
    await expect(triagePr(pr, { runClaude: run })).rejects.toThrow("Claude 응답 오류");
  });
});
