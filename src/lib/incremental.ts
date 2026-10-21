import { keptFiles } from "./prompt";
import type { DiffLine, HighlightRef, Hunk, PrData, ReviewDelta, ReviewResult, TriageItem } from "./types";

/** Above this share of changed kept hunks, a full re-analysis is more coherent than patching. */
export const FULL_REANALYSIS_RATIO = 0.7;

export interface PreviousAnalysis {
  pr: PrData;
  review: Pick<ReviewResult, "summary" | "readingOrder" | "items" | "analyzedAt">;
}

export interface IncrementalPlan {
  /**
   * full: send every kept hunk (no previous, `refresh`, a previous entry
   *   without anchor keys, too much changed, or hunks disappeared while nothing
   *   else needs Claude).
   * partial: send only hunks without an inheritable item.
   * reuse: nothing kept changed or disappeared; skip Claude.
   */
  kind: "full" | "partial" | "reuse";
  /** Previous items re-targeted to current hunk ids (empty for "full"). */
  inherited: TriageItem[];
  /** Kept hunk ids Claude must classify. */
  sendIds: string[];
  /** Current hunks with no counterpart in the previous analysis (for `isNew`). */
  newHunkIds: Set<string>;
  delta: ReviewDelta;
  previous: { headSha: string; analyzedAt: string };
  previousSummary: string;
  /** Previous readingOrder mapped to current ids of inherited items. */
  mappedReadingOrder: string[];
}

function keptHunks(pr: PrData): Hunk[] {
  return keptFiles(pr).flatMap((f) => f.hunks);
}

/**
 * Moves a highlight from a previous hunk to the current hunk it was paired
 * with. Their +/- lines are identical, but lines outside the anchored window
 * (and so the hunk start) may have shifted. The line is located relative to the
 * nearest changed line in diff order and found again at the same distance from
 * that changed line in the current hunk.
 */
function remapHighlight(h: HighlightRef, from: Hunk, to: Hunk): HighlightRef {
  const lineNo = (l: DiffLine | undefined) => (l === undefined ? null : h.side === "new" ? l.newLine : l.oldLine);
  const changed = (hunk: Hunk) => hunk.lines.flatMap((l, i) => (l.type === "context" ? [] : [i]));
  const at = from.lines.findIndex((l) => lineNo(l) === h.line);
  const fromChanged = changed(from);
  const toChanged = changed(to);
  if (at !== -1 && fromChanged.length > 0) {
    let k = 0;
    for (let i = 1; i < fromChanged.length; i++) {
      if (Math.abs(fromChanged[i] - at) < Math.abs(fromChanged[k] - at)) k = i;
    }
    const line = lineNo(to.lines[toChanged[k] + at - fromChanged[k]]);
    if (line !== null) return { side: h.side, line };
  }
  // Not a line of the hunk (Claude's number was off): move with the hunk start; mergeTriage clamps it.
  const shift = h.side === "new" ? to.newStart - from.newStart : to.oldStart - from.oldStart;
  return { side: h.side, line: h.line + shift };
}

/**
 * Compares the current PR state with a previous analysis by hunk anchor key
 * (position-aware: the same edit in another function is a different hunk) and
 * decides what can be inherited. A previous entry cached before anchor keys
 * existed is paired by content fingerprint for the delta only, never inherited
 * from. Pure: no I/O.
 */
export function planIncremental(
  pr: PrData,
  prev: PreviousAnalysis,
  options: { allowInherit: boolean },
): IncrementalPlan {
  const current = keptHunks(pr);
  const prevKept = keptHunks(prev.pr);
  const prevItems = new Map(prev.review.items.map((i) => [i.hunkId, i]));
  const anchored = [...current, ...prevKept].every((h) => h.anchorKey !== undefined);
  const keyOf = (h: Hunk) => (anchored ? h.anchorKey! : h.fingerprint);

  // Pair each current hunk with an unused previous hunk of the same key, in
  // diff order: the same hunk in two places counts twice.
  const unpaired = new Map<string, Hunk[]>();
  for (const hunk of prevKept) {
    const list = unpaired.get(keyOf(hunk));
    if (list) list.push(hunk);
    else unpaired.set(keyOf(hunk), [hunk]);
  }
  const pairs = current.map((hunk) => ({ hunk, before: unpaired.get(keyOf(hunk))?.shift() }));

  const newHunkIds = new Set(pairs.filter((p) => !p.before).map((p) => p.hunk.id));
  const delta: ReviewDelta = {
    new: newHunkIds.size,
    unchanged: current.length - newHunkIds.size,
    resolved: [...unpaired.values()].reduce((n, list) => n + list.length, 0),
  };
  const base = {
    newHunkIds,
    delta,
    previous: { headSha: prev.pr.meta.headSha, analyzedAt: prev.review.analyzedAt },
    previousSummary: prev.review.summary,
  };
  const full: IncrementalPlan = {
    ...base,
    kind: "full",
    inherited: [],
    sendIds: current.map((h) => h.id),
    mappedReadingOrder: [],
  };

  if (!options.allowInherit || !anchored || current.length === 0) return full;

  const inherited: TriageItem[] = [];
  const prevIdToCurrent = new Map<string, string>();
  const sendIds: string[] = [];
  for (const { hunk, before } of pairs) {
    const item = before ? prevItems.get(before.id) : undefined;
    // Fallback items are not worth inheriting: Claude never actually classified those hunks.
    if (!before || !item || item.source === "fallback") {
      sendIds.push(hunk.id);
      continue;
    }
    inherited.push({
      ...item,
      hunkId: hunk.id,
      highlight: item.highlight.map((h) => remapHighlight(h, before, hunk)),
      lookAt: item.lookAt.map((l) => ({ ...l })),
      isNew: false,
      source: "inherited",
    });
    prevIdToCurrent.set(item.hunkId, hunk.id);
  }

  if (sendIds.length / current.length > FULL_REANALYSIS_RATIO) return full;
  // Reusing would keep a summary that may describe a hunk that is gone.
  if (sendIds.length === 0 && delta.resolved > 0) return full;

  const mappedReadingOrder = prev.review.readingOrder
    .map((id) => prevIdToCurrent.get(id))
    .filter((id): id is string => id !== undefined);

  return {
    ...base,
    kind: sendIds.length === 0 ? "reuse" : "partial",
    inherited,
    sendIds,
    mappedReadingOrder,
  };
}
