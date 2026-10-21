"use client";

import { useState } from "react";
import type { Hunk, PrFile, PrMeta, TriageItem } from "@/lib/types";
import { blobUrl, lookAtLabel, primaryLine } from "./labels";

/** Steps shown on narrow screens before "더 보기". */
const MOBILE_PREVIEW = 3;

interface RoutePanelProps {
  steps: TriageItem[];
  hunks: Map<string, { hunk: Hunk; file: PrFile }>;
  meta: PrMeta;
  seen: Set<string>;
  activeId: string | null;
  onlyNew: boolean;
  seenTotal: number;
  itemTotal: number;
  onJump: (hunkId: string) => void;
}

/** 추천 동선: the AI's reading order as numbered steps. Sticky sidebar on desktop, top block on mobile. */
export function RoutePanel({ steps, hunks, meta, seen, activeId, onlyNew, seenTotal, itemTotal, onJump }: RoutePanelProps) {
  const [showAll, setShowAll] = useState(false);
  const seenSteps = steps.filter((s) => seen.has(s.hunkId)).length;

  return (
    <nav aria-label="추천 동선" data-show-all={showAll || undefined} className="route-panel rounded-lg border border-line bg-surface p-3">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-sm font-semibold text-ink">추천 동선</h2>
        <span className="ml-auto text-xs text-ink-muted">
          봤음 {seenSteps}/{steps.length}
          <span className="text-ink-subtle"> · 전체 {seenTotal}/{itemTotal}</span>
        </span>
      </div>
      <p className="mt-0.5 px-1 text-xs text-ink-subtle">
        {onlyNew ? "새로 분석한 것과 모든 🔴 중 " : ""}AI가 고른 읽는 순서 · 누르면 카드로 이동
      </p>
      <div className="mx-1 mt-2 h-1.5 overflow-hidden rounded-full bg-skim-soft" aria-hidden>
        <div
          className="h-full rounded-full bg-ok transition-[width]"
          style={{ width: `${steps.length ? (seenSteps / steps.length) * 100 : 0}%` }}
        />
      </div>

      {steps.length === 0 ? (
        <p className="mt-3 px-1 text-sm text-ink-subtle">
          {onlyNew ? "새로 분석한 것 중 꼭 읽어야 할 항목이 없습니다." : "꼭 읽어야 할 항목이 없습니다."}
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-1">
          {steps.map((item, i) => {
            const found = hunks.get(item.hunkId);
            const target = found ? primaryLine(item, found.hunk) : null;
            const isSeen = seen.has(item.hunkId);
            const isActive = activeId === item.hunkId;
            return (
              <li key={item.hunkId} className={i >= MOBILE_PREVIEW ? "route-extra" : undefined}>
                <button
                  type="button"
                  onClick={() => onJump(item.hunkId)}
                  aria-current={isActive ? "step" : undefined}
                  className={`flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2 ${
                    isActive ? "bg-accent-soft" : ""
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold ${
                      item.priority === "must" ? "bg-must-soft text-must" : "bg-should-soft text-should"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="sr-only">{item.priority === "must" ? "먼저 볼 것" : "확인 권장"}</span>
                  <span className="min-w-0 flex-1">
                    {found && target && (
                      <span className="block break-all font-mono text-[11px] leading-4 text-ink-muted">
                        {found.file.filename}:{target.line}
                      </span>
                    )}
                    <span className={`block text-sm font-medium leading-snug ${isSeen ? "text-ink-subtle line-through" : "text-ink"}`}>
                      {item.isNew && !onlyNew && <span className="mr-1 text-[10px] font-bold text-accent">NEW</span>}
                      {item.source === "inherited" && onlyNew && (
                        <span className="mr-1 text-[10px] text-ink-subtle" title="이전 분석 결과 · 🔴는 그대로여도 숨기지 않음">
                          ↺
                        </span>
                      )}
                      {item.title}
                    </span>
                    {item.explain && (
                      <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-muted">{item.explain}</span>
                    )}
                  </span>
                </button>
                {item.lookAt.length > 0 && (
                  <ul className="mb-1 ml-8 flex flex-col gap-0.5 pr-1">
                    {item.lookAt.map((l, j) => (
                      <li key={j} className="flex gap-1 text-[11px] leading-4">
                        <span aria-hidden className="text-ink-subtle">
                          ↳
                        </span>
                        <span className="min-w-0">
                          <a
                            href={blobUrl(meta, l)}
                            target="_blank"
                            rel="noreferrer"
                            title={l.reason || undefined}
                            className="break-all font-mono text-accent hover:underline"
                          >
                            {lookAtLabel(l)}
                          </a>
                          {l.reason && <span className="text-ink-subtle"> {l.reason}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {steps.length > MOBILE_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="route-more mt-2 w-full rounded-md border border-line-soft py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2"
        >
          {showAll ? "접기" : `나머지 ${steps.length - MOBILE_PREVIEW}단계 더 보기`}
        </button>
      )}

      <p className="route-keys mt-3 border-t border-line-soft px-1 pt-2 text-xs text-ink-subtle">
        단축키 <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> 다음·이전 ·{" "}
        <kbd className="font-mono">x</kbd> 봤음
      </p>
    </nav>
  );
}
