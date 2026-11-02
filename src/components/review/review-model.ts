import type { Activity, PrFile, Priority, ReviewResult, TriageItem } from "@/lib/types";

// Pure view logic for the review page: what to show, in which order.

/**
 * What the "새로 분석한 것만" filter keeps: every item Claude classified in this
 * run (new hunks, plus unchanged ones that were unclassified or omitted before,
 * i.e. `sentHunkIds`) and every must, even an inherited one. It only hides
 * inherited should/skim items.
 */
function keptByFilter(item: TriageItem): boolean {
  return item.source !== "inherited" || item.priority === "must";
}

/** The filter starts on (and can be used) when there is a previous analysis and it would both show and hide something. */
export function defaultOnlyNew(result: Pick<ReviewResult, "previous" | "items">): boolean {
  return (
    result.previous !== null &&
    result.items.some((i) => i.source !== "inherited") &&
    !result.items.every(keptByFilter)
  );
}

export interface ReadingPlan {
  /** 추천 동선: readingOrder items that pass the filter, in order. */
  steps: TriageItem[];
  must: TriageItem[];
  should: TriageItem[];
  skim: TriageItem[];
  /** Inherited should/skim items the filter hides, per priority (must is never hidden). */
  hidden: Record<Priority, number>;
}

/**
 * Splits items into the priority sections, each ordered by readingOrder (items
 * missing from it keep their original order at the end). With `onlyNew`, keeps
 * items analyzed in this run plus every must (see keptByFilter).
 */
export function buildReadingPlan(result: Pick<ReviewResult, "readingOrder" | "items">, onlyNew: boolean): ReadingPlan {
  const visible = (item: TriageItem) => !onlyNew || keptByFilter(item);
  const byId = new Map(result.items.map((i) => [i.hunkId, i]));
  const rank = new Map<string, number>();
  for (const id of result.readingOrder) if (!rank.has(id)) rank.set(id, rank.size);

  const steps = [...rank.keys()]
    .map((id) => byId.get(id))
    .filter((i): i is TriageItem => i !== undefined && visible(i));

  const section = (priority: Priority) => {
    const all = result.items
      .filter((i) => i.priority === priority)
      .map((item, index) => ({ item, key: rank.get(item.hunkId) ?? rank.size + index }))
      .sort((a, b) => a.key - b.key)
      .map((e) => e.item);
    const shown = all.filter(visible);
    return { shown, hidden: all.length - shown.length };
  };
  const must = section("must");
  const should = section("should");
  const skim = section("skim");

  return {
    steps,
    must: must.shown,
    should: should.shown,
    skim: skim.shown,
    hidden: { must: must.hidden, should: should.hidden, skim: skim.hidden },
  };
}

export type PriorityCounts = Record<Priority | "unanalyzed", number>;

/** A fallback item counts as unanalyzed: it is a skim card only because nothing classified it. */
export function priorityCounts(hunkIds: string[], items: TriageItem[]): PriorityCounts {
  const ids = new Set(hunkIds);
  const counts: PriorityCounts = { must: 0, should: 0, skim: 0, unanalyzed: 0 };
  for (const item of items) {
    if (ids.has(item.hunkId)) counts[item.source === "fallback" ? "unanalyzed" : item.priority]++;
  }
  return counts;
}

/** The first of these hunks with a card on screen, in reading order with priority first. */
export function firstRenderedHunk(hunkIds: string[], plan: Pick<ReadingPlan, "must" | "should" | "skim">): string | null {
  const ids = new Set(hunkIds);
  const first = [...plan.must, ...plan.should, ...plan.skim].find((item) => ids.has(item.hunkId));
  return first?.hunkId ?? null;
}

export type JumpTarget = { kind: "card"; hunkId: string } | { kind: "attention" };

/**
 * Where an area row leads: its first card, unless all it shows is 🟣. Then it
 * leads to that code, its own fallback card or the 🟣 section, not to an ordinary ⚪ card.
 */
export function areaTarget(
  row: Pick<AreaRow, "firstHunkIds" | "must" | "should" | "unanalyzed">,
  plan: Pick<ReadingPlan, "must" | "should" | "skim">,
  attentionCount: number,
): JumpTarget | null {
  const attention: JumpTarget | null = row.unanalyzed > 0 && attentionCount > 0 ? { kind: "attention" } : null;
  const fallbackOnly = row.must + row.should === 0 && row.unanalyzed > 0;
  const candidates = fallbackOnly ? fallbackHunkIds(row.firstHunkIds, plan) : row.firstHunkIds;
  const hunkId = firstRenderedHunk(candidates, plan);
  return hunkId ? { kind: "card", hunkId } : attention;
}

function fallbackHunkIds(hunkIds: string[], plan: Pick<ReadingPlan, "must" | "should" | "skim">): string[] {
  const fallback = new Set([...plan.must, ...plan.should, ...plan.skim].filter((i) => i.source === "fallback").map((i) => i.hunkId));
  return hunkIds.filter((id) => fallback.has(id));
}

export const CHANGES_BEFORE_FEATURE = "이 결과는 '한 일' 목록을 만들기 전에 분석했습니다. 다시 분석하면 볼 수 있습니다.";
export const CHANGES_NOT_RETURNED = "이번 분석에서 '한 일' 목록을 받지 못했습니다. 다시 분석하면 볼 수 있습니다.";

