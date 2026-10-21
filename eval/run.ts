// Runs the review pipeline on each case's bug PR and scores where the labeled
// buggy hunks landed. Spends Claude plan quota: start with --limit.
//
//   npm run eval:run -- [--mode deep|fast] [--limit N] [--concurrency 2] [--cases eval/cases.json]
//
// Every analysis is a full one (refresh, no inheritance). Results are cached in
// .cache/eval/reviews/ (PR_LENS_CACHE_DIR) to keep them out of the app's
// .cache/reviews/ ("최근 분석" list). Deep-mode checkouts share the app's
// ${XDG_CACHE_HOME:-~/.cache}/pr-lens/repos/.

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runReview, type ReviewRequest } from "@/lib/pipeline";
import type { PrData, ReviewMode, ReviewResult } from "@/lib/types";
import { DEFAULT_CASES_PATH, readCases, RUNS_DIR, type CaseRecord, type EvalCase, type RunFile } from "./cases";
import {
  aggregate,
  firstHitRank,
  formatMetric,
  fullAnalysisViolations,
  keptHunkCount,
  metricsTable,
  placeBuggyHunks,
  terminalSafe,
} from "./metrics";

interface Analysis {
  pr?: PrData;
  review?: ReviewResult;
  error?: string;
  wallMs: number;
}

function usage(message: string): never {
  console.error(
    `${message}\n사용법: npm run eval:run -- [--mode deep|fast] [--limit N] [--concurrency 2] [--cases eval/cases.json]`,
  );
  process.exit(2);
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) usage(`--${name}는 양의 정수여야 합니다: ${value}`);
  return n;
}

async function analyze(url: string, mode: ReviewMode, signal: AbortSignal): Promise<Analysis> {
  const started = Date.now();
  const got: Omit<Analysis, "wallMs"> = {};
  const request: ReviewRequest = { url, refresh: true, mode };
  try {
    await runReview(
      request,
      (event) => {
        if (event.type === "pr") got.pr = event.data;
        else if (event.type === "result") got.review = event.data;
        else if (event.type === "error") got.error = event.message;
      },
      signal,
    );
  } catch (err) {
    got.error = err instanceof Error ? err.message : String(err);
  }
  if (!got.error && (!got.pr || !got.review)) got.error = "결과 없이 끝났습니다.";
  return { ...got, wallMs: Date.now() - started };
}

function score(c: EvalCase, key: string, a: Analysis): CaseRecord {
  const base = { id: c.id, analysisKey: key, prUrl: c.prUrl, fixUrl: c.fixUrl, title: c.title, durationMs: a.wallMs };
  if (a.error || !a.pr || !a.review) {
    return {
      ...base,
      placements: [],
      keptHunks: 0,
      mustCount: 0,
      shouldCount: 0,
      costUsd: null,
      modeUsed: null,
      firstHitRank: null,
      toolCalls: null,
      warnings: [],
      violations: [],
      error: a.error ?? "결과 없음",
    };
  }
  const { pr, review } = a;
  const placements = placeBuggyHunks(pr, review, c.buggy);
  const warnings = [...review.warnings];
  if (pr.meta.headSha !== c.headSha) warnings.push(`head SHA가 수집 때와 다름 (${c.headSha.slice(0, 7)} → ${pr.meta.headSha.slice(0, 7)})`);
  return {
    ...base,
    placements,
    keptHunks: keptHunkCount(pr),
    mustCount: review.items.filter((i) => i.priority === "must").length,
    shouldCount: review.items.filter((i) => i.priority === "should").length,
    costUsd: review.costUsd,
    modeUsed: review.mode,
    firstHitRank: firstHitRank(placements),
    toolCalls: review.toolCalls,
    warnings,
    violations: fullAnalysisViolations(pr, review),
  };
}

/** Table cell from untrusted text (error messages may quote PR content). */
const cell = (s: string) => terminalSafe(s).replace(/\|/g, "\\|");

