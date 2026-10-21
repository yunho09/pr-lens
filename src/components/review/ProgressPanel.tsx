import type { Activity, ActivityTool, ReviewMode, ReviewStage } from "@/lib/types";
import type { ActivityState } from "./review-model";

const ALL_STEPS: Array<{ stage: ReviewStage; label: string; deepOnly?: boolean }> = [
  { stage: "fetching", label: "가져오는 중" },
  { stage: "filtering", label: "걸러내는 중" },
  { stage: "checkout", label: "레포 내려받는 중", deepOnly: true },
  { stage: "analyzing", label: "Claude가 읽는 중" },
];

const TOOL_LABEL: Record<ActivityTool, string> = { Read: "읽기", Grep: "검색", Glob: "찾기" };

/** Older activity lines shown under the current one. */
const HISTORY_LINES = 5;

interface ProgressPanelProps {
  mode: ReviewMode;
  stage: ReviewStage | null;
  /** The server's description of the current stage. */
  stageMessage: string | null;
  elapsedSec: number;
  stageElapsedSec: number;
  activity: ActivityState;
}

function activityText(a: Activity): string {
  return a.tool === "Read" ? `${a.target} 읽는 중` : a.tool === "Grep" ? `"${a.target}" 검색 중` : `${a.target} 파일 찾는 중`;
}

export function ProgressPanel({ mode, stage, stageMessage, elapsedSec, stageElapsedSec, activity }: ProgressPanelProps) {
  const steps = ALL_STEPS.filter((s) => !s.deepOnly || mode === "deep");
  const current = stage ? Math.max(0, steps.findIndex((s) => s.stage === stage)) : 0;
  const latest = activity.recent[activity.recent.length - 1];
  const history = activity.recent.slice(0, -1).slice(-HISTORY_LINES).reverse();

  return (
    <section aria-label="분석 진행 상황" className="rounded-lg border border-line bg-surface p-4">
      {/* Announce stage changes only; the per-second timer and activity feed would be noise. */}
      <p className="sr-only" aria-live="polite">
        {steps[current]?.label}
      </p>
      <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {steps.map((step, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          return (
            <li key={step.stage} className="flex items-center gap-2 text-sm">
              {i > 0 && (
                <span aria-hidden className="hidden text-ink-subtle sm:inline">
                  →
                </span>
              )}
              <span
                aria-hidden
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  state === "done"
                    ? "bg-ok text-on-accent"
                    : state === "active"
                      ? "animate-spin border-2 border-accent border-t-transparent"
                      : "border border-line"
                }`}
              >
                {state === "done" ? "✓" : ""}
              </span>
              <span className={state === "todo" ? "text-ink-subtle" : state === "active" ? "font-semibold text-ink" : "text-ink-muted"}>
                {step.label}
                {state === "active" && (step.stage === "analyzing" || step.stage === "checkout") && (
                  <span className="ml-1 font-normal text-ink-muted">({stageElapsedSec}초)</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {stage === "analyzing" && mode === "deep" && (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2.5">
          <p className="flex items-center gap-2 text-sm text-ink">
            <span aria-hidden className="activity-dot h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span key={latest?.seq ?? 0} className="activity-enter min-w-0 truncate font-medium" title={latest?.target}>
              {latest ? activityText(latest) : (stageMessage ?? "Claude가 읽는 중")}
            </span>
          </p>
          {activity.total > 0 && (
            <p className="mt-1 pl-4 text-xs text-ink-muted">
              파일 {activity.files.length}개 읽음 · 검색 {activity.searches}회
            </p>
          )}
          {history.length > 0 && (
            <ul aria-hidden className="activity-log mt-2 flex flex-col gap-0.5 pl-4 text-xs">
              {history.map((a) => (
                <li key={a.seq} className="activity-enter flex min-w-0 gap-2">
                  <span className="w-7 shrink-0 text-ink-muted">{TOOL_LABEL[a.tool]}</span>
                  <span className="min-w-0 truncate font-mono text-ink-subtle">{a.target}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-3 text-xs text-ink-subtle">
        경과 {elapsedSec}초
        {stage === "analyzing" &&
          (mode === "deep"
            ? " · 깊게 보기는 주변 코드까지 읽느라 보통 1~3분 걸립니다. 페이지를 떠나면 분석이 취소됩니다."
            : " · Claude 분석은 보통 30초~2분 걸립니다. 페이지를 떠나면 분석이 취소됩니다.")}
      </p>
    </section>
  );
}
