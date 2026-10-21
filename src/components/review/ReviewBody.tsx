"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  parseSeenKeys,
  seenFromStorageEvent,
  seenHunkIds,
  seenStorageKey,
  seenKey,
  serializeSeenKeys,
  toggleSeenKey,
} from "@/lib/seen";
import type { Hunk, PrData, PrFile, ReviewResult, TriageItem } from "@/lib/types";
import { NoiseList, OmittedCard, UnavailableList, type OmittedEntry } from "./FileLists";
import { IncrementalBanner } from "./IncrementalBanner";
import { ItemCard } from "./ItemCard";
import { buildReadingPlan, defaultOnlyNew } from "./review-model";
import { RoutePanel } from "./RoutePanel";
import { Section } from "./Section";

function loadSeen(key: string): Set<string> {
  try {
    return parseSeenKeys(window.localStorage.getItem(key));
  } catch {
    return new Set();
  }
}

function saveSeen(key: string, seenKeys: Set<string>) {
  try {
    window.localStorage.setItem(key, serializeSeenKeys(seenKeys));
  } catch {
    // Storage unavailable (private mode, quota): progress just won't persist.
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  }
  return false;
}

function scrollToCard(hunkId: string) {
  document.getElementById(`card-${hunkId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface ReviewBodyProps {
  pr: PrData;
  result: ReviewResult;
}

export function ReviewBody({ pr, result }: ReviewBodyProps) {
  const { meta } = pr;
  // 봤음 is stored per PR as hunk anchor keys, so it survives new pushes for hunks that only moved.
  const storageKey = seenStorageKey(meta.owner, meta.repo, meta.number);

  const hunks = useMemo(() => {
    const map = new Map<string, { hunk: Hunk; file: PrFile }>();
    for (const file of pr.files) for (const hunk of file.hunks) map.set(hunk.id, { hunk, file });
    return map;
  }, [pr]);
  const allHunks = useMemo(() => pr.files.flatMap((f) => f.hunks), [pr]);

  const canFilter = useMemo(() => defaultOnlyNew(result), [result]);
  const [onlyNew, setOnlyNew] = useState(canFilter);
  const plan = useMemo(() => buildReadingPlan(result, onlyNew), [result, onlyNew]);
  const orderNumber = useMemo(() => new Map(plan.steps.map((item, i) => [item.hunkId, i + 1])), [plan]);
  const priorityOf = useMemo(() => new Map(result.items.map((i) => [i.hunkId, i.priority])), [result]);

  const noiseFiles = pr.files.filter((f) => f.classification.kind === "skip");
  const unavailableFiles = pr.files.filter((f) => f.classification.kind === "unavailable");
  const omittedEntries: OmittedEntry[] = result.omitted.flatMap((omitted) => {
    const found = hunks.get(omitted.hunkId);
    return found ? [{ omitted, ...found }] : [];
  });
  const attentionCount = unavailableFiles.length + omittedEntries.length;

  const [open, setOpen] = useState({ must: true, should: true, skim: false, noise: false, attention: true });
  const toggle = (key: keyof typeof open) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  const [seenKeys, setSeenKeys] = useState<Set<string>>(() => loadSeen(storageKey));
  const seen = useMemo(() => seenHunkIds(seenKeys, allHunks), [seenKeys, allHunks]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // 봤음 toggled in another tab of the same PR.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const next = seenFromStorageEvent(event, storageKey);
      if (next) setSeenKeys(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const toggleSeen = (hunkId: string) => {
    const hunk = hunks.get(hunkId)?.hunk;
    if (!hunk) return;
    const next = toggleSeenKey(seenKeys, seenKey(hunk));
    setSeenKeys(next);
    saveSeen(storageKey, next);
  };

  // Cards j/k walk through, in on-screen order.
  const navOrder = [
    ...(open.must ? plan.must : []),
    ...(open.should ? plan.should : []),
    ...(open.skim ? plan.skim : []),
  ].map((i) => i.hunkId);

  const jumpTo = (hunkId: string) => {
    const priority = priorityOf.get(hunkId);
    setActiveId(hunkId);
    if (priority && !open[priority]) {
      setOpen((o) => ({ ...o, [priority]: true }));
      requestAnimationFrame(() => scrollToCard(hunkId));
    } else {
      scrollToCard(hunkId);
    }
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
    if (event.key === "j" || event.key === "k") {
      if (navOrder.length === 0) return;
      event.preventDefault();
      const idx = activeId ? navOrder.indexOf(activeId) : -1;
      const next =
        idx === -1
          ? event.key === "j"
            ? 0
            : navOrder.length - 1
          : Math.min(Math.max(idx + (event.key === "j" ? 1 : -1), 0), navOrder.length - 1);
      jumpTo(navOrder[next]);
    } else if (event.key === "x") {
      if (!activeId) return;
      event.preventDefault();
      toggleSeen(activeId);
    }
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const renderCard = (item: TriageItem) => {
    const found = hunks.get(item.hunkId);
    if (!found) return null;
    return (
      <ItemCard
        key={item.hunkId}
        item={item}
        hunk={found.hunk}
        file={found.file}
        meta={meta}
        order={orderNumber.get(item.hunkId)}
        seen={seen.has(item.hunkId)}
        active={activeId === item.hunkId}
        onToggleSeen={() => toggleSeen(item.hunkId)}
        onActivate={() => setActiveId(item.hunkId)}
      />
    );
  };

  const renderCards = (items: TriageItem[], hidden: number, emptyText: string) =>
    items.length > 0 ? (
      <>
        {items.map(renderCard)}
        {hidden > 0 && (
          <p className="text-xs text-ink-subtle">그대로인 {hidden}개는 숨김 · 위의 ‘새로 분석한 것만 보기’를 끄면 보입니다.</p>
        )}
      </>
    ) : (
      <p className="text-sm text-ink-subtle">
        {hidden > 0 ? `새로 분석한 것은 없습니다 · 그대로인 ${hidden}개는 숨김` : emptyText}
      </p>
    );

  const seenTotal = result.items.filter((i) => seen.has(i.hunkId)).length;

  return (
    <div className="flex flex-col gap-6">
      {result.previous && (
        <IncrementalBanner
          previous={result.previous}
          delta={result.delta}
          canFilter={canFilter}
          onlyNew={onlyNew}
          onOnlyNewChange={setOnlyNew}
        />
      )}

      <div className="review-grid">
        <aside className="min-w-0">
          <RoutePanel
            steps={plan.steps}
            hunks={hunks}
            meta={meta}
            seen={seen}
            activeId={activeId}
            onlyNew={onlyNew}
            seenTotal={seenTotal}
            itemTotal={result.items.length}
            onJump={jumpTo}
          />
        </aside>

        <div className="flex min-w-0 flex-col gap-8">
          <Section
            id="must"
            icon="🔴"
            title="먼저 볼 것"
            count={plan.must.length}
            description="동작·보안·데이터·계약을 깨뜨릴 수 있는 변경"
            open={open.must}
            onToggle={() => toggle("must")}
          >
            {renderCards(plan.must, plan.hidden.must, "위험도가 높은 변경은 없습니다.")}
          </Section>

          <Section
            id="should"
            icon="🟡"
            title="확인 권장"
            count={plan.should.length}
            description="의미 있는 변경이지만 위험도는 낮음"
            open={open.should}
            onToggle={() => toggle("should")}
          >
            {renderCards(plan.should, plan.hidden.should, "해당 없음")}
          </Section>

          <Section
            id="skim"
            icon="⚪"
            title="훑어봐도 됨"
            count={plan.skim.length}
            description="이름 변경·이동·타입·문서·단순 리팩터링 등 기계적인 변경"
            open={open.skim}
            onToggle={() => toggle("skim")}
          >
            {renderCards(plan.skim, plan.hidden.skim, "해당 없음")}
          </Section>

          <Section
            id="noise"
            icon="⚫"
            title="건너뛰어도 됨"
            count={noiseFiles.length}
            description="락파일·생성 코드·포맷팅 등 규칙으로 걸러낸 파일 (Claude에게 보내지 않음)"
            open={open.noise}
            onToggle={() => toggle("noise")}
          >
            {noiseFiles.length === 0 ? (
              <p className="text-sm text-ink-subtle">걸러낸 파일이 없습니다.</p>
            ) : (
              <NoiseList files={noiseFiles} meta={meta} />
            )}
          </Section>

          {attentionCount > 0 && (
            <Section
              id="attention"
              icon="🟣"
              title="확인 필요"
              count={attentionCount}
              description="자동 분석에서 빠진 부분 — GitHub에서 직접 확인하세요"
              open={open.attention}
              onToggle={() => toggle("attention")}
            >
              {unavailableFiles.length > 0 && <UnavailableList files={unavailableFiles} meta={meta} />}
              {omittedEntries.map((entry) => (
                <OmittedCard key={entry.omitted.hunkId} entry={entry} meta={meta} />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
