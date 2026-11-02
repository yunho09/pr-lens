"use client";

import { useMemo, type ReactNode } from "react";
import type { ChangeGroup, PrFile, ReviewResult, TriageItem } from "@/lib/types";
import {
  areaTarget,
  buildAreaMap,
  changesNote,
  firstRenderedHunk,
  priorityCounts,
  type AreaRow,
  type JumpTarget,
  type PriorityCounts,
  type ReadingPlan,
} from "./review-model";
import { RichText } from "./RichText";

const COUNT_MARKS: Array<{ key: keyof PriorityCounts; icon: string; label: string }> = [
  { key: "must", icon: "🔴", label: "먼저 볼 것" },
  { key: "should", icon: "🟡", label: "확인 권장" },
  { key: "skim", icon: "⚪", label: "훑어봐도 됨" },
  { key: "unanalyzed", icon: "🟣", label: "분석하지 못함" },
];

const HEADING = "text-sm font-semibold text-ink-muted";
const HIDDEN_BY_FILTER = "필터로 숨겨짐";

/** Why a row with cards has nowhere to jump: only the filter can hide them all. */
const reasonWithoutTarget = (counts: PriorityCounts) => (counts.must + counts.should + counts.skim > 0 ? HIDDEN_BY_FILTER : undefined);

function Counts({ counts, className = "" }: { counts: PriorityCounts; className?: string }) {
  return (
    <span className={`flex justify-end gap-1.5 text-xs tabular-nums text-ink-muted ${className}`}>
      {COUNT_MARKS.filter((m) => counts[m.key] > 0).map((m) => (
        <span key={m.key} className="whitespace-nowrap">
          <span aria-hidden>
            {m.icon}
            {counts[m.key]}
          </span>
          <span className="sr-only">
            {m.label} {counts[m.key]}개
          </span>
        </span>
      ))}
    </span>
  );
}

/** A real button when there is somewhere to jump, plain text when there is not. */
function JumpRow({
  target,
  onJump,
  className,
  reason,
  children,
}: {
  target: JumpTarget | null;
  onJump: (target: JumpTarget) => void;
  className: string;
  /** Why a plain row has no target. */
  reason?: string;
  children: ReactNode;
}) {
  const base = `w-full rounded-md px-2 py-1.5 text-left ${className}`;
  return target ? (
    <button
      type="button"
      title={target.kind === "attention" ? "확인 필요로 이동" : "첫 카드로 이동"}
      onClick={() => onJump(target)}
      className={`${base} hover:bg-surface-2`}
    >
      {children}
    </button>
  ) : (
    <div title={reason} className={base}>
      {children}
      {reason && <span className="sr-only">{reason}</span>}
    </div>
  );
}

function ChangeRow({
  group,
  items,
  plan,
  onJump,
}: {
  group: ChangeGroup;
  items: TriageItem[];
  plan: ReadingPlan;
  onJump: (target: JumpTarget) => void;
}) {
  const hunkId = firstRenderedHunk(group.hunkIds, plan);
  const counts = priorityCounts(group.hunkIds, items);
  return (
    <JumpRow
      target={hunkId ? { kind: "card", hunkId } : null}
      reason={reasonWithoutTarget(counts)}
      onJump={onJump}
      className="flex items-start gap-3"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-6 text-ink">
          <RichText text={group.title} />
        </span>
        {group.detail && (
          <span className="block text-sm leading-6 text-ink-muted">
            <RichText text={group.detail} />
          </span>
        )}
      </span>
      <Counts counts={counts} className="mt-1 shrink-0" />
    </JumpRow>
  );
}

function AreaBar({ row, largest }: { row: AreaRow; largest: number }) {
  const total = row.additions + row.deletions;
  return (
    <span aria-hidden className="area-track block">
      {total > 0 && (
        <span className="area-bar" style={{ width: `${(total / largest) * 100}%` }}>
          {row.additions > 0 && <span className="area-add" style={{ flexGrow: row.additions }} />}
          {row.deletions > 0 && <span className="area-del" style={{ flexGrow: row.deletions }} />}
        </span>
      )}
    </span>
  );
}

