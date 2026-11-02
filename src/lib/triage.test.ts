import { describe, expect, it } from "vitest";
import { ghFile, makePr, bigPatch } from "@/test/fixtures";
import type { RunClaude } from "./claude";
import { triageSystemPrompt } from "./prompt";
import {
  CHANGE_DETAIL_MAX,
  CHANGE_TITLE_MAX,
  mergeTriage as mergeWith,
  MAX_CHANGE_GROUPS,
  OTHER_CHANGES_TITLE,
  triagePr,
  UNCLASSIFIED_WHY,
} from "./triage";
import type { ChangeGroup, PrData, TriageItem } from "./types";
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
function mergeTriage(
  p: PrData,
  ids: string[],
  raw: Omit<TriageOutput, "changes"> & Partial<Pick<TriageOutput, "changes">>,
  options: { inherited?: TriageItem[]; previousChanges?: ChangeGroup[] } = {},
) {
  return mergeWith(p, ids, raw, { ...options, lookAt: { files: new Map(p.files.map((f) => [f.filename, null])) } });
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

describe("mergeTriage changes", () => {
  const group = (title: string, hunkIds: string[], detail = "d") => ({ title, detail, hunkIds });
  const merge = (changes: TriageOutput["changes"], ids = ALL, options: { inherited?: TriageItem[]; previousChanges?: ChangeGroup[] } = {}) =>
    mergeTriage(pr, ids, { summary: "s", readingOrder: [], items: [], changes }, options).changes!;
  /** Twelve one-hunk files, for the group cap. */
  const wide = makePr(Array.from({ length: 12 }, (_, i) => ghFile(`src/f${i}.ts`, "@@ -1 +1 @@\n-a\n+b")));
  const WIDE_IDS = wide.files.map((f) => f.hunks[0].id);
  const mergeWide = (changes: TriageOutput["changes"]) =>
    mergeTriage(wide, WIDE_IDS, { summary: "s", readingOrder: [], items: [], changes }).changes!;

  it("keeps Claude's groups and order, with trimmed text", () => {
    expect(merge([group("  API 연결 ", ["f1h1", "f0h0"], " 탭이 API를 호출합니다. "), group("테스트", ["f1h0", "f2h0"])])).toEqual([
      { title: "API 연결", detail: "탭이 API를 호출합니다.", hunkIds: ["f1h1", "f0h0"] },
      { title: "테스트", detail: "d", hunkIds: ["f1h0", "f2h0"] },
    ]);
  });

  it("truncates long titles like item titles and names an empty one", () => {
    const [long, empty] = merge([group("가".repeat(60), ["f0h0"]), group("   ", ["f1h0", "f1h1", "f2h0"])]);
    expect(CHANGE_TITLE_MAX).toBe(30);
    expect(Array.from(long.title)).toHaveLength(30);
    expect(long.title.endsWith("…")).toBe(true);
    expect(empty.title).toBe("제목 없음");
  });

  it("truncates a long detail the same way", () => {
    const [long, short] = merge([group("a", ["f0h0"], "나".repeat(300)), group("b", ["f1h0", "f1h1", "f2h0"], "나".repeat(200))]);
    expect(CHANGE_DETAIL_MAX).toBe(200);
    expect(Array.from(long.detail)).toHaveLength(200);
    expect(long.detail.endsWith("…")).toBe(true);
    expect(short.detail).toBe("나".repeat(200));
  });

  it("drops unknown ids, ids that were not sent, and groups left empty", () => {
    expect(merge([group("a", ["nope", "f0h0", "f1h1"]), group("b", ["f9h9"]), group("c", [])], ["f0h0", "f1h0"])).toEqual([
      group("a", ["f0h0"]),
      { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f1h0"] },
    ]);
  });

  it("keeps a duplicate id in its first group only", () => {
    expect(merge([group("a", ["f0h0", "f0h0", "f1h0"]), group("b", ["f0h0"]), group("c", ["f1h0", "f1h1", "f2h0"])])).toEqual([
      group("a", ["f0h0", "f1h0"]),
      group("c", ["f1h1", "f2h0"]),
    ]);
  });

  it("puts hunks Claude did not assign into a last catch-all, in diff order", () => {
    const changes = merge([group("a", ["f1h1"])]);
    expect(changes).toEqual([group("a", ["f1h1"]), { title: "그 밖의 변경", detail: "", hunkIds: ["f0h0", "f1h0", "f2h0"] }]);
  });

  it("adds no catch-all when every hunk is assigned", () => {
    expect(merge([group("a", ALL)])).toEqual([group("a", ALL)]);
  });

  it("returns no groups, and no catch-all, when Claude gave no valid group", () => {
    expect(merge([])).toEqual([]);
    expect(merge([group("a", ["nope"]), group("b", [])])).toEqual([]);
  });

  it("keeps exactly the cap when everything is assigned", () => {
    expect(MAX_CHANGE_GROUPS).toBe(8);
    const changes = mergeWide([
      ...WIDE_IDS.slice(0, 7).map((id) => group(id, [id])),
      group("last", WIDE_IDS.slice(7)),
    ]);
    expect(changes).toHaveLength(8);
    expect(changes.map((g) => g.title)).not.toContain(OTHER_CHANGES_TITLE);
  });

  it("caps at 8 groups including the catch-all, which takes the rest", () => {
    const changes = mergeWide(WIDE_IDS.map((id) => group(id, [id])));
    expect(changes).toHaveLength(8);
    expect(changes.slice(0, 7).map((g) => g.title)).toEqual(WIDE_IDS.slice(0, 7));
    expect(changes[7]).toEqual({ title: OTHER_CHANGES_TITLE, detail: "", hunkIds: WIDE_IDS.slice(7) });
  });

  it("makes room for the catch-all when 8 groups leave a hunk unassigned", () => {
    const changes = mergeWide(WIDE_IDS.slice(0, 8).map((id) => group(id, [id])));
    expect(changes).toHaveLength(8);
    expect(changes[7]).toEqual({ title: OTHER_CHANGES_TITLE, detail: "", hunkIds: WIDE_IDS.slice(7) });
  });

  it("drops junk ids and empty groups, and still covers every hunk once", () => {
    const hostile = [
      group("숨기기", ["f0h0", "f0h0", "../../etc/passwd"]),
      group("", []),
      group("다시", ["f0h0", "ghost"]),
      ...Array.from({ length: 20 }, (_, i) => group(`g${i}`, i < 2 ? [`f1h${i}`] : [`x${i}`])),
    ];
    const assigned = merge(hostile).flatMap((g) => g.hunkIds);
    expect([...assigned].sort()).toEqual([...ALL].sort());
  });

  it("stays within the cap with exact coverage when more than 8 valid groups repeat ids", () => {
    // Every group keeps one id of its own after the repeats are dropped.
    const hostile = [
      group("앞 둘 가로채기", [WIDE_IDS[0], WIDE_IDS[0], WIDE_IDS[1]]),
      ...WIDE_IDS.slice(2).map((id) => group(id, [id, id, WIDE_IDS[0], "ghost"])),
    ];
    expect(hostile.length).toBeGreaterThan(MAX_CHANGE_GROUPS);
    const changes = mergeWide(hostile);
    expect(changes.length).toBeLessThanOrEqual(MAX_CHANGE_GROUPS);
    const assigned = changes.flatMap((g) => g.hunkIds);
    expect(assigned).toHaveLength(WIDE_IDS.length);
    expect([...assigned].sort()).toEqual([...WIDE_IDS].sort());
  });

  describe("inherited hunks Claude left out", () => {
    const inherited = (hunkId: string): TriageItem => ({ ...item(hunkId, "should"), isNew: false, source: "inherited" });
    const INHERITED = ["f1h0", "f1h1", "f2h0"].map(inherited);
    const previousChanges: ChangeGroup[] = [
      { title: "이전 묶음", detail: "이전 설명", hunkIds: ["f1h0", "f1h1"] },
      { title: "이전 테스트", detail: "", hunkIds: ["f2h0"] },
    ];

    it("go back under their previous group, after Claude's groups", () => {
      expect(merge([group("새 묶음", ["f0h0"])], ["f0h0"], { inherited: INHERITED, previousChanges })).toEqual([
        group("새 묶음", ["f0h0"]),
        ...previousChanges,
      ]);
    });

    it("stay with Claude when Claude placed them, and a previous group left empty disappears", () => {
      expect(merge([group("새 묶음", ["f0h0", "f1h0", "f2h0"])], ["f0h0"], { inherited: INHERITED, previousChanges })).toEqual([
        group("새 묶음", ["f0h0", "f1h0", "f2h0"]),
        { ...previousChanges[0], hunkIds: ["f1h1"] },
      ]);
    });

    it("keep their groups when Claude returned none, with the sent hunks in the catch-all", () => {
      expect(merge([], ["f0h0"], { inherited: INHERITED, previousChanges })).toEqual([
        ...previousChanges,
        { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f0h0"] },
      ]);
    });

    it("never produce a second catch-all from the previous one", () => {
      const withCatchAll = [previousChanges[0], { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f2h0"] }];
      expect(merge([group("새 묶음", ["f0h0"])], ["f0h0"], { inherited: INHERITED, previousChanges: withCatchAll })).toEqual([
        group("새 묶음", ["f0h0"]),
        previousChanges[0],
        { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f2h0"] },
      ]);
    });

    it("respect the cap, with exact coverage", () => {
      const wideInherited = WIDE_IDS.slice(1).map(inherited);
      const changes = mergeTriage(
        wide,
        [WIDE_IDS[0]],
        { summary: "s", readingOrder: [], items: [], changes: [group("새 묶음", [WIDE_IDS[0]])] },
        { inherited: wideInherited, previousChanges: WIDE_IDS.slice(1).map((id) => group(id, [id])) },
      ).changes!;
      expect(changes).toHaveLength(MAX_CHANGE_GROUPS);
      expect(changes[0].title).toBe("새 묶음");
      expect(changes[MAX_CHANGE_GROUPS - 1].title).toBe(OTHER_CHANGES_TITLE);
      const assigned = changes.flatMap((g) => g.hunkIds);
      expect(assigned).toHaveLength(WIDE_IDS.length);
      expect([...assigned].sort()).toEqual([...WIDE_IDS].sort());
    });

    it("do not invent groups when the previous result had none", () => {
      expect(merge([], ["f0h0"], { inherited: INHERITED })).toEqual([]);
    });
  });

  it("passes through a missing changes field, so a result stays marked as made before groups existed", () => {
    expect(mergeTriage(pr, ALL, { summary: "s", readingOrder: [], items: [] }).changes).toBeUndefined();
  });

  it("allows inherited hunks alongside the sent ones, and catches the ones Claude left out", () => {
    const inherited = (hunkId: string): TriageItem => ({
      ...item(hunkId, "should"),
      isNew: false,
      source: "inherited",
    });
    const changes = merge([group("a", ["f0h0", "f1h0"])], ["f0h0"], { inherited: [inherited("f1h0"), inherited("f1h1")] });
    expect(changes).toEqual([group("a", ["f0h0", "f1h0"]), { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f1h1"] }]);
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

  it("returns the validated change groups", async () => {
    const { run } = fakeClaude({
      summary: "s",
      changes: [{ title: "재시도 추가", detail: "실패하면 다시 시도합니다.", hunkIds: ["f0h0", "f1h0", "bogus"] }],
      readingOrder: [],
      items: [],
    });
    const review = await triagePr(pr, { runClaude: run });
    expect(review.changes).toEqual([
      { title: "재시도 추가", detail: "실패하면 다시 시도합니다.", hunkIds: ["f0h0", "f1h0"] },
      { title: OTHER_CHANGES_TITLE, detail: "", hunkIds: ["f1h1", "f2h0"] },
    ]);
  });

  it("keeps the analysis, with no groups, when Claude's output has no changes", async () => {
    const { run } = fakeClaude({ summary: "s", readingOrder: [], items: [] });
    expect((await triagePr(pr, { runClaude: run })).changes).toEqual([]);
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
    expect(review.changes).toEqual([]);
  });

  it("propagates runClaude failures", async () => {
    const run: RunClaude = async () => {
      throw new Error("Claude 응답 오류");
    };
    await expect(triagePr(pr, { runClaude: run })).rejects.toThrow("Claude 응답 오류");
  });
});
