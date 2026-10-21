"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { prUrl } from "@/lib/github-url";
import { readNdjson } from "@/lib/ndjson";
import type { PrData, ReviewEvent, ReviewMode, ReviewResult, ReviewStage } from "@/lib/types";
import { KeptFileList, NoiseList, UnavailableList } from "./FileLists";
import { PrHeader } from "./PrHeader";
import { ProgressPanel } from "./ProgressPanel";
import { ReviewBody } from "./ReviewBody";
import { NO_ACTIVITY, pushActivity, type ActivityState } from "./review-model";

interface SessionState {
  /** "idle": opened from another site, no cached result; waiting for "분석 시작". */
  status: "running" | "done" | "error" | "idle";
  stage: ReviewStage | null;
  stageMessage: string | null;
  startedAt: number | null;
  stageStartedAt: number | null;
  pr: PrData | null;
  result: ReviewResult | null;
  error: string | null;
  activity: ActivityState;
}

type Action =
  | { type: "started"; at: number }
  | { type: "event"; event: ReviewEvent; at: number }
  | { type: "failed"; message: string }
  | { type: "awaiting" };

const INITIAL: SessionState = {
  status: "running",
  stage: null,
  stageMessage: null,
  startedAt: null,
  stageStartedAt: null,
  pr: null,
  result: null,
  error: null,
  activity: NO_ACTIVITY,
};

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "started":
      return { ...INITIAL, startedAt: action.at, stageStartedAt: action.at };
    case "failed":
      return { ...state, status: "error", error: action.message };
    case "awaiting":
      return { ...state, status: "idle" };
    case "event": {
      const { event } = action;
      switch (event.type) {
        case "stage":
          return { ...state, stage: event.stage, stageMessage: event.message, stageStartedAt: action.at };
        case "pr":
          return { ...state, pr: event.data };
        case "activity":
          return { ...state, activity: pushActivity(state.activity, { tool: event.tool, target: event.target }) };
        case "result":
          return { ...state, status: "done", result: event.data };
        case "error":
          return { ...state, status: "error", error: event.message };
      }
      return state;
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function streamReview(
  body: { url: string; refresh: boolean; mode: ReviewMode; cacheOnly: boolean },
  signal: AbortSignal,
  dispatch: (action: Action) => void,
) {
  dispatch({ type: "started", at: Date.now() });
  let res: Response;
  try {
    res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (!signal.aborted) dispatch({ type: "failed", message: `서버에 연결할 수 없습니다: ${errorText(err)}` });
    return;
  }
  if (!res.body) {
    dispatch({ type: "failed", message: `서버 응답이 비어 있습니다 (HTTP ${res.status}).` });
    return;
  }

  let finished = false;
  try {
    await readNdjson(res.body, (value) => {
      const event = value as ReviewEvent;
      if (event.type === "result" || event.type === "error") finished = true;
      dispatch({ type: "event", event, at: Date.now() });
    });
  } catch (err) {
    if (!signal.aborted) dispatch({ type: "failed", message: `응답을 읽는 중 연결이 끊겼습니다: ${errorText(err)}` });
    return;
  }
  if (!finished && !signal.aborted) {
    // A cache-only request ends without a result when nothing is cached yet.
    dispatch(
      body.cacheOnly
        ? { type: "awaiting" }
        : { type: "failed", message: "분석이 끝나기 전에 서버 연결이 끊겼습니다. 서버 로그를 확인하세요." },
    );
  }
}

interface ReviewViewProps {
  owner: string;
  repo: string;
  number: number;
  initialMode: ReviewMode;
  /** False when the page was opened from another site: load only a cached result until the user clicks. */
  autoStart?: boolean;
}

export function ReviewView({ initialMode, autoStart = true, ...props }: ReviewViewProps) {
  // A new run id remounts the session: fresh state and a new request.
  const [run, setRun] = useState({ id: 0, mode: initialMode, refresh: false, cacheOnly: !autoStart });

  const changeMode = (mode: ReviewMode) => {
    setRun((r) => ({ id: r.id + 1, mode, refresh: false, cacheOnly: false }));
    window.history.replaceState(null, "", mode === "fast" ? "?mode=fast" : window.location.pathname);
  };

  return (
    <ReviewSession
      key={run.id}
      {...props}
      mode={run.mode}
      refresh={run.refresh}
      cacheOnly={run.cacheOnly}
      onRefresh={() => setRun((r) => ({ ...r, id: r.id + 1, refresh: true, cacheOnly: false }))}
      onStart={() => setRun((r) => ({ ...r, id: r.id + 1, refresh: false, cacheOnly: false }))}
      onModeChange={changeMode}
    />
  );
}

interface SessionProps {
  owner: string;
  repo: string;
  number: number;
  mode: ReviewMode;
  refresh: boolean;
  cacheOnly: boolean;
  onRefresh: () => void;
  onStart: () => void;
  onModeChange: (mode: ReviewMode) => void;
}

function ReviewSession({ owner, repo, number, mode, refresh, cacheOnly, onRefresh, onStart, onModeChange }: SessionProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [now, setNow] = useState<number | null>(null);
  // With Cache Components a hidden route keeps its state but re-runs effects
  // when shown again; a finished session must not start (and pay for) a new run.
  const finishedRef = useRef(false);

  useEffect(() => {
    if (state.status === "done") finishedRef.current = true;
  }, [state.status]);

  useEffect(() => {
    if (finishedRef.current) return;
    const controller = new AbortController();
    void streamReview({ url: prUrl({ owner, repo, number }), refresh, mode, cacheOnly }, controller.signal, dispatch);
    // Leaving the page aborts the request; the server then kills the Claude process.
    return () => controller.abort();
  }, [owner, repo, number, refresh, mode, cacheOnly]);

  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const { pr, result } = state;
  useEffect(() => {
    document.title = pr ? `${pr.meta.title} · ${owner}/${repo}#${number} · PR Lens` : `${owner}/${repo}#${number} · PR Lens`;
  }, [pr, owner, repo, number]);

  const seconds = (from: number | null) => (from !== null && now !== null ? Math.max(0, Math.round((now - from) / 1000)) : 0);

  const noiseFiles = pr?.files.filter((f) => f.classification.kind === "skip") ?? [];
  const unavailableFiles = pr?.files.filter((f) => f.classification.kind === "unavailable") ?? [];
  const keptFiles = pr?.files.filter((f) => f.classification.kind === "keep" && f.hunks.length > 0) ?? [];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <PrHeader
        owner={owner}
        repo={repo}
        number={number}
        meta={pr?.meta ?? null}
        result={result}
        running={running}
        mode={mode}
        onModeChange={onModeChange}
        onRefresh={onRefresh}
      />

      {running && (
        <ProgressPanel
          mode={mode}
          stage={state.stage}
          stageMessage={state.stageMessage}
          elapsedSec={seconds(state.startedAt)}
          stageElapsedSec={seconds(state.stageStartedAt)}
          activity={state.activity}
        />
      )}

      {state.status === "idle" && (
        <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-ink">
            앱 밖(주소창·북마크·다른 앱이나 사이트의 링크)에서 열어서 자동으로 분석하지 않았습니다. PR을 확인한 뒤
            시작하세요.
          </p>
          <button
            type="button"
            onClick={onStart}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-on-accent hover:opacity-90"
          >
            분석 시작
          </button>
        </section>
      )}

      {state.status === "error" && (
        <section role="alert" className="rounded-lg border border-danger bg-danger-soft p-4">
          <h2 className="font-semibold text-danger">분석하지 못했습니다</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{state.error}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="mt-3 inline-flex h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-2"
          >
            다시 시도
          </button>
        </section>
      )}

      {result && pr && (
        <>
          {result.warnings.length > 0 && (
            <section role="status" className="rounded-lg border border-should bg-should-soft p-4 text-sm text-ink">
              <h2 className="font-semibold text-should">⚠ 주의</h2>
              <ul className="mt-1 list-disc pl-5 leading-relaxed">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="rounded-lg border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold text-ink-muted">이 PR은</h2>
            <p className="mt-1 leading-relaxed text-ink">{result.summary}</p>
          </section>
          <ReviewBody key={`${pr.meta.headSha}:${result.mode}`} pr={pr} result={result} />
        </>
      )}

      {!result && pr && (
        <div className="flex flex-col gap-6">
          {keptFiles.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-muted">Claude가 읽는 파일 {keptFiles.length}개</h2>
              <KeptFileList files={keptFiles} />
            </section>
          )}
          {unavailableFiles.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-muted">🟣 확인 필요 {unavailableFiles.length}개</h2>
              <UnavailableList files={unavailableFiles} meta={pr.meta} />
            </section>
          )}
          {noiseFiles.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-muted">⚫ 건너뛰어도 됨 {noiseFiles.length}개</h2>
              <NoiseList files={noiseFiles} meta={pr.meta} />
            </section>
          )}
        </div>
      )}
    </main>
  );
}
