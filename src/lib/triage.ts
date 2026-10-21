import { hunkSideRange } from "./diff";
import { planIncremental, type IncrementalPlan, type PreviousAnalysis } from "./incremental";
import { collectRepoFiles, validateLookAt, type LookAtContext } from "./lookat";
import { buildTriagePrompt, keptFiles, PROMPT_BUDGET_CHARS, triageSystemPrompt } from "./prompt";
import { triageOutputSchema, type TriageOutput } from "./triage-schema";
import type {
  Activity,
  Category,
  FileRole,
  HighlightRef,
  Hunk,
  PrData,
  ReviewMode,
  ReviewResult,
  TriageItem,
} from "./types";
import type { RunClaude } from "./claude";

export const TITLE_MAX = 40;
export const UNCLASSIFIED_WHY = "AI가 분류하지 않음";
const MAX_HIGHLIGHTS = 10;

const FALLBACK_CATEGORY: Record<FileRole, Category> = {
  source: "logic",
  test: "test",
  docs: "docs",
  config: "config",
};

export type TriageReview = Omit<ReviewResult, "cached" | "analyzedAt">;

function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function clampHighlights(hunk: Hunk, highlights: HighlightRef[]): HighlightRef[] {
  const ranges = { old: hunkSideRange(hunk, "old"), new: hunkSideRange(hunk, "new") };
  const seen = new Set<string>();
  const out: HighlightRef[] = [];
  for (const h of highlights) {
    const range = ranges[h.side];
    if (!range) continue;
    const line = Math.min(Math.max(h.line, range[0]), range[1]);
    const key = `${h.side}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ side: h.side, line });
    if (out.length >= MAX_HIGHLIGHTS) break;
  }
  return out;
}

export interface MergeOptions {
  /** Where lookAt entries may point (see lookat.ts). */
  lookAt: LookAtContext;
  /** Items carried over from a previous analysis, already re-targeted to current hunk ids. */
  inherited?: TriageItem[];
  /** Hunks with no counterpart in the previous analysis; null when there is no previous one. */
  newHunkIds?: Set<string> | null;
}

/**
 * Reconciles Claude's raw output with the hunks that were actually sent:
 * drops unknown/duplicate ids, fills in missing hunks as skim, clamps
 * highlight lines, validates lookAt, adds inherited items, and repairs
 * the reading order over everything.
 */
export function mergeTriage(
  pr: PrData,
  includedHunkIds: string[],
  raw: TriageOutput,
  options: MergeOptions,
): Pick<TriageReview, "summary" | "readingOrder" | "items"> {
  const hunkById = new Map<string, { hunk: Hunk; role: FileRole; path: string }>();
  for (const file of keptFiles(pr)) {
    for (const hunk of file.hunks) hunkById.set(hunk.id, { hunk, role: file.role, path: file.filename });
  }
  const included = new Set(includedHunkIds.filter((id) => hunkById.has(id)));
  const inheritedById = new Map(
    (options.inherited ?? []).filter((i) => hunkById.has(i.hunkId) && !included.has(i.hunkId)).map((i) => [i.hunkId, i]),
  );

  const finish = (item: TriageItem): TriageItem => {
    const { hunk, path } = hunkById.get(item.hunkId)!;
    const newRange = hunkSideRange(hunk, "new");
    return {
      ...item,
      highlight: clampHighlights(hunk, item.highlight),
      lookAt: validateLookAt(item.lookAt, options.lookAt, {
        path,
        newStart: newRange?.[0] ?? 0,
        newEnd: newRange?.[1] ?? -1,
      }),
      isNew: options.newHunkIds?.has(item.hunkId) ?? false,
    };
  };

  const byId = new Map<string, TriageItem>();
  for (const item of raw.items) {
    if (!included.has(item.hunkId) || byId.has(item.hunkId)) continue;
    byId.set(item.hunkId, {
      hunkId: item.hunkId,
      priority: item.priority,
      category: item.category,
      title: truncate(item.title, TITLE_MAX) || "제목 없음",
      explain: item.explain.trim(),
      why: item.why.trim(),
      check: item.check.trim(),
      highlight: item.highlight,
      lookAt: item.lookAt,
      isNew: false,
      source: "ai",
    });
  }

  // Diff order for the final list; fill gaps with a visible fallback.
  const items: TriageItem[] = [];
  for (const [id, { role }] of hunkById) {
    const existing = byId.get(id) ?? inheritedById.get(id);
    if (existing) {
      items.push(finish(existing));
    } else if (included.has(id)) {
      items.push(
        finish({
          hunkId: id,
          priority: "skim",
          category: FALLBACK_CATEGORY[role],
          title: "분류되지 않은 변경",
          explain: "",
          why: UNCLASSIFIED_WHY,
          check: "",
          highlight: [],
          lookAt: [],
          isNew: false,
          source: "fallback",
        }),
      );
    }
  }

  const finalById = new Map(items.map((i) => [i.hunkId, i]));
  const isReadable = (id: string) => {
    const p = finalById.get(id)?.priority;
    return p === "must" || p === "should";
  };
  const readingOrder: string[] = [];
  const inOrder = new Set<string>();
  for (const id of raw.readingOrder) {
    if (isReadable(id) && !inOrder.has(id)) {
      readingOrder.push(id);
      inOrder.add(id);
    }
  }
  for (const priority of ["must", "should"] as const) {
    for (const item of items) {
      if (item.priority === priority && !inOrder.has(item.hunkId)) {
        readingOrder.push(item.hunkId);
        inOrder.add(item.hunkId);
      }
    }
  }

  return {
    summary: raw.summary.trim() || "요약을 생성하지 못했습니다.",
    readingOrder,
    items,
  };
}

/** Where lookAt entries may point: checkout files (deep) or the PR's own files (fast). */
export async function buildLookAtContext(
  pr: PrData,
  repoDir: string | undefined,
  candidates: TriageItem[] | TriageOutput["items"],
): Promise<LookAtContext> {
  if (!repoDir) return { files: new Map(pr.files.map((f) => [f.filename, null])) };
  const paths = candidates.flatMap((i) => i.lookAt.map((l) => l.path));
  return { files: await collectRepoFiles(repoDir, paths) };
}

export interface TriageOptions {
  runClaude: RunClaude;
  signal?: AbortSignal;
  budgetChars?: number;
  /** Deep mode: the checkout Claude may read. Absent = fast (diff-only). */
  repoDir?: string;
  maxBudgetUsd?: number;
  onActivity?: (activity: Activity) => void;
  /** Latest analysis of an earlier head SHA of the same PR. */
  previous?: PreviousAnalysis | null;
  /** False on "다시 분석": still report the delta, but send every hunk. */
  allowInherit?: boolean;
}

export async function triagePr(pr: PrData, options: TriageOptions): Promise<TriageReview> {
  const mode: ReviewMode = options.repoDir ? "deep" : "fast";
  const plan: IncrementalPlan | null = options.previous
    ? planIncremental(pr, options.previous, { allowInherit: options.allowInherit ?? true })
    : null;
  const inherited = plan && plan.kind !== "full" ? plan.inherited : [];
  const common = {
    mode,
    warnings: [] as string[],
    previous: plan?.previous ?? null,
  };
  const mergeBase = { inherited, newHunkIds: plan?.newHunkIds ?? null };
  /** Every hunk sent in this run is analyzed fresh, including unchanged ones without an inheritable item. */
  const deltaFor = (sentIds: string[]) =>
    plan ? { ...plan.delta, reanalyzed: sentIds.filter((id) => !plan.newHunkIds.has(id)).length } : null;

  if (plan?.kind === "reuse") {
    const lookAt = await buildLookAtContext(pr, options.repoDir, inherited);
    const merged = mergeTriage(
      pr,
      [],
      { summary: plan.previousSummary, readingOrder: plan.mappedReadingOrder, items: [] },
      { ...mergeBase, lookAt },
    );
    return {
      ...common,
      ...merged,
      delta: deltaFor([]),
      omitted: [],
      sentHunkIds: [],
      costUsd: null,
      durationMs: null,
      toolCalls: null,
    };
  }

  const { prompt, includedHunkIds, omitted } = buildTriagePrompt(pr, {
    mode,
    budgetChars: options.budgetChars ?? PROMPT_BUDGET_CHARS,
    hunkIds: plan ? plan.sendIds : undefined,
    inherited: plan?.kind === "partial" ? { items: inherited, previousSummary: plan.previousSummary } : undefined,
  });

  if (includedHunkIds.length === 0) {
    const lookAt = await buildLookAtContext(pr, options.repoDir, inherited);
    const merged = mergeTriage(
      pr,
      [],
      { summary: plan?.previousSummary ?? "", readingOrder: plan?.mappedReadingOrder ?? [], items: [] },
      { ...mergeBase, lookAt },
    );
    return {
      ...common,
      ...merged,
      summary:
        inherited.length > 0
          ? merged.summary
          : omitted.length > 0
            ? "변경이 너무 커서 Claude에게 보낼 수 있는 코드 조각이 없습니다. 아래 '확인 필요' 목록을 직접 확인하세요."
            : "Claude가 읽을 코드 변경이 없습니다. 모든 파일이 노이즈로 분류되었거나 diff가 제공되지 않았습니다.",
      delta: deltaFor([]),
      omitted,
      sentHunkIds: [],
      costUsd: null,
      durationMs: null,
      toolCalls: null,
    };
  }

  const result = await options.runClaude(triageSystemPrompt(mode), prompt, triageOutputSchema, {
    signal: options.signal,
    repoDir: options.repoDir,
    maxBudgetUsd: options.maxBudgetUsd,
    onActivity: options.onActivity,
  });
  const lookAt = await buildLookAtContext(pr, options.repoDir, [...result.data.items, ...inherited]);
  const merged = mergeTriage(pr, includedHunkIds, result.data, { ...mergeBase, lookAt });

  const warnings: string[] = [];
  if (result.permissionDenials > 0) {
    warnings.push(
      `PR 내용이 레포 밖 파일 접근을 유도했을 수 있음: ${result.permissionDenials}건 차단됨. 해당 PR의 설명과 코드에 이상한 지시문이 없는지 확인하세요.`,
    );
  }

  return {
    ...common,
    ...merged,
    warnings,
    delta: deltaFor(includedHunkIds),
    omitted,
    sentHunkIds: includedHunkIds,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    toolCalls: mode === "deep" ? result.toolCalls : null,
  };
}