function AreaMapRow({
  row,
  largest,
  plan,
  attentionCount,
  onJump,
}: {
  row: AreaRow;
  largest: number;
  plan: ReadingPlan;
  attentionCount: number;
  onJump: (target: JumpTarget) => void;
}) {
  const names = row.mergedAreas?.join(", ");
  return (
    <JumpRow target={areaTarget(row, plan, attentionCount)} reason={reasonWithoutTarget(row)} onJump={onJump} className="area-row">
      <span className="area-label min-w-0 truncate font-mono text-[13px] text-ink" title={names ?? row.area}>
        {row.area}
      </span>
      {names && <span className="sr-only">{names}</span>}
      <AreaBar row={row} largest={largest} />
      <span className="area-lines whitespace-nowrap text-right font-mono text-xs tabular-nums text-ink-muted">
        <span aria-hidden>
          +{row.additions} −{row.deletions}
        </span>
        <span className="sr-only">
          추가 {row.additions}줄, 삭제 {row.deletions}줄
        </span>
      </span>
      <span className="area-files whitespace-nowrap text-right text-xs text-ink-muted">파일 {row.fileCount}개</span>
      <Counts counts={{ must: row.must, should: row.should, skim: 0, unanalyzed: row.unanalyzed }} className="area-counts" />
    </JumpRow>
  );
}

interface PrOverviewProps {
  result: ReviewResult;
  files: PrFile[];
  plan: ReadingPlan;
  /** Entries in the 🟣 확인 필요 section. */
  attentionCount: number;
  onJump: (target: JumpTarget) => void;
}

/** "이 PR은": what the PR did overall (Claude's summary and groups) and where it changed (rules, no AI). */
export function PrOverview({ result, files, plan, attentionCount, onJump }: PrOverviewProps) {
  const areas = useMemo(() => buildAreaMap(files, result.items), [files, result.items]);
  const largest = Math.max(1, ...areas.map((r) => r.additions + r.deletions));
  const changes = result.changes ?? [];
  const note = changesNote(result);

  return (
    <section
      aria-label="PR 개요"
      className={`grid gap-5 rounded-lg border border-line bg-surface p-4 ${areas.length > 0 ? "min-[1200px]:grid-cols-2 min-[1200px]:gap-8" : ""}`}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <h2 className={HEADING}>이 PR은</h2>
          <p className="mt-1 max-w-[80ch] leading-[1.75] text-ink">
            <RichText text={result.summary} />
          </p>
        </div>

        {changes.length > 0 && (
          <div>
            <h2 className={HEADING}>한 일</h2>
            <ul className="-mx-2 mt-1 flex flex-col gap-0.5">
              {changes.map((group, i) => (
                <li key={i}>
                  <ChangeRow group={group} items={result.items} plan={plan} onJump={onJump} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {note && <p className="text-sm leading-6 text-ink-subtle">{note}</p>}
        {attentionCount > 0 && (
          <div className="-mx-2">
            <JumpRow target={{ kind: "attention" }} onJump={onJump} className="text-sm font-semibold text-attention">
              <span aria-hidden>🟣 </span>분석하지 못한 코드 {attentionCount}개, 직접 확인하세요
            </JumpRow>
          </div>
        )}
      </div>

      {areas.length > 0 && (
        <div className="min-w-0 min-[1200px]:border-l min-[1200px]:border-line-soft min-[1200px]:pl-8">
          <div className="flex items-baseline gap-3">
            <h2 className={HEADING}>변경 영역</h2>
            <span aria-hidden className="ml-auto flex gap-3 text-xs text-ink-muted">
              <span className="flex items-center gap-1">
                <span className="area-add h-2 w-2 rounded-sm" />
                추가
              </span>
              <span className="flex items-center gap-1">
                <span className="area-del h-2 w-2 rounded-sm" />
                삭제
              </span>
            </span>
          </div>
          <ul className="area-list -mx-2 mt-1 flex flex-col gap-0.5">
            {areas.map((row) => (
              <li key={row.area}>
                <AreaMapRow row={row} largest={largest} plan={plan} attentionCount={attentionCount} onJump={onJump} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