function caseTable(records: CaseRecord[]): string {
  const rows = records.map((r) => {
    const name = `[${cell(r.id)}](${cell(r.prUrl)})`;
    if (r.error) return `| ${name} | 오류: ${cell(r.error).slice(0, 120)} | – | – | – | ${formatMetric(r.durationMs, "ms")} |`;
    const where = r.placements.map((p) => p.placement).join(", ");
    const mode = r.modeUsed ? ` (${r.modeUsed})` : "";
    return (
      `| ${name} | ${where} | ${r.firstHitRank ?? "–"} | ${r.mustCount}/${r.keptHunks} | ` +
      `${formatMetric(r.costUsd, "usd")} | ${formatMetric(r.durationMs, "ms")}${mode} |`
    );
  });
  return ["| 케이스 | 정답 hunk 위치 | 첫 정답 순위 | must/분석 대상 | 비용 | 시간 |", "| --- | --- | --- | --- | --- | --- |", ...rows].join(
    "\n",
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "deep" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "2" },
      cases: { type: "string", default: DEFAULT_CASES_PATH },
    },
  });
  const mode = values.mode as ReviewMode;
  if (mode !== "deep" && mode !== "fast") usage(`--mode는 deep 또는 fast: ${values.mode}`);
  const limit = values.limit === undefined ? null : positiveInt(values.limit, "limit");
  const concurrency = positiveInt(values.concurrency, "concurrency");

  const root = process.cwd();
  const casesFile = path.resolve(root, values.cases);
  const all = await readCases(casesFile);
  const cases = limit === null ? all : all.slice(0, limit);
  if (cases.length === 0) usage(`${casesFile}에 케이스가 없습니다. 먼저 npm run eval:collect 를 실행하세요.`);

  // Cases that share a bug PR share one analysis.
  const analysisKey = (c: EvalCase) => `${c.repo}#${c.pr}`;
  const urls = new Map<string, string>();
  for (const c of cases) if (!urls.has(analysisKey(c))) urls.set(analysisKey(c), c.prUrl);
  const keys = [...urls.keys()];

  // Read by the lib's cacheDir() on every cache access.
  process.env.PR_LENS_CACHE_DIR = path.join(root, ".cache", "eval", "reviews");

  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.error("\n중단합니다. 진행 중인 Claude 호출을 끝내고 지금까지 결과를 저장합니다…");
    controller.abort();
  });

  const startedAt = new Date().toISOString();
  console.error(`eval: ${mode} 모드, 케이스 ${cases.length}개 (PR ${keys.length}개), 동시 ${concurrency}개`);

  const results = new Map<string, Analysis>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      const a = controller.signal.aborted
        ? { error: "중단됨", wallMs: 0 }
        : await analyze(urls.get(key)!, mode, controller.signal);
      results.set(key, a);
      done++;
      const info = a.error
        ? `오류: ${terminalSafe(a.error.slice(0, 160))}`
        : `${formatMetric(a.review!.costUsd, "usd")}, ${formatMetric(a.wallMs, "ms")}`;
      console.error(`  [${done}/${keys.length}] ${key} — ${info}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));

  const records = cases.map((c) => score(c, analysisKey(c), results.get(analysisKey(c))!));
  const metrics = aggregate(records);
  const run: RunFile = {
    version: 1,
    mode,
    model: process.env.PR_LENS_MODEL?.trim() || null,
    startedAt,
    finishedAt: new Date().toISOString(),
    casesFile: path.relative(root, casesFile),
    limit,
    concurrency,
    metrics,
    cases: records,
  };

  const runsDir = path.join(root, RUNS_DIR);
  await fs.mkdir(runsDir, { recursive: true });
  const outFile = path.join(runsDir, `${startedAt.slice(0, 19).replace(/:/g, "-")}Z-${mode}.json`);
  await fs.writeFile(outFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const fallbacks = records.filter((r) => r.modeUsed && r.modeUsed !== mode).length;
  const lines = [
    `## eval 결과 — ${mode} 모드, 케이스 ${cases.length}개`,
    "",
    metricsTable(metrics),
    "",
    "### 케이스별",
    "",
    caseTable(records),
    "",
    `저장: ${path.relative(root, outFile)}`,
  ];
  if (fallbacks > 0) lines.push(`주의: ${fallbacks}개 케이스는 deep 대신 fast로 분석됐습니다 (레포 내려받기 실패).`);
  const warned = records.filter((r) => r.warnings.length > 0);
  for (const r of warned) lines.push(`- ${terminalSafe(r.id)}: ${terminalSafe(r.warnings.join(" / "))}`);
  const violated = records.filter((r) => r.violations.length > 0);
  if (violated.length > 0) {
    lines.push("", `**전체 분석 위반 ${violated.length}건** — 이전 결과를 물려받았거나 보내지 않은 hunk가 있어 이 실행은 믿을 수 없습니다:`);
    for (const r of violated) lines.push(`- ${terminalSafe(r.id)}: ${r.violations.join(" / ")}`);
  } else {
    const analyzed = records.filter((r) => !r.error).length;
    lines.push(`전체 분석 확인: 결과가 나온 케이스 ${analyzed}개 모두 previous 없음 · 상속 없음 · 분석 대상 hunk 전부 전송.`);
  }
  console.log(lines.join("\n"));
  if (violated.length > 0) process.exitCode = 1;
  if (controller.signal.aborted) process.exitCode = 130;
}

main().catch((err) => {
  console.error(terminalSafe(err instanceof Error ? err.message : String(err), true));
  process.exit(1);
});
