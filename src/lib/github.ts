import { execFile } from "node:child_process";
import { z } from "zod";
import type { PrRef } from "./github-url";
import type { PrMeta } from "./types";

const API = "https://api.github.com";
const MAX_FILE_PAGES = 30; // GitHub caps the files endpoint at 3000 files.

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

let tokenPromise: Promise<string | null> | null = null;

/** GITHUB_TOKEN, else `gh auth token` (memoized). Never sent to the browser. */
export function getGitHubToken(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  if (!tokenPromise) {
    tokenPromise = new Promise<string | null>((resolve) => {
      execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout) => {
        const token = stdout?.trim();
        resolve(!err && token ? token : null);
      });
    }).then((token) => {
      // Retry on a later request if gh was not logged in yet.
      if (!token) tokenPromise = null;
      return token;
    });
  }
  return tokenPromise;
}

const pullSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
});

const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.string().optional(),
});

export type GitHubFile = z.infer<typeof fileSchema>;

function formatReset(epochSeconds: string | null): string {
  const n = Number(epochSeconds);
  if (!epochSeconds || !Number.isFinite(n)) return "";
  const d = new Date(n * 1000);
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const mins = Math.max(0, Math.ceil((d.getTime() - Date.now()) / 60000));
  return ` ${time}에 초기화됩니다 (약 ${mins}분 후).`;
}

async function errorFromResponse(res: Response, ref: PrRef): Promise<GitHubError> {
  let apiMessage = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") apiMessage = body.message;
  } catch {
    // Body was not JSON; the status code is enough.
  }
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  const remaining = res.headers.get("x-ratelimit-remaining");

  if ((res.status === 403 || res.status === 429) && (remaining === "0" || /rate limit/i.test(apiMessage))) {
    const retryAfter = res.headers.get("retry-after");
    const when = retryAfter
      ? ` ${retryAfter}초 후에 다시 시도하세요.`
      : formatReset(res.headers.get("x-ratelimit-reset"));
    return new GitHubError(`GitHub API 사용 한도를 초과했습니다.${when} (${apiMessage || res.status})`);
  }
  if (res.status === 404) {
    return new GitHubError(
      `PR을 찾을 수 없습니다: ${target}. 존재하지 않거나, 비공개 저장소라 접근 권한이 없을 수 있습니다 (gh auth login 계정 확인).`,
    );
  }
  if (res.status === 401) {
    return new GitHubError(
      `GitHub 인증에 실패했습니다. 토큰이 만료되었거나 잘못되었습니다. \`gh auth login\`을 다시 하거나 GITHUB_TOKEN을 확인하세요. (${apiMessage || "401"})`,
    );
  }
  if (res.status === 403) {
    return new GitHubError(`GitHub이 접근을 거부했습니다 (403): ${apiMessage || "권한 없음"}`);
  }
  return new GitHubError(`GitHub API 오류 (${res.status}): ${apiMessage || res.statusText}`);
}

/** Standard REST headers, with the token when one is available. */
export async function githubHeaders(): Promise<Record<string, string>> {
  const token = await getGitHubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-lens",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghFetch(url: string, ref: PrRef, signal?: AbortSignal): Promise<Response> {
  const headers = await githubHeaders();
  let res: Response;
  try {
    res = await fetch(url, { headers, signal, cache: "no-store" });
  } catch (err) {
    if (signal?.aborted) throw new GitHubError("요청이 취소되었습니다.");
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new GitHubError(`GitHub에 연결할 수 없습니다. 네트워크를 확인하세요. (${cause})`);
  }
  if (!res.ok) throw await errorFromResponse(res, ref);
  return res;
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new GitHubError(`GitHub 응답 형식이 예상과 다릅니다 (${what}: ${issue?.path.join(".")} ${issue?.message})`);
  }
  return result.data;
}

export async function fetchPullMeta(ref: PrRef, signal?: AbortSignal): Promise<PrMeta> {
  const res = await ghFetch(`${API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, ref, signal);
  const pull = parseOrThrow(pullSchema, await res.json(), "pull");
  if (!/^[0-9a-f]{40,64}$/.test(pull.head.sha)) {
    throw new GitHubError(`GitHub이 올바르지 않은 head SHA를 반환했습니다: ${pull.head.sha}`);
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: pull.title,
    body: pull.body ?? "",
    author: pull.user?.login ?? "(알 수 없음)",
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    headRef: pull.head.ref,
    additions: pull.additions,
    deletions: pull.deletions,
    changedFiles: pull.changed_files,
    htmlUrl: pull.html_url,
  };
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

export async function fetchPullFiles(ref: PrRef, signal?: AbortSignal): Promise<GitHubFile[]> {
  const files: GitHubFile[] = [];
  let url: string | null = `${API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`;
  for (let page = 0; url && page < MAX_FILE_PAGES; page++) {
    const res = await ghFetch(url, ref, signal);
    files.push(...parseOrThrow(z.array(fileSchema), await res.json(), "files"));
    url = nextLink(res.headers.get("link"));
  }
  return files;
}

// ---- Used by the dev scripts (eval, simulate-incremental) ----

const pullListItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  merged_at: z.string().nullable(),
});
export type PullListItem = z.infer<typeof pullListItemSchema>;

/** Recently closed PRs that were merged, newest first, scanning up to `scan` closed PRs. */
export async function fetchRecentMergedPulls(owner: string, repo: string, scan: number): Promise<PullListItem[]> {
  const ref = { owner, repo, number: 0 };
  const out: PullListItem[] = [];
  let url: string | null = `${API}/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
  let scanned = 0;
  while (url && scanned < scan) {
    const res = await ghFetch(url, ref);
    const page = parseOrThrow(z.array(pullListItemSchema), await res.json(), "pulls");
    for (const p of page.slice(0, scan - scanned)) if (p.merged_at) out.push(p);
    scanned += page.length;
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

/** Returns null when `number` is an issue or an unmerged PR. */
export async function fetchMergedPullMeta(owner: string, repo: string, number: number): Promise<PrMeta | null> {
  const ref = { owner, repo, number };
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
    headers: await githubHeaders(),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFromResponse(res, ref);
  const raw = (await res.json()) as { merged_at?: string | null };
  if (!raw.merged_at) return null;
  return fetchPullMeta(ref);
}

const compareSchema = z.object({ files: z.array(fileSchema).optional() });

/** Files changed between two commits (three-dot: from their merge base). */
export async function fetchCompareFiles(owner: string, repo: string, base: string, head: string): Promise<GitHubFile[]> {
  const ref = { owner, repo, number: 0 };
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/compare/${base}...${head}?per_page=100`, ref);
  return parseOrThrow(compareSchema, await res.json(), "compare").files ?? [];
}

const commitSchema = z.object({ sha: z.string() });

/** Full SHA for a commit-ish (short SHA, branch, tag). */
export async function resolveCommitSha(owner: string, repo: string, commitish: string): Promise<string> {
  const ref = { owner, repo, number: 0 };
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(commitish)}`, ref);
  return parseOrThrow(commitSchema, await res.json(), "commit").sha;
}
