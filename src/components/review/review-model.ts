import type { Activity, Priority, ReviewResult, TriageItem } from "@/lib/types";

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
