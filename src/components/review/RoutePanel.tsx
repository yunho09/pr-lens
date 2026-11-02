"use client";

import { useEffect, useRef, useState } from "react";
import type { Hunk, PrFile, TriageItem } from "@/lib/types";
import { primaryLine } from "./labels";
import { RichText } from "./RichText";

/** Steps shown on narrow screens before "더 보기". */
const MOBILE_PREVIEW = 3;

/** Gap kept between the active step and the panel's edge when it scrolls into view. */
const FOLLOW_MARGIN = 8;

interface RoutePanelProps {
  steps: TriageItem[];
  hunks: Map<string, { hunk: Hunk; file: PrFile }>;
  seen: Set<string>;
  activeId: string | null;
  onlyNew: boolean;
  seenTotal: number;
  itemTotal: number;
  onJump: (hunkId: string) => void;
}

/** 추천 동선: the AI's reading order as numbered steps. Sticky sidebar on desktop, top block on mobile. */
export function RoutePanel({ steps, hunks, seen, activeId, onlyNew, seenTotal, itemTotal, onJump }: RoutePanelProps) {
  const [showAll, setShowAll] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const seenSteps = steps.filter((s) => seen.has(s.hunkId)).length;

  // Keep the active step visible in the sidebar. Only the panel's own scrollTop
  // moves: scrollIntoView would interrupt the page's smooth scroll to the card.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !activeId || getComputedStyle(panel).position !== "sticky") return;
    const step = panel.querySelector('[aria-current="step"]');
    if (!step) return;
    const panelBox = panel.getBoundingClientRect();
    const stepBox = step.getBoundingClientRect();
    if (stepBox.top < panelBox.top + FOLLOW_MARGIN) {
      panel.scrollTop += stepBox.top - panelBox.top - FOLLOW_MARGIN;
    } else if (stepBox.bottom > panelBox.bottom - FOLLOW_MARGIN) {
      panel.scrollTop += stepBox.bottom - panelBox.bottom + FOLLOW_MARGIN;
    }
  }, [activeId]);

  return (
    <nav
      ref={panelRef}
      aria-label="추천 동선"
      data-show-all={showAll || undefined}
      className="route-panel rounded-lg border border-line bg-surface p-3"
    >
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
        <ol className="mt-3 flex flex-col gap-0.5">
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
                    className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-xs font-bold ${
                      item.priority === "must" ? "bg-must-soft text-must" : "bg-should-soft text-should"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="sr-only">{item.priority === "must" ? "먼저 볼 것" : "확인 권장"}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`line-clamp-2 text-sm font-medium leading-5 ${isSeen ? "text-ink-subtle line-through" : "text-ink"}`}>
                      {item.isNew && !onlyNew && <span className="mr-1 text-xs font-bold text-accent">NEW</span>}
                      {item.source === "inherited" && onlyNew && (
                        <span className="mr-1 text-xs text-ink-subtle" title="이전 분석 결과 · 🔴는 그대로여도 숨기지 않음">
                          ↺
                        </span>
                      )}
                      <RichText text={item.title} />
                    </span>
                    {found && target && (
                      <>
                        <span
                          aria-hidden
                          className="mt-0.5 flex font-mono text-xs leading-4 text-ink-muted"
                          title={`${found.file.filename}:${target.line}`}
                        >
                          <span className="min-w-0 truncate">{found.file.filename.split("/").pop()}</span>
                          <span className="shrink-0">:{target.line}</span>
                        </span>
                        <span className="sr-only">
                          {found.file.filename}:{target.line}
                        </span>
                      </>
                    )}
                  </span>
                </button>
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
