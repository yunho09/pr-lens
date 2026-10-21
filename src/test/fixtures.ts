import type { GitHubFile } from "@/lib/github";
import { buildPrData } from "@/lib/pipeline";
import type { PrData, PrMeta } from "@/lib/types";

// Shared builders for unit tests.

export const META: PrMeta = {
  owner: "acme",
  repo: "app",
  number: 42,
  title: "Add retry to fetcher",
  body: "Adds retries.",
  author: "octocat",
  headSha: "a".repeat(40),
  baseRef: "main",
  headRef: "feat/retry",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  htmlUrl: "https://github.com/acme/app/pull/42",
};

export function ghFile(filename: string, patch: string | undefined, extra: Partial<GitHubFile> = {}): GitHubFile {
  return { filename, status: "modified", additions: 1, deletions: 1, changes: 2, patch, ...extra };
}

export function makePr(files: GitHubFile[], meta: Partial<PrMeta> = {}): PrData {
  return buildPrData({ ...META, ...meta }, files);
}

/** A patch with `n` changed lines of roughly `width` characters each. */
export function bigPatch(n: number, width = 40): string {
  const lines = [`@@ -1,${n} +1,${n} @@`];
  for (let i = 0; i < n; i++) lines.push(`+${"x".repeat(width)}${i}`);
  return lines.join("\n");
}
