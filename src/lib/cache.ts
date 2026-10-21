import { promises as fs } from "node:fs";
import path from "node:path";
import type { PrData, PrMeta, ReviewMode, ReviewResult } from "./types";

// File cache keyed by PR + head SHA + mode (and validated against the base SHA):
//   .cache/reviews/{owner}__{repo}__{n}__{headSha}__{mode}.json
// The directory can be moved with PR_LENS_CACHE_DIR.
// Older versions are ignored: they were classified under earlier skip rules
// (which could hide dist/, binaries, line-end changes and unparsed hunks), so a
// PR cached by them is analyzed again once.

export const CACHE_VERSION = 3;

export interface CacheEntry {
  version: typeof CACHE_VERSION;
  /** The mode the user asked for (the key); review.mode is what actually ran. */
  requestedMode: ReviewMode;
  pr: PrData;
  review: Omit<ReviewResult, "cached">;
}

export interface RecentReview {
  owner: string;
  repo: string;
  number: number;
  title: string;
  analyzedAt: string;
  mode: ReviewMode;
}

export function cacheDir(): string {
  const override = process.env.PR_LENS_CACHE_DIR?.trim();
  return override ? path.resolve(override) : path.join(process.cwd(), ".cache", "reviews");
}

/**
 * A cached result is only valid for the same base commit: if the PR was
 * retargeted (or its base moved), the diff differs even at the same head SHA.
 * Entries written before baseSha was recorded stay readable.
 */
export function matchesBase(entry: CacheEntry, meta: Pick<PrMeta, "baseSha">): boolean {
  const cachedBase = entry.pr.meta.baseSha;
  return !cachedBase || !meta.baseSha || cachedBase === meta.baseSha;
}

type Key = Pick<PrMeta, "owner" | "repo" | "number" | "headSha">;

export function cacheFileName(meta: Key, mode: ReviewMode): string {
  return `${meta.owner}__${meta.repo}__${meta.number}__${meta.headSha}__${mode}.json`;
}

function prPrefix(meta: Pick<PrMeta, "owner" | "repo" | "number">): string {
  return `${meta.owner}__${meta.repo}__${meta.number}__`;
}

const SUFFIX_RE = /^[0-9a-f]{40,64}(?:__(?:deep|fast))?\.json$/;

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null;

function looksLikePr(pr: unknown): pr is PrData {
  return isObj(pr) && isObj(pr.meta) && typeof pr.meta.title === "string" && Array.isArray(pr.files);
}

/** Accepts current entries only; older, corrupt or future ones are ignored. */
export function parseCacheEntry(raw: unknown): CacheEntry | null {
  if (!isObj(raw)) return null;
  if (raw.version !== CACHE_VERSION) return null;
  const review = raw.review;
  if (!looksLikePr(raw.pr) || !isObj(review) || !Array.isArray(review.items) || typeof review.mode !== "string") {
    return null;
  }
  return raw as unknown as CacheEntry;
}

async function readEntry(file: string): Promise<CacheEntry | null> {
  try {
    return parseCacheEntry(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

export async function readCache(meta: PrMeta, mode: ReviewMode): Promise<CacheEntry | null> {
  const dir = cacheDir();
  const entry = await readEntry(path.join(dir, cacheFileName(meta, mode)));
  return entry && matchesBase(entry, meta) ? entry : null;
}

export async function writeCache(entry: CacheEntry): Promise<void> {
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, cacheFileName(entry.pr.meta, entry.requestedMode));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
  await fs.rename(tmp, target);
}

/** All cached analyses of one PR (any head SHA, any mode). */
export async function listPrEntries(meta: Pick<PrMeta, "owner" | "repo" | "number">): Promise<CacheEntry[]> {
  const dir = cacheDir();
  const prefix = prPrefix(meta);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const entries = await Promise.all(
    names
      .filter((n) => n.startsWith(prefix) && SUFFIX_RE.test(n.slice(prefix.length)))
      .map((n) => readEntry(path.join(dir, n))),
  );
  return entries.filter(
    (e): e is CacheEntry =>
      e !== null && e.pr.meta.owner === meta.owner && e.pr.meta.repo === meta.repo && e.pr.meta.number === meta.number,
  );
}

/**
 * Whether a cached analysis may be inherited from by a run in `mode`: it must
 * have been requested in that mode AND actually run in it. A deep request that
 * fell back to fast (repo too large) is cached under the deep key with its
 * warning and can still be served for its own head SHA, but its diff-only
 * items must never be passed on to a later deep run as if they were deep items.
 * Every hunk must also carry an anchorKey, so a verdict is only inherited by
 * the same change at the same place.
 */
export function isInheritanceSource(entry: CacheEntry, mode: ReviewMode): boolean {
  return (
    entry.requestedMode === mode &&
    entry.review.mode === mode &&
    entry.pr.files.every((f) => f.hunks.every((h) => typeof h.anchorKey === "string"))
  );
}

/**
 * The analysis to diff against: most recent (by analyzedAt) entry of the same
 * PR at a different head SHA that is an inheritance source for `mode`.
 */
export function pickPrevious(entries: CacheEntry[], headSha: string, mode: ReviewMode): CacheEntry | null {
  return (
    entries
      .filter((e) => e.pr.meta.headSha !== headSha && isInheritanceSource(e, mode))
      .sort((a, b) => b.review.analyzedAt.localeCompare(a.review.analyzedAt))[0] ?? null
  );
}

export async function findPrevious(meta: PrMeta, mode: ReviewMode): Promise<CacheEntry | null> {
  return pickPrevious(await listPrEntries(meta), meta.headSha, mode);
}

/** Most recently analyzed PRs (one row per PR, newest file wins). */
export async function listRecentReviews(limit = 20): Promise<RecentReview[]> {
  const dir = cacheDir();
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }

  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtime: (await fs.stat(path.join(dir, name))).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const newestFirst = stats
    .filter((s): s is { name: string; mtime: number } => s !== null)
    .sort((a, b) => b.mtime - a.mtime);

  const seen = new Set<string>();
  const out: RecentReview[] = [];
  for (const { name } of newestFirst) {
    if (out.length >= limit) break;
    const entry = await readEntry(path.join(dir, name));
    if (!entry) continue;
    const { owner, repo, number, title } = entry.pr.meta;
    const key = `${owner}/${repo}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo, number, title, analyzedAt: entry.review.analyzedAt, mode: entry.requestedMode });
  }
  return out;
}
