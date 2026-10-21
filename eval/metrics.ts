import type { PrData, ReviewResult } from "@/lib/types";

// Pure scoring for eval runs: where each labeled buggy hunk landed, and the
// aggregate metrics over cases. run.ts and report.ts do the I/O.

export const PLACEMENTS = ["must", "should", "skim", "unclassified", "noise", "omitted", "missing"] as const;
/**
 * must/should/skim: Claude's label. unclassified: sent to Claude, but it
 * returned no item (shown as an "AI 미분류" skim card; runs saved before this
 * placement existed count it as skim). noise: dropped by the noise filter.
 * omitted: kept but never sent (prompt budget). missing: no hunk with that
 * fingerprint in the PR any more (label is stale).
 */
export type Placement = (typeof PLACEMENTS)[number];

export interface BuggyLabel {
  path: string;
  fingerprint: string;
}

export interface HunkPlacement {
  path: string;
  fingerprint: string;
  placement: Placement;
  hunkId: string | null;
  /** 1-based position in readingOrder, null when not in it. */
  rank: number | null;
}

export function placeBuggyHunks(
  pr: Pick<PrData, "files">,
  review: Pick<ReviewResult, "items" | "readingOrder">,
  buggy: BuggyLabel[],
): HunkPlacement[] {
  const byFingerprint = new Map<string, { hunkId: string; noise: boolean }>();
  for (const file of pr.files) {
    for (const hunk of file.hunks) {
      if (!byFingerprint.has(hunk.fingerprint)) {
        byFingerprint.set(hunk.fingerprint, { hunkId: hunk.id, noise: file.classification.kind !== "keep" });
      }
    }
  }
  const items = new Map(review.items.map((i) => [i.hunkId, i]));

  return buggy.map(({ path, fingerprint }) => {
    const found = byFingerprint.get(fingerprint);
    if (!found) return { path, fingerprint, placement: "missing", hunkId: null, rank: null };
    const at = review.readingOrder.indexOf(found.hunkId);
    const item = items.get(found.hunkId);
    const placement: Placement = found.noise
      ? "noise"
      : !item
        ? "omitted"
        : item.source === "fallback"
          ? "unclassified"
          : item.priority;
    return { path, fingerprint, placement, hunkId: found.hunkId, rank: at === -1 ? null : at + 1 };
  });
}

/** Hunks that reach Claude: kept files only. */
export function keptHunkCount(pr: Pick<PrData, "files">): number {
  return pr.files.reduce((n, f) => n + (f.classification.kind === "keep" ? f.hunks.length : 0), 0);
}

/**
 * An eval run must be a full analysis: no previous result, no inherited
 * items, and every kept hunk not omitted for size sent to Claude.
 * Returns what was violated (empty when clean).
 */
export function fullAnalysisViolations(
  pr: Pick<PrData, "files">,
  review: Pick<ReviewResult, "previous" | "items" | "omitted" | "sentHunkIds">,
): string[] {
  const out: string[] = [];
  if (review.previous !== null) out.push(`previous가 null이 아님 (${review.previous.headSha.slice(0, 7)})`);
  const inherited = review.items.filter((i) => i.source === "inherited").length;
  if (inherited > 0) out.push(`상속된 항목 ${inherited}개`);
  const omitted = new Set(review.omitted.map((o) => o.hunkId));
  const sent = new Set(review.sentHunkIds);
  const unsent = pr.files
    .filter((f) => f.classification.kind === "keep")
    .flatMap((f) => f.hunks.map((h) => h.id))
    .filter((id) => !omitted.has(id) && !sent.has(id));
  if (unsent.length > 0) out.push(`Claude에게 안 보낸 hunk ${unsent.length}개 (${unsent.slice(0, 5).join(", ")})`);
  return out;
}

export interface CaseOutcome {
  id: string;
  /** Cases on the same PR share one analysis; cost/time are counted once per key. */
  analysisKey: string;
  placements: HunkPlacement[];
  keptHunks: number;
  mustCount: number;
  costUsd: number | null;
  durationMs: number;
  error?: string;
}

