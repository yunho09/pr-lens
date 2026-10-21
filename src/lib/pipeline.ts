import { createHash } from "node:crypto";
import { CACHE_VERSION, findPrevious, readCache, writeCache } from "./cache";
import { ensureCheckout, CheckoutTooLargeError, type CheckoutHandle } from "./checkout";
import { runClaude as defaultRunClaude, type RunClaude } from "./claude";
import { parsePatch } from "./diff";
import { hunkFingerprint } from "./fingerprint";
import { fetchPullFiles, fetchPullMeta, type GitHubFile } from "./github";
import { parsePrUrl } from "./github-url";
import { classifyFile, fileRole } from "./noise";
import { triagePr } from "./triage";
import type { PrData, PrFile, PrMeta, ReviewEvent, ReviewMode, ReviewResult } from "./types";

export function buildPrData(meta: PrMeta, rawFiles: GitHubFile[]): PrData {
  const files: PrFile[] = rawFiles.map((f, index) => {
    const hasPatch = typeof f.patch === "string" && f.patch.length > 0;
    const hunks = hasPatch
      ? parsePatch(f.patch!, index).map((h) => ({ ...h, fingerprint: hunkFingerprint(f.filename, h) }))
      : [];
    const file = {
      index,
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      hasPatch,
      role: fileRole(f.filename),
      anchor: createHash("sha256").update(f.filename).digest("hex"),
      hunks,
    };
    return { ...file, classification: classifyFile(file) };
  });
  return { meta, files };
}

export interface ReviewRequest {
  url: string;
  refresh: boolean;
  mode: ReviewMode;
  /**
   * Serve a cached result if there is one, otherwise stop after sending the
   * PR (no Claude call). Used when the page was opened from another site.
   */
  cacheOnly?: boolean;
}

/** Korean warning when GitHub returned fewer files than the PR changed (files API caps at 3000). */
export function missingFilesWarning(changedFiles: number, received: number): string | null {
  if (received >= changedFiles) return null;
  return `GitHub이 변경 파일 ${changedFiles}개 중 ${received}개만 제공했습니다 (최대 3000개). 나머지 ${changedFiles - received}개는 분석하지 못했으니 GitHub에서 직접 확인하세요.`;
}

export interface ReviewDeps {
  runClaude?: RunClaude;
}

export async function runReview(
  request: ReviewRequest,
  emit: (event: ReviewEvent) => void,
  signal: AbortSignal,
  deps: ReviewDeps = {},
): Promise<void> {
  const parsed = parsePrUrl(request.url);
  if (!parsed.ok) {
    emit({ type: "error", message: parsed.message });
    return;
  }
  const ref = parsed.ref;
  const { mode } = request;

  emit({ type: "stage", stage: "fetching", message: "GitHub에서 PR을 가져오는 중" });
  const meta = await fetchPullMeta(ref, signal);

  if (!request.refresh) {
    const cached = await readCache(meta, mode);
    if (cached) {
      emit({ type: "pr", data: cached.pr });
      emit({ type: "result", data: { ...cached.review, cached: true } });
      return;
    }
  }

  const rawFiles = await fetchPullFiles(ref, signal);

  emit({ type: "stage", stage: "filtering", message: "노이즈 파일을 걸러내는 중" });
  const pr = buildPrData(meta, rawFiles);
  emit({ type: "pr", data: pr });
  if (request.cacheOnly) return;

  const previous = await findPrevious(meta, mode);

  const warnings: string[] = [];
  const missing = missingFilesWarning(meta.changedFiles, rawFiles.length);
  if (missing) warnings.push(missing);

  let checkout: CheckoutHandle | undefined;
  // A deep request that fell back to fast for a transient reason is not cached
  // under the deep key, so the next visit tries the checkout again.
  let cacheable = true;
  if (mode === "deep") {
    emit({ type: "stage", stage: "checkout", message: "레포 코드를 내려받는 중" });
    try {
      checkout = await ensureCheckout(meta, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof CheckoutTooLargeError) {
        warnings.push(err.message);
      } else {
        cacheable = false;
        warnings.push(`레포를 내려받지 못해 diff만 분석했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  try {
    emit({
      type: "stage",
      stage: "analyzing",
      message: checkout ? "Claude가 주변 코드와 함께 읽는 중" : "Claude가 변경 사항을 읽는 중",
    });
    const review = await triagePr(pr, {
      runClaude: deps.runClaude ?? defaultRunClaude,
      signal,
      repoDir: checkout?.dir,
      previous,
      allowInherit: !request.refresh,
      onActivity: (activity) => emit({ type: "activity", ...activity }),
    });
    const stored: Omit<ReviewResult, "cached"> = {
      ...review,
      warnings: [...warnings, ...review.warnings],
      analyzedAt: new Date().toISOString(),
    };

    if (cacheable) {
      try {
        await writeCache({ version: CACHE_VERSION, requestedMode: mode, pr, review: stored });
      } catch (err) {
        // A failed cache write must not throw away a finished analysis.
        console.error("[pr-lens] 캐시 저장 실패:", err);
      }
    }
    emit({ type: "result", data: { ...stored, cached: false } });
  } finally {
    checkout?.release();
  }
}
