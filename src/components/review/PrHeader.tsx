import Link from "next/link";
import { formatCost, formatDateTime, formatSeconds } from "@/lib/format";
import type { PrMeta, ReviewMode, ReviewResult } from "@/lib/types";

interface PrHeaderProps {
  owner: string;
  repo: string;
  number: number;
  meta: PrMeta | null;
  result: ReviewResult | null;
  running: boolean;
  mode: ReviewMode;
  onModeChange: (mode: ReviewMode) => void;
  onRefresh: () => void;
}

const BUTTON =
  "inline-flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";

export function PrHeader({ owner, repo, number, meta, result, running, mode, onModeChange, onRefresh }: PrHeaderProps) {
  const cost = result ? formatCost(result.costUsd) : null;
  const duration = result ? formatSeconds(result.durationMs) : null;

  return (
    <header className="rounded-lg border border-line bg-surface p-4">
      <nav className="text-sm text-ink-muted">
        <Link href="/" className="font-semibold text-ink hover:text-accent">
          PR Lens
        </Link>
        <span className="mx-1.5 text-ink-subtle">/</span>
        <span className="break-all">
          {owner}/{repo}
        </span>
      </nav>

      <h1 className="mt-1 text-xl font-semibold leading-snug text-ink">
        {meta ? meta.title : "PR 정보를 불러오는 중…"}{" "}
        <span className="font-normal text-ink-subtle">#{number}</span>
      </h1>

      {meta && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
          <span>@{meta.author}</span>
          <span className="min-w-0 break-all font-mono text-xs">
            {meta.baseRef} ← {meta.headRef}
          </span>
          <span className="font-mono text-xs">
            <span className="text-ok">+{meta.additions}</span> <span className="text-danger">−{meta.deletions}</span>
          </span>
          <span>파일 {meta.changedFiles}개</span>
          <span className="font-mono text-xs text-ink-subtle">{meta.headSha.slice(0, 7)}</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={meta?.htmlUrl ?? `https://github.com/${owner}/${repo}/pull/${number}`}
          target="_blank"
          rel="noreferrer"
          className={BUTTON}
        >
          GitHub에서 보기 ↗
        </a>
        <button type="button" onClick={onRefresh} disabled={running} className={BUTTON}>
          다시 분석
        </button>
        <label
          className={`inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-ink ${
            running ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-2"
          }`}
        >
          <input
            type="checkbox"
            checked={mode === "deep"}
            disabled={running}
            onChange={(e) => onModeChange(e.target.checked ? "deep" : "fast")}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          깊게 보기 (주변 코드 읽기)
        </label>
        {result && (
          <span className="text-xs text-ink-subtle">
            {result.cached ? "캐시된 결과 · " : ""}
            {result.mode === "deep" ? "깊게 · " : "빠르게 · "}
            {formatDateTime(result.analyzedAt)} 분석
            {duration ? ` · ${duration} 걸림` : ""}
            {result.toolCalls !== null ? ` · 도구 ${result.toolCalls}회` : ""}
            {cost ? ` · 비용 약 ${cost}` : ""}
          </span>
        )}
      </div>
    </header>
  );
}
