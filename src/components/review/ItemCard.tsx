"use client";

import { useState } from "react";
import type { Hunk, PrFile, PrMeta, TriageItem } from "@/lib/types";
import { HunkDiff } from "./HunkDiff";
import { blobUrl, CATEGORY_LABEL, lineUrl, lookAtLabel, primaryLine } from "./labels";

const PRIORITY_RING: Record<TriageItem["priority"], string> = {
  must: "border-l-must",
  should: "border-l-should",
  skim: "border-l-line",
};

interface ItemCardProps {
  item: TriageItem;
  hunk: Hunk;
  file: PrFile;
  meta: PrMeta;
  order?: number;
  seen: boolean;
  active: boolean;
  onToggleSeen: () => void;
  onActivate: () => void;
}

function Labeled({ label, children, tone = "plain" }: { label: string; children: React.ReactNode; tone?: "plain" | "question" }) {
  return (
    <div
      className={`mt-3 flex flex-col gap-0.5 text-sm leading-relaxed sm:flex-row sm:gap-3 ${
        tone === "question" ? "rounded-md bg-accent-soft px-3 py-2" : ""
      }`}
    >
      <span className={`shrink-0 font-semibold sm:w-24 ${tone === "question" ? "text-accent" : "text-ink-muted"}`}>
        {label}
      </span>
      <div className="min-w-0 text-ink">{children}</div>
    </div>
  );
}

export function ItemCard({ item, hunk, file, meta, order, seen, active, onToggleSeen, onActivate }: ItemCardProps) {
  const [expanded, setExpanded] = useState(item.priority !== "skim");
  const target = primaryLine(item, hunk);
  const checkboxId = `seen-${item.hunkId}`;

  return (
    <article
      id={`card-${item.hunkId}`}
      onClick={onActivate}
      className={`card-anchor overflow-hidden rounded-lg border border-l-4 border-line bg-surface ${PRIORITY_RING[item.priority]}${active ? " card-active" : ""}`}
    >
      <div className={`p-4 ${seen ? "opacity-60" : ""}`}>
        <div className="flex items-start gap-3">
          {order !== undefined && (
            <span
              className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-ink-muted"
              aria-label={`읽는 순서 ${order}번`}
            >
              {order}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {item.isNew && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold tracking-wide text-on-accent">
                  NEW
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  item.category === "security" ? "bg-danger-soft text-danger" : "bg-skim-soft text-ink-muted"
                }`}
              >
                {CATEGORY_LABEL[item.category]}
              </span>
              {item.source === "fallback" && (
                <span className="rounded-full bg-attention-soft px-2 py-0.5 text-xs font-medium text-attention">
                  AI 미분류
                </span>
              )}
              {hunk.likelyFormatting && (
                <span
                  className="rounded-full bg-skim-soft px-2 py-0.5 text-xs font-medium text-ink-muted"
                  title="규칙상 공백만 바뀐 것처럼 보이는 조각입니다. 그래도 걸러 내지 않고 Claude에게 동작이 바뀌는지 확인하게 했습니다."
                >
                  포맷팅으로 보임
                </span>
              )}
              {hunk.lineEndOnly && (
                <span
                  className="rounded-full bg-skim-soft px-2 py-0.5 text-xs font-medium text-ink-muted"
                  title="줄 끝 공백·CR(줄바꿈 문자)·파일 끝 줄바꿈만 바뀐 조각입니다. Makefile·셸 heredoc·Markdown·문자열에서는 이것도 동작을 바꿀 수 있어 Claude에게 확인하게 했습니다."
                >
                  줄 끝 공백만
                </span>
              )}
              {hunk.generatedPath && (
                <span
                  className="rounded-full bg-skim-soft px-2 py-0.5 text-xs font-medium text-ink-muted"
                  title="빌드 결과물·생성 코드·벤더 경로입니다. 실제로 배포·실행되는 코드일 수 있어(예: GitHub Action의 dist/index.js) 걸러 내지 않았습니다."
                >
                  생성 코드 경로
                </span>
              )}
              {item.source === "inherited" && (
                <span
                  className="text-xs text-ink-subtle"
                  title="지난 분석 이후 바뀌지 않은 코드 조각이라 그때 결과를 그대로 씁니다."
                >
                  ↺ 이전 분석
                </span>
              )}
              <h3 className="font-semibold text-ink">{item.title}</h3>
            </div>
            <a
              href={lineUrl(meta, file, target)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-1 inline-block break-all font-mono text-xs text-accent hover:underline"
            >
              {file.filename}:{target.line}
              {target.side === "old" ? " (삭제된 줄)" : ""}
            </a>
          </div>
          <label
            htmlFor={checkboxId}
            onClick={(e) => e.stopPropagation()}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted hover:bg-surface-2"
          >
            <input
              id={checkboxId}
              type="checkbox"
              checked={seen}
              onChange={onToggleSeen}
              className="h-4 w-4 accent-[var(--ok)]"
            />
            봤음
          </label>
        </div>

        {item.explain && <Labeled label="이 부분은">{item.explain}</Labeled>}
        {item.why && <Labeled label="왜 봐야 하나">{item.why}</Labeled>}
        {item.check && (
          <Labeled label="확인할 질문" tone="question">
            {item.check}
          </Labeled>
        )}
        {item.lookAt.length > 0 && (
          <Labeled label="같이 볼 곳">
            <ul className="flex flex-col gap-1">
              {item.lookAt.map((l, i) => (
                <li key={i} className="flex flex-col sm:flex-row sm:gap-2">
                  <a
                    href={blobUrl(meta, l)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 break-all font-mono text-xs leading-5 text-accent hover:underline"
                  >
                    {lookAtLabel(l)}
                  </a>
                  <span className="text-ink-muted">{l.reason}</span>
                </li>
              ))}
            </ul>
          </Labeled>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          className="mt-3 text-xs font-medium text-ink-muted hover:text-ink"
        >
          {expanded ? "▾ 코드 접기" : `▸ 코드 보기 (${hunk.lines.length}줄)`}
        </button>
      </div>
      {expanded && <HunkDiff hunk={hunk} highlight={item.highlight} />}
    </article>
  );
}
