import { promises as fs } from "node:fs";
import path from "node:path";
import type { LookAt } from "./types";

export const MAX_LOOK_AT = 3;
const REASON_MAX = 120;
const MAX_COUNT_BYTES = 5 * 1024 * 1024;

/**
 * Which paths a lookAt entry may point to.
 * deep: files that exist in the checkout, with their line counts.
 * fast: the PR's own files (line count unknown → null, no clamping).
 */
export interface LookAtContext {
  files: Map<string, number | null>;
}

/** Repo-relative, normalized path, or null for absolute paths, `..`, and other junk. */
export function normalizeRelPath(input: string): string | null {
  const p = input.trim().replace(/^\.\/+/, "");
  if (!p || p.includes("\0") || p.includes("\\")) return null;
  if (p.startsWith("/") || p.startsWith("~") || /^[a-zA-Z]:/.test(p)) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

interface HunkSpan {
  path: string;
  newStart: number;
  newEnd: number;
}

/** Drops invalid entries, clamps lines, dedupes, and keeps at most three. */
export function validateLookAt(entries: LookAt[], ctx: LookAtContext, hunk: HunkSpan): LookAt[] {
  const out: LookAt[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rel = normalizeRelPath(entry.path);
    if (!rel || !ctx.files.has(rel)) continue;
    const lineCount = ctx.files.get(rel) ?? null;
    let line = Number.isFinite(entry.line) ? Math.max(0, Math.trunc(entry.line)) : 0;
    if (lineCount !== null) line = Math.min(line, lineCount);
    // The hunk itself is already on screen; "look at" means somewhere else.
    if (rel === hunk.path && line >= hunk.newStart && line <= hunk.newEnd && line > 0) continue;
    const key = `${rel}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = Array.from(entry.reason.trim());
    out.push({
      path: rel,
      line,
      reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1).join("")}…` : reason.join(""),
    });
    if (out.length >= MAX_LOOK_AT) break;
  }
  return out;
}

async function countLines(file: string, size: number): Promise<number> {
  if (size === 0) return 0;
  if (size > MAX_COUNT_BYTES) return Number.MAX_SAFE_INTEGER; // Too big to read; don't clamp.
  const buf = await fs.readFile(file);
  let n = 0;
  for (const byte of buf) if (byte === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** Line counts for the given repo-relative paths that exist as regular files inside repoDir. */
export async function collectRepoFiles(repoDir: string, paths: string[]): Promise<Map<string, number>> {
  const root = path.resolve(repoDir);
  const out = new Map<string, number>();
  const unique = [...new Set(paths.map(normalizeRelPath).filter((p): p is string => p !== null))];
  await Promise.all(
    unique.map(async (rel) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) return;
      try {
        const st = await fs.lstat(abs);
        if (!st.isFile()) return;
        out.set(rel, await countLines(abs, st.size));
      } catch {
        // Missing file: the entry gets dropped by validateLookAt.
      }
    }),
  );
  return out;
}
