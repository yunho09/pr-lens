import type { ReviewResult } from "@/lib/types";
import { shortDateTime } from "./labels";

interface IncrementalBannerProps {
  previous: NonNullable<ReviewResult["previous"]>;
  delta: ReviewResult["delta"];
  /** The filter would both show and hide something (see defaultOnlyNew). */
  canFilter: boolean;
  onlyNew: boolean;
  onOnlyNewChange: (onlyNew: boolean) => void;
}

/** What changed since the last analysis of this PR, plus the "새로 분석한 것만" filter. */
export function IncrementalBanner({ previous, delta, canFilter, onlyNew, onOnlyNewChange }: IncrementalBannerProps) {
  // Unchanged hunks are either re-analyzed in this run or inherited as they were.
  const reanalyzed = delta?.reanalyzed ?? 0;

  return (
    <section
      aria-label="지난 분석과 비교"
      className="flex flex-col gap-2 rounded-lg border border-line bg-accent-soft px-4 py-3 text-sm text-ink sm:flex-row sm:items-center sm:gap-4"
    >
      <p className="min-w-0 flex-1 leading-relaxed">
        지난 분석(<span className="font-mono text-xs">{previous.headSha.slice(0, 7)}</span> ·{" "}
        {shortDateTime(previous.analyzedAt)}) 이후:{" "}
        {delta ? (
          <>
            <strong className="font-semibold text-accent">새 변경 {delta.new}</strong>
            {reanalyzed > 0 && (
              <span title="지난번에 분류되지 않았거나 다시 분석을 눌러 이번에 다시 분류한 코드 조각">
                {" "}
                · 다시 분석 {reanalyzed}
              </span>
            )}
            <span className="text-ink-muted">
              {" "}
              · 그대로 {delta.unchanged - reanalyzed} · 사라짐 {delta.resolved}
            </span>
          </>
        ) : (
          <span className="text-ink-muted">바뀐 부분을 비교하지 못했습니다</span>
        )}
      </p>
      <label
        className={`inline-flex shrink-0 items-center gap-2 self-start rounded-md border border-line bg-surface px-3 py-1.5 sm:self-auto ${
          canFilter ? "cursor-pointer hover:bg-surface-2" : "cursor-not-allowed opacity-50"
        }`}
        title={
          canFilter
            ? "새 변경과 다시 분석한 코드 조각만 보여 주고, 지난 결과를 그대로 쓴 🟡·⚪는 숨깁니다 (🔴는 항상 보임)"
            : "숨길 것(그대로인 🟡·⚪)이나 보여 줄 것(이번에 분석한 조각)이 없어 거를 것이 없습니다"
        }
      >
        <input
          type="checkbox"
          checked={onlyNew}
          disabled={!canFilter}
          onChange={(e) => onOnlyNewChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        새로 분석한 것만 보기
      </label>
    </section>
  );
}