export function firstHitRank(placements: HunkPlacement[]): number | null {
  const ranks = placements.map((p) => p.rank).filter((r): r is number => r !== null);
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

export interface RunMetrics {
  /** Cases scored: no error and at least one buggy hunk located. */
  cases: number;
  errors: number;
  /** Cases whose every label was missing. */
  unscorable: number;
  /** Located buggy hunks (excludes missing). */
  buggyHunks: number;
  missingHunks: number;
  caseRecallMust: number | null;
  caseRecallMustShould: number | null;
  hunkRecallMust: number | null;
  mustRate: number | null;
  firstHitRank: number | null;
  /** Cases with a buggy hunk in readingOrder (the firstHitRank sample). */
  firstHitCases: number;
  noiseMisses: number;
  /** Located buggy hunks Claude was sent but did not classify. */
  unclassifiedHunks: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function aggregate(outcomes: CaseOutcome[]): RunMetrics {
  const ok = outcomes.filter((o) => !o.error);
  const scored = ok.filter((o) => o.placements.some((p) => p.placement !== "missing"));
  const located = scored.flatMap((o) => o.placements.filter((p) => p.placement !== "missing"));
  const has = (o: CaseOutcome, ps: Placement[]) => o.placements.some((p) => ps.includes(p.placement));
  const ranks = scored.map((o) => firstHitRank(o.placements)).filter((r): r is number => r !== null);

  let totalCostUsd = 0;
  let totalDurationMs = 0;
  const counted = new Set<string>();
  for (const o of outcomes) {
    if (counted.has(o.analysisKey)) continue;
    counted.add(o.analysisKey);
    totalCostUsd += o.costUsd ?? 0;
    totalDurationMs += o.durationMs;
  }

  return {
    cases: scored.length,
    errors: outcomes.length - ok.length,
    unscorable: ok.length - scored.length,
    buggyHunks: located.length,
    missingHunks: scored.reduce((n, o) => n + o.placements.filter((p) => p.placement === "missing").length, 0),
    caseRecallMust: ratio(scored.filter((o) => has(o, ["must"])).length, scored.length),
    caseRecallMustShould: ratio(scored.filter((o) => has(o, ["must", "should"])).length, scored.length),
    hunkRecallMust: ratio(located.filter((p) => p.placement === "must").length, located.length),
    mustRate: mean(scored.filter((o) => o.keptHunks > 0).map((o) => o.mustCount / o.keptHunks)),
    firstHitRank: mean(ranks),
    firstHitCases: ranks.length,
    noiseMisses: located.filter((p) => p.placement === "noise").length,
    unclassifiedHunks: located.filter((p) => p.placement === "unclassified").length,
    totalCostUsd,
    totalDurationMs,
  };
}

type MetricKind = "pct" | "rank" | "count" | "usd" | "ms";

/**
 * Untrusted text (PR titles, code samples, error messages) with terminal
 * control characters (C0, DEL, C1) replaced by spaces, so it cannot move the
 * cursor, rewrite the screen, or forge links when printed.
 */
export function terminalSafe(text: string, keepNewlines = false): string {
  return text.replace(keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export const METRIC_ROWS: Array<{ key: keyof RunMetrics; label: string; kind: MetricKind }> = [
  { key: "caseRecallMust", label: "caseRecall@must ↑", kind: "pct" },
  { key: "caseRecallMustShould", label: "caseRecall@must+should ↑", kind: "pct" },
  { key: "hunkRecallMust", label: "hunkRecall@must ↑", kind: "pct" },
  { key: "mustRate", label: "mustRate (낮을수록 강한 필터)", kind: "pct" },
  { key: "firstHitRank", label: "firstHitRank ↓", kind: "rank" },
  { key: "noiseMisses", label: "noiseMisses (0이어야 함)", kind: "count" },
  { key: "unclassifiedHunks", label: "unclassified (AI가 분류 안 함)", kind: "count" },
  { key: "cases", label: "채점한 케이스", kind: "count" },
  { key: "buggyHunks", label: "정답 hunk", kind: "count" },
  { key: "errors", label: "실패한 케이스", kind: "count" },
  { key: "totalCostUsd", label: "총 비용", kind: "usd" },
  { key: "totalDurationMs", label: "총 분석 시간", kind: "ms" },
];

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function formatMetric(value: number | null, kind: MetricKind): string {
  if (value === null) return "–";
  switch (kind) {
    case "pct":
      return `${(value * 100).toFixed(1)}%`;
    case "rank":
      return value.toFixed(2);
    case "count":
      return String(value);
    case "usd":
      return `$${value.toFixed(2)}`;
    case "ms":
      return formatDuration(value);
  }
}

function formatDelta(a: number | null, b: number | null, kind: MetricKind): string {
  if (a === null || b === null) return "–";
  const d = b - a;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const abs = Math.abs(d);
  switch (kind) {
    case "pct":
      return `${sign}${(abs * 100).toFixed(1)}pp`;
    case "rank":
      return `${sign}${abs.toFixed(2)}`;
    case "count":
      return `${sign}${abs}`;
    case "usd":
      return `${sign}$${abs.toFixed(2)}`;
    case "ms":
      return `${sign}${formatDuration(abs)}`;
  }
}

export function metricsTable(m: RunMetrics): string {
  const rows = METRIC_ROWS.map((r) => {
    let value = formatMetric(m[r.key], r.kind);
    if (r.key === "firstHitRank") value += ` (n=${m.firstHitCases})`;
    return `| ${r.label} | ${value} |`;
  });
  return ["| 지표 | 값 |", "| --- | --- |", ...rows].join("\n");
}

export function compareTable(a: RunMetrics, b: RunMetrics, labels: [string, string]): string {
  const rows = METRIC_ROWS.map(
    (r) => `| ${r.label} | ${formatMetric(a[r.key], r.kind)} | ${formatMetric(b[r.key], r.kind)} | ${formatDelta(a[r.key], b[r.key], r.kind)} |`,
  );
  return [`| 지표 | ${labels[0]} | ${labels[1]} | 변화 |`, "| --- | --- | --- | --- |", ...rows].join("\n");
}
