import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheFileName, readCache } from "./cache";
import type { RunClaude } from "./claude";
import { missingFilesWarning, runReview, type ReviewRequest } from "./pipeline";
import type { PrMeta, ReviewEvent, ReviewResult } from "./types";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const URL_ = "https://github.com/acme/app/pull/7";

let tmp: string;
let claudeCalls = 0;

/** Minimal GitHub API stand-in for one PR. `tarball` decides the deep-mode checkout outcome. */
function fakeGitHub(opts: { changedFiles?: number; baseSha?: string; headSha?: string; tarball: () => Response }) {
  return async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/pulls/7")) {
      return Response.json({
        title: "Fix",
        body: "",
        html_url: URL_,
        user: { login: "octo" },
        head: { sha: opts.headSha ?? HEAD, ref: "feat" },
        base: { sha: opts.baseSha ?? BASE, ref: "main" },
        additions: 1,
        deletions: 1,
        changed_files: opts.changedFiles ?? 1,
      });
    }
    if (url.includes("/pulls/7/files")) {
      return Response.json([
        { filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" },
      ]);
    }
    if (url.includes("/tarball/")) return opts.tarball();
    return new Response("not found", { status: 404 });
  };
}

const fakeClaude: RunClaude = async (_s, _p, schema) => {
  claudeCalls++;
  return {
    data: schema.parse({
      summary: "요약",
      readingOrder: [],
      items: [
        {
          hunkId: "f0h0",
          priority: "skim",
          category: "logic",
          title: "t",
          explain: "",
          why: "w",
          check: "",
          highlight: [],
          lookAt: [],
        },
      ],
    }),
    costUsd: 0,
    durationMs: 1,
    toolCalls: 0,
    permissionDenials: 0,
  };
};

async function run(request: Partial<ReviewRequest>): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  await runReview(
    { url: URL_, refresh: false, mode: "deep", ...request },
    (e) => events.push(e),
    new AbortController().signal,
    { runClaude: fakeClaude },
  );
  return events;
}

const resultOf = (events: ReviewEvent[]) =>
  (events.find((e) => e.type === "result") as { data: ReviewResult } | undefined)?.data;

const meta = { owner: "acme", repo: "app", number: 7, headSha: HEAD, baseSha: BASE } as PrMeta;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "pr-lens-pipeline-"));
  claudeCalls = 0;
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("PR_LENS_CACHE_DIR", path.join(tmp, "reviews"));
  vi.stubEnv("XDG_CACHE_HOME", path.join(tmp, "xdg"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("runReview deep → fast fallback caching", () => {
  it("does not cache a transient checkout failure under the deep key", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ tarball: () => new Response("boom", { status: 502 }) }));
    const events = await run({});
    const result = resultOf(events)!;
    expect(result.mode).toBe("fast");
    expect(result.warnings.join(" ")).toContain("레포를 내려받지 못해");
    expect(await readCache(meta, "deep")).toBeNull();
    expect(await readdir(path.join(tmp, "reviews")).catch(() => [])).toEqual([]);
  });

  it("does not cache an unreadable archive either, and says the listing could not be checked", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ tarball: () => new Response("this is not a tarball") }));
    const result = resultOf(await run({}))!;
    expect(result.mode).toBe("fast");
    expect(result.warnings.join(" ")).toContain("레포 목록을 확인할 수 없음");
    expect(result.warnings.join(" ")).not.toContain("너무 커서");
    expect(await readCache(meta, "deep")).toBeNull();
  });

  it("does cache the too-large fallback (retrying would fail the same way)", async () => {
    vi.stubGlobal(
      "fetch",
      fakeGitHub({ tarball: () => new Response("x", { headers: { "content-length": String(400 * 1024 * 1024) } }) }),
    );
    const result = resultOf(await run({}))!;
    expect(result.mode).toBe("fast");
    expect(result.warnings.join(" ")).toContain("레포가 너무 커서");
    expect(await readdir(path.join(tmp, "reviews"))).toEqual([cacheFileName(meta, "deep")]);

    // Second request is served from cache without calling Claude again.
    const before = claudeCalls;
    expect(resultOf(await run({}))?.cached).toBe(true);
    expect(claudeCalls).toBe(before);
  });
});

