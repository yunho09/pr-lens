// Dev-only: build a "previous analysis" cache entry for a PR as it was at an
// earlier commit, so the incremental path (inherit unchanged hunks, send only
// new ones) can be exercised end to end.
//
//   npx tsx scripts/simulate-incremental.ts <PR URL> <earlier commit SHA> [--mode deep|fast]
//
// Then analyze the PR normally (UI or POST /api/review): the new run diffs
// against this entry. Note: this runs one real Claude call on the old state.

import { parseArgs } from "node:util";
import { CACHE_VERSION, writeCache, cacheDir, cacheFileName } from "@/lib/cache";
import { ensureCheckout } from "@/lib/checkout";
import { runClaude } from "@/lib/claude";
import { fetchCompareFiles, fetchPullMeta, resolveCommitSha } from "@/lib/github";
import { parsePrUrl } from "@/lib/github-url";
import { buildPrData } from "@/lib/pipeline";
import { keptFiles } from "@/lib/prompt";
import { triagePr } from "@/lib/triage";
import type { ReviewMode } from "@/lib/types";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { mode: { type: "string", default: "deep" } },
  });
  const [url, commitish] = positionals;
  const mode = values.mode as ReviewMode;
  if (!url || !commitish || (mode !== "deep" && mode !== "fast")) {
    console.error("사용법: npx tsx scripts/simulate-incremental.ts <PR 링크> <이전 커밋 SHA> [--mode deep|fast]");
    process.exit(2);
  }
  const parsed = parsePrUrl(url);
  if (!parsed.ok) throw new Error(parsed.message);
  const { owner, repo } = parsed.ref;

  const current = await fetchPullMeta(parsed.ref);
  const earlierSha = await resolveCommitSha(owner, repo, commitish);
  if (earlierSha === current.headSha) {
    throw new Error("이전 커밋이 PR의 현재 head와 같습니다. 더 이른 커밋을 지정하세요.");
  }
  if (!current.baseSha) throw new Error("PR의 base SHA를 알 수 없습니다.");

  // PR state at the earlier commit: changes from the merge base of base..earlier.
  const files = await fetchCompareFiles(owner, repo, current.baseSha, earlierSha);
  const meta = {
    ...current,
    headSha: earlierSha,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
  };
  const pr = buildPrData(meta, files);
  const keptHunks = keptFiles(pr).reduce((n, f) => n + f.hunks.length, 0);
  console.log(`이전 상태 ${earlierSha.slice(0, 7)}: 파일 ${files.length}개, 분석 대상 코드 조각 ${keptHunks}개 (현재 head ${current.headSha.slice(0, 7)})`);

  let checkout: Awaited<ReturnType<typeof ensureCheckout>> | undefined;
  const warnings: string[] = [];
  if (mode === "deep") {
    try {
      checkout = await ensureCheckout(meta);
    } catch (err) {
      warnings.push(`레포를 내려받지 못해 diff만 분석했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const started = Date.now();
  let tools = 0;
  const review = await triagePr(pr, {
    runClaude,
    repoDir: checkout?.dir,
    onActivity: () => {
      tools++;
      process.stdout.write(".");
    },
  });
  checkout?.release();
  if (tools > 0) process.stdout.write("\n");

  await writeCache({
    version: CACHE_VERSION,
    requestedMode: mode,
    pr,
    review: { ...review, warnings: [...warnings, ...review.warnings], analyzedAt: new Date().toISOString() },
  });

  const count = (p: string) => review.items.filter((i) => i.priority === p).length;
  console.log(
    `이전 분석 저장: ${cacheDir()}/${cacheFileName(meta, mode)}\n` +
      `  모드 ${review.mode}, 항목 ${review.items.length}개 (must ${count("must")} / should ${count("should")} / skim ${count("skim")}), ` +
      `도구 ${review.toolCalls ?? 0}회, 비용 $${(review.costUsd ?? 0).toFixed(4)}, ${((Date.now() - started) / 1000).toFixed(1)}초`,
  );
  console.log(`이제 ${url} 를 평소처럼 (${mode} 모드로) 분석하면 이 결과와 비교해 바뀐 부분만 Claude에게 보냅니다.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
