// Compares the last two eval runs (eval/runs/*.json) metric by metric.
//
//   npm run eval:report -- [--mode deep|fast]
//
// Metrics are recomputed from the stored per-case placements with the current
// metric code, so old runs stay comparable after a metric change.

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { RUNS_DIR, type CaseRecord, type RunFile } from "./cases";
import { aggregate, compareTable, PLACEMENTS, terminalSafe, type Placement } from "./metrics";

/** The best place any of a case's buggy hunks landed (must beats should, …). */
function best(record: CaseRecord): Placement | "error" {
  if (record.error) return "error";
  const ranked = record.placements.map((p) => PLACEMENTS.indexOf(p.placement));
  return ranked.length > 0 ? PLACEMENTS[Math.min(...ranked)] : "missing";
}

function describe(run: RunFile, file: string): string {
  return `\`${file}\` — ${run.mode}${run.model ? ` (${run.model})` : ""}, 케이스 ${run.cases.length}개, ${run.startedAt}`;
}

async function main() {
  const { values } = parseArgs({ options: { mode: { type: "string" } } });
  const dir = path.resolve(RUNS_DIR);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();

  const runs: Array<{ file: string; run: RunFile }> = [];
  for (const name of names) {
    const run = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as RunFile;
    if (run.version !== 1 || !Array.isArray(run.cases)) continue;
    if (values.mode && run.mode !== values.mode) continue;
    runs.push({ file: name, run });
  }
  if (runs.length < 2) {
    console.error(`비교하려면 실행 결과가 2개 이상 필요합니다 (${dir}${values.mode ? `, ${values.mode} 모드` : ""}: ${runs.length}개).`);
    process.exit(1);
  }

  const [a, b] = runs.slice(-2);
  const idsA = new Set(a.run.cases.map((c) => c.id));
  const idsB = new Set(b.run.cases.map((c) => c.id));
  const common = [...idsB].filter((id) => idsA.has(id));

  const lines = [
    "## eval 비교",
    "",
    `- 이전: ${describe(a.run, a.file)}`,
    `- 최신: ${describe(b.run, b.file)}`,
  ];
  if (common.length !== idsA.size || common.length !== idsB.size) {
    lines.push(
      `- 주의: 케이스 구성이 다릅니다 (공통 ${common.length}개, 이전에만 ${idsA.size - common.length}개, 최신에만 ${idsB.size - common.length}개). 차이는 케이스 차이일 수 있습니다.`,
    );
  }
  lines.push("", compareTable(aggregate(a.run.cases), aggregate(b.run.cases), ["이전", "최신"]));

  const byIdA = new Map(a.run.cases.map((c) => [c.id, c]));
  const changed = b.run.cases
    .filter((c) => byIdA.has(c.id))
    .map((c) => ({ id: c.id, from: best(byIdA.get(c.id)!), to: best(c) }))
    .filter((d) => d.from !== d.to);
  lines.push("", `### 가장 좋은 정답 위치가 바뀐 케이스 (${changed.length}/${common.length})`);
  if (changed.length > 0) {
    lines.push("", "| 케이스 | 이전 | 최신 |", "| --- | --- | --- |", ...changed.map((d) => `| ${terminalSafe(d.id)} | ${d.from} | ${d.to} |`));
  }
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(terminalSafe(err instanceof Error ? err.message : String(err), true));
  process.exit(1);
});