/** What to show in place of 한 일 when there are no groups; null when nothing is missing. */
export function changesNote(result: Pick<ReviewResult, "changes" | "items">): string | null {
  if (result.changes?.length || result.items.length === 0) return null;
  return result.changes ? CHANGES_NOT_RETURNED : CHANGES_BEFORE_FEATURE;
}

const GENERIC_SOURCE_ROOTS = new Set(["src", "packages", "apps", "app", "lib"]);
const MAX_AREA_ROWS = 8;

export interface AreaRow extends PriorityCounts {
  area: string;
  fileCount: number;
  additions: number;
  deletions: number;
  /** This area's hunks that have an item: the candidates for its first card (see firstRenderedHunk). */
  firstHunkIds: string[];
  /** On the merged last row: the areas it stands for. */
  mergedAreas?: string[];
}

function areaOf(path: string): string {
  const segments = path.split("/");
  if (segments.length === 1) return "(루트)";
  return GENERIC_SOURCE_ROOTS.has(segments[0]) && segments.length > 2 ? `${segments[0]}/${segments[1]}` : segments[0];
}

function addToRow(row: AreaRow, other: Omit<AreaRow, "area">) {
  row.fileCount += other.fileCount;
  row.additions += other.additions;
  row.deletions += other.deletions;
  row.must += other.must;
  row.should += other.should;
  row.skim += other.skim;
  row.unanalyzed += other.unanalyzed;
  row.firstHunkIds.push(...other.firstHunkIds);
}

const emptyRow = (area: string): AreaRow => ({
  area,
  fileCount: 0,
  additions: 0,
  deletions: 0,
  must: 0,
  should: 0,
  skim: 0,
  unanalyzed: 0,
  firstHunkIds: [],
});

/**
 * Where the PR changed, by rule rather than AI. Covers every file, including
 * skipped and unavailable ones, so the totals match the PR. Largest area first.
 * Past the row limit one last row merges the rest, keeping 🔴 areas first and
 * then 🟡 or 🟣 ones visible however small they are.
 */
export function buildAreaMap(files: PrFile[], items: TriageItem[]): AreaRow[] {
  const itemById = new Map(items.map((i) => [i.hunkId, i]));
  const byArea = new Map<string, AreaRow>();
  for (const file of files) {
    const area = areaOf(file.filename);
    const row = byArea.get(area) ?? emptyRow(area);
    byArea.set(area, row);
    const hunkItems = file.hunks.flatMap((h) => itemById.get(h.id) ?? []);
    const counts = priorityCounts(hunkItems.map((i) => i.hunkId), hunkItems);
    // A kept hunk with no item was left out by the budget. A skipped file is a rule's decision, shown in ⚫.
    const notRead = { keep: file.hunks.length - hunkItems.length, unavailable: 1, skip: 0 }[file.classification.kind];
    addToRow(row, {
      fileCount: 1,
      additions: file.additions,
      deletions: file.deletions,
      ...counts,
      unanalyzed: counts.unanalyzed + notRead,
      firstHunkIds: hunkItems.map((i) => i.hunkId),
    });
  }

  const rows = [...byArea.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  if (rows.length <= MAX_AREA_ROWS) return rows;

  // The sort is stable, so size decides within a rank.
  const rank = (r: AreaRow) => (r.must > 0 ? 0 : r.should + r.unanalyzed > 0 ? 1 : 2);
  const kept = new Set([...rows].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_AREA_ROWS - 1));
  const rest = rows.filter((r) => !kept.has(r));
  const other: AreaRow = { ...emptyRow(`그 외 ${rest.length}개 영역`), mergedAreas: rest.map((r) => r.area) };
  for (const row of rest) addToRow(other, row);
  return [...rows.filter((r) => kept.has(r)), other];
}

export interface ActivityEntry extends Activity {
  /** 1-based arrival order; stable React key. */
  seq: number;
}

export interface ActivityState {
  /** Latest entries, oldest first. */
  recent: ActivityEntry[];
  /** Distinct paths Claude read. */
  files: string[];
  /** Grep + Glob calls. */
  searches: number;
  total: number;
}

export const NO_ACTIVITY: ActivityState = { recent: [], files: [], searches: 0, total: 0 };

/**
 * This document is a reload or back/forward of the given address. The server cannot tell: Chrome sends
 * Sec-Fetch-Site: same-origin on a reload even when the page was first opened from another site.
 * The entry belongs to the document, so after an in-app move to another page the addresses differ. Coming
 * back to the reloaded address in-app also counts as a repeat, which only costs one click on 분석 시작.
 */
export function isRepeatNavigation(entry: { type: string; name: string } | undefined, href: string): boolean {
  if (!entry || entry.type === "navigate") return false;
  const withoutFragment = (url: string) => url.split("#")[0];
  return withoutFragment(entry.name) === withoutFragment(href);
}

export function pushActivity(state: ActivityState, activity: Activity, keep = 20): ActivityState {
  const seq = state.total + 1;
  const isRead = activity.tool === "Read";
  return {
    recent: [...state.recent, { tool: activity.tool, target: activity.target, seq }].slice(-keep),
    files: isRead && !state.files.includes(activity.target) ? [...state.files, activity.target] : state.files,
    searches: state.searches + (isRead ? 0 : 1),
    total: seq,
  };
}
