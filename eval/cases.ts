import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReviewMode } from "@/lib/types";
import type { CaseOutcome, RunMetrics } from "./metrics";
import type { BuggyHunk } from "./szz";

// Eval data files: eval/cases.json (labels) and eval/runs/*.json (scored runs).

export const DEFAULT_CASES_PATH = path.join("eval", "cases.json");

/** One labeled PR: B introduced the bug, F (fixPr) fixed it. */
export interface EvalCase {
  id: string;
  /** "owner/name" */
  repo: string;
  pr: number;
  prUrl: string;
  title: string;
  headSha: string;
  fixPr: number;
  fixUrl: string;
  fixTitle: string;
  /** B's hunks that reach Claude, at collection time. */
  keptHunks: number;
  buggy: BuggyHunk[];
  collectedAt: string;
}

export function caseId(repo: string, pr: number, fixPr: number): string {
  return `${repo}#${pr}-fix#${fixPr}`;
}

export async function readCases(file: string): Promise<EvalCase[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error(`${file}: 케이스 배열이 아닙니다.`);
  return raw as EvalCase[];
}

/** Incoming cases replace existing ones with the same id; order is kept. */
export function mergeCases(existing: EvalCase[], incoming: EvalCase[]): EvalCase[] {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()];
}

export async function writeCases(file: string, cases: EvalCase[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(cases, null, 2)}\n`, "utf8");
}

export const RUNS_DIR = path.join("eval", "runs");

export interface CaseRecord extends CaseOutcome {
  prUrl: string;
  fixUrl: string;
  title: string;
  /** Mode that actually ran (deep falls back to fast when the checkout fails). */
  modeUsed: ReviewMode | null;
  shouldCount: number;
  firstHitRank: number | null;
  toolCalls: number | null;
  warnings: string[];
  /** Ways the analysis was not a full one (previous result, inheritance, unsent hunks). */
  violations: string[];
}

export interface RunFile {
  version: 1;
  mode: ReviewMode;
  model: string | null;
  startedAt: string;
  finishedAt: string;
  casesFile: string;
  limit: number | null;
  concurrency: number;
  metrics: RunMetrics;
  cases: CaseRecord[];
}