describe("runReview cache key includes the base SHA", () => {
  it("re-analyzes when the PR was retargeted to a different base", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ tarball: () => new Response("x", { status: 502 }) }));
    await run({ mode: "fast" });
    expect(claudeCalls).toBe(1);
    expect(resultOf(await run({ mode: "fast" }))?.cached).toBe(true);
    expect(claudeCalls).toBe(1);

    vi.stubGlobal("fetch", fakeGitHub({ baseSha: "c".repeat(40), tarball: () => new Response("x", { status: 502 }) }));
    expect(resultOf(await run({ mode: "fast" }))?.cached).toBe(false);
    expect(claudeCalls).toBe(2);
  });
});

describe("runReview cacheOnly (page opened from another site)", () => {
  it("sends the PR but never calls Claude when nothing is cached", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ tarball: () => new Response("x", { status: 502 }) }));
    const events = await run({ mode: "fast", cacheOnly: true });
    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "pr"]);
    expect(claudeCalls).toBe(0);
  });

  it("serves a cached result", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ tarball: () => new Response("x", { status: 502 }) }));
    await run({ mode: "fast" });
    const events = await run({ mode: "fast", cacheOnly: true });
    expect(resultOf(events)?.cached).toBe(true);
    expect(claudeCalls).toBe(1);
  });
});

describe("files API cap", () => {
  it("warns with the size of the gap", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ changedFiles: 3200, tarball: () => new Response("x", { status: 502 }) }));
    const result = resultOf(await run({ mode: "fast" }))!;
    expect(result.warnings).toContain(missingFilesWarning(3200, 1));
    expect(missingFilesWarning(3200, 1)).toContain("3200개 중 1개만");
    expect(missingFilesWarning(3200, 1)).toContain("나머지 3199개");
    expect(missingFilesWarning(5, 5)).toBeNull();
  });
});

describe("runReview inherits only from the same mode", () => {
  it("a deep run after a fast analysis of an earlier head does not reuse the fast items", async () => {
    // Reviewer's case: fast analysis at head A, then a push (head B, same hunks), then a deep run.
    // Before the fix the deep run picked the fast entry, reused it, made 0 Claude calls
    // and showed only inherited skim items.
    vi.stubGlobal("fetch", fakeGitHub({ headSha: "1".repeat(40), tarball: () => new Response("x", { status: 502 }) }));
    await run({ mode: "fast" });
    expect(claudeCalls).toBe(1);

    vi.stubGlobal(
      "fetch",
      fakeGitHub({ headSha: "2".repeat(40), tarball: () => new Response("x", { headers: { "content-length": String(400 * 1024 * 1024) } }) }),
    );
    const deep = resultOf(await run({ mode: "deep" }))!;
    expect(claudeCalls).toBe(2);
    expect(deep.previous).toBeNull();
    expect(deep.items.every((i) => i.source !== "inherited")).toBe(true);
    expect(deep.sentHunkIds).toEqual(["f0h0"]);
  });

  it("a fast run after a fast analysis of an earlier head still inherits", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ headSha: "1".repeat(40), tarball: () => new Response("x", { status: 502 }) }));
    await run({ mode: "fast" });
    vi.stubGlobal("fetch", fakeGitHub({ headSha: "2".repeat(40), tarball: () => new Response("x", { status: 502 }) }));
    const second = resultOf(await run({ mode: "fast" }))!;
    expect(claudeCalls).toBe(1); // reused: only noise could have changed
    expect(second.previous?.headSha).toBe("1".repeat(40));
    expect(second.items.every((i) => i.source === "inherited")).toBe(true);
  });
});

describe("runReview never inherits a deep→fast fallback as deep items", () => {
  it("serves the fallback for its own head, but a later deep run re-analyzes", async () => {
    const tooLarge = () => new Response("x", { headers: { "content-length": String(400 * 1024 * 1024) } });
    vi.stubGlobal("fetch", fakeGitHub({ headSha: "1".repeat(40), tarball: tooLarge }));
    const first = resultOf(await run({ mode: "deep" }))!;
    expect(first.mode).toBe("fast");
    expect(claudeCalls).toBe(1);

    // Same head: served from the deep key, with its warning.
    const again = resultOf(await run({ mode: "deep" }))!;
    expect(again.cached).toBe(true);
    expect(again.warnings.join(" ")).toContain("레포가 너무 커서");
    expect(claudeCalls).toBe(1);

    // New head with the same hunks: no inheritance from the fast-run entry.
    vi.stubGlobal("fetch", fakeGitHub({ headSha: "2".repeat(40), tarball: tooLarge }));
    const next = resultOf(await run({ mode: "deep" }))!;
    expect(claudeCalls).toBe(2);
    expect(next.previous).toBeNull();
    expect(next.items.some((i) => i.source === "inherited")).toBe(false);
  });
});
