// Collects eval cases from a repo's recent merged PRs (SZZ-lite, see szz.ts).
//
//   npm run eval:collect -- --repo owner/name [--scan 300] [--max 30] [--cases eval/cases.json]
//
// Uses the core REST API only (no search API): one list call per 100 PRs, then
// a few calls per fix candidate.

import { parseArgs } from "node:util";
import { parsePatch } from "@/lib/diff";
import {
  fetchMergedPullMeta,
  fetchPullFiles,
  fetchRecentMergedPulls,
  GitHubError,
  type GitHubFile,
} from "@/lib/github";
import { isValidOwner, isValidRepo } from "@/lib/github-url";
import { buildPrData } from "@/lib/pipeline";
import type { PrMeta } from "@/lib/types";
import { caseId, DEFAULT_CASES_PATH, mergeCases, readCases, writeCases, type EvalCase } from "./cases";
import { terminalSafe } from "./metrics";
import { cleanPrBody, extractRefs, isFixPr, isRevertPr, labelCase, removedLineIndex } from "./szz";

const MAX_REFS_PER_FIX = 5;

function usage(message: string): never {
  console.error(`${message}\n사용법: npm run eval:collect -- --repo owner/name [--scan 300] [--max 30] [--cases eval/cases.json]`);
  process.exit(2);
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) usage(`--${name}는 양의 정수여야 합니다: ${value}`);
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      scan: { type: "string", default: "300" },
      max: { type: "string", default: "30" },
      cases: { type: "string", default: DEFAULT_CASES_PATH },
    },
  });
  const [owner, name, extra] = (values.repo ?? "").split("/");
  if (!owner || !name || extra !== undefined || !isValidOwner(owner) || !isValidRepo(name)) {
    usage("--repo owner/name 이 필요합니다.");
  }
  const repo = `${owner}/${name}`;
  const scan = positiveInt(values.scan, "scan");
  const max = positiveInt(values.max, "max");

  const stats = {
    merged: 0,
    fixCandidates: 0,
    reverts: 0,
    known: 0,
    checked: 0,
    notMergedPr: 0,
    later: 0,
    "no-match": 0,
    "noise-only": 0,
    "too-many": 0,
    errors: 0,
  };

  console.error(`${repo}: 최근 닫힌 PR ${scan}개를 훑는 중…`);
  const pulls = await fetchRecentMergedPulls(owner, name, scan);
  stats.merged = pulls.length;

  const existing = await readCases(values.cases);
  const knownIds = new Set(existing.map((c) => c.id));
  const files = new Map<number, Promise<GitHubFile[]>>();
  const pullFiles = (number: number) => {
    if (!files.has(number)) files.set(number, fetchPullFiles({ owner, repo: name, number }));
    return files.get(number)!;
  };
  const metas = new Map<number, Promise<PrMeta | null>>();
  const mergedMeta = (number: number) => {
    if (!metas.has(number)) metas.set(number, fetchMergedPullMeta(owner, name, number));
    return metas.get(number)!;
  };

  const found: EvalCase[] = [];
  scanLoop: for (const fix of pulls) {
    const body = fix.body ?? "";
    if (!isFixPr(fix.title, body)) continue;
    if (isRevertPr(fix.title, body)) {
      stats.reverts++;
      continue;
    }
    const refs = extractRefs(`${fix.title}\n${cleanPrBody(body)}`, owner, name, fix.number).slice(0, MAX_REFS_PER_FIX);
    if (refs.length === 0) continue;
    stats.fixCandidates++;

    for (const bugNumber of refs) {
      const id = caseId(repo, bugNumber, fix.number);
      if (knownIds.has(id)) {
        stats.known++;
        continue;
      }
      // A PR opened after the fix is a follow-up, not the cause.
      if (bugNumber > fix.number) {
        stats.later++;
        continue;
      }
      stats.checked++;
      try {
        const meta = await mergedMeta(bugNumber);
        if (!meta) {
          stats.notMergedPr++;
          continue;
        }
        const bug = buildPrData(meta, await pullFiles(bugNumber));
        const fixFiles = (await pullFiles(fix.number)).map((f) => ({
          filename: f.filename,
          previousFilename: f.previous_filename,
          hunks: f.patch ? parsePatch(f.patch, 0) : [],
        }));
        const verdict = labelCase(bug.files, removedLineIndex(fixFiles));
        if (!verdict.ok) {
          stats[verdict.reason]++;
          continue;
        }
        found.push({
          id,
          repo,
          pr: bugNumber,
          prUrl: meta.htmlUrl,
          title: meta.title,
          headSha: meta.headSha,
          fixPr: fix.number,
          fixUrl: `https://github.com/${repo}/pull/${fix.number}`,
          fixTitle: fix.title,
          keptHunks: verdict.keptHunks,
          buggy: verdict.buggy,
          collectedAt: new Date().toISOString(),
        });
        console.error(
          `  + #${bugNumber} ← 수정 #${fix.number}: 정답 ${verdict.buggy.length}개 / 분석 대상 ${verdict.keptHunks}개`,
        );
        if (found.length >= max) break scanLoop;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof GitHubError && message.includes("사용 한도")) {
          console.error(`  GitHub API 한도에 걸려 여기서 멈춥니다. 지금까지 찾은 케이스는 저장합니다.\n  ${terminalSafe(message)}`);
          break scanLoop;
        }
        stats.errors++;
        console.error(`  ! #${bugNumber} ← #${fix.number}: ${terminalSafe(message)}`);
      }
    }
  }

  const merged = mergeCases(existing, found);
  await writeCases(values.cases, merged);

  const out: string[] = [
    `## ${repo} 수집 결과`,
    "",
    `- 훑은 닫힌 PR ${scan}개 중 머지된 PR ${stats.merged}개`,
    `- 수정 PR 후보(키워드 + 같은 레포 참조) ${stats.fixCandidates}개, 되돌리기(revert) 제외 ${stats.reverts}개`,
    `- 참조 검사 ${stats.checked}건: 머지된 PR 아님(이슈 등) ${stats.notMergedPr}, 겹치는 줄 없음 ${stats["no-match"]}, ` +
      `노이즈 파일에서만 겹침 ${stats["noise-only"]}, 정답이 50% 초과 ${stats["too-many"]}, 오류 ${stats.errors}`,
    `- 수정 PR보다 나중 PR 참조 제외 ${stats.later}건, 이미 있는 케이스 ${stats.known}건`,
    `- **새 케이스 ${found.length}개** → ${values.cases} (전체 ${merged.length}개)`,
  ];
  if (found.length > 0) {
    out.push("", "| 케이스 | 원인 PR | 정답/분석 대상 | 예시 줄 |", "| --- | --- | --- | --- |");
    for (const c of found) {
      // Titles and code come from the PR: no terminal escapes.
      const sample = terminalSafe(c.buggy[0].sample).replace(/\|/g, "\\|");
      const title = terminalSafe(c.title).replace(/\|/g, "\\|");
      out.push(`| ${c.id} | ${title} | ${c.buggy.length}/${c.keptHunks} | \`${sample}\` |`);
    }
  }
  out.push(
    "",
    "자동 라벨은 노이즈가 있습니다. 원인 PR과 수정 PR을 몇 개 직접 열어 정답 hunk가 그럴듯한지 확인하세요.",
  );
  console.log(out.join("\n"));
}

main().catch((err) => {
  console.error(terminalSafe(err instanceof Error ? err.message : String(err), true));
  process.exit(1);
});
