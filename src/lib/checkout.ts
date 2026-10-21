import { execFile, spawn } from "node:child_process";
import { createWriteStream, promises as fs, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { githubHeaders } from "./github";

const execFileP = promisify(execFile);

// Read-only snapshot of the repo at the PR head, for deep mode. Lives outside
// the project tree (a hostile CLAUDE.md in a checkout must not be picked up by
// the owner's own Claude Code sessions in this repo):
//   ${XDG_CACHE_HOME:-~/.cache}/pr-lens/repos/{owner}__{repo}__{sha}/

export const MAX_TARBALL_BYTES = 300 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;
export const MAX_CHECKOUTS = 5;
const STALE_TEMP_MS = 60 * 60 * 1000;

export class CheckoutTooLargeError extends Error {
  constructor(detail = "압축 파일 300MB 초과") {
    super(`레포가 너무 커서 diff만 분석했습니다 (${detail}).`);
    this.name = "CheckoutTooLargeError";
  }
}

/**
 * The archive listing could not be read. Unlike CheckoutTooLargeError this is
 * treated as transient: the fast fallback is not cached under the deep key.
 */
export class CheckoutListingError extends Error {
  constructor(detail: string) {
    super(`레포 목록을 확인할 수 없음 (${detail})`);
    this.name = "CheckoutListingError";
  }
}

/**
 * Size column of one `tar -tv --numeric-owner` line
 * ("-rw-r--r-- 1000/1000  1234 2026-10-21 01:00 path"). Throws when it is not a
 * non-negative integer, so an unexpected listing fails closed instead of
 * silently counting as 0 bytes.
 */
export function parseListingSize(line: string): number {
  const field = line.trim().split(/\s+/)[2] ?? "";
  if (!/^\d+$/.test(field)) {
    throw new CheckoutListingError("압축 파일 목록의 형식이 예상과 다름");
  }
  return Number(field);
}

export function defaultReposDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "pr-lens", "repos");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

const NON_REGULAR = ["-mindepth", "1", "!", "-type", "f", "!", "-type", "d"];

/**
 * Deletes every symlink and non-regular file (fifo, socket, device) under root
 * without following links, then verifies none is left (fail closed). Uses
 * find(1) so names that are not valid UTF-8 are handled as raw bytes.
 * Returns how many entries were removed.
 */
export async function removeNonRegularFiles(root: string): Promise<number> {
  const { stdout } = await execFileP("find", [root, ...NON_REGULAR, "-printf", ".", "-delete"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const { stdout: left } = await execFileP("find", [root, ...NON_REGULAR, "-printf", ".", "-quit"]);
  if (left.length > 0) {
    throw new Error("체크아웃에서 심볼릭 링크 등 일반 파일이 아닌 항목을 지우지 못했습니다.");
  }
  return stdout.length;
}

/**
 * Lists a .tar.gz without extracting it and fails fast when the uncompressed
 * size or the entry count is over the limit (decompression bombs).
 */
export async function inspectTarball(
  tarPath: string,
  limits: { maxBytes: number; maxEntries: number } = { maxBytes: MAX_EXTRACTED_BYTES, maxEntries: MAX_ENTRIES },
  signal?: AbortSignal,
): Promise<{ entries: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    // --numeric-owner: owner/group as uid/gid, so names with spaces cannot shift the columns.
    const child = spawn("tar", ["-tvzf", tarPath, "--numeric-owner"], {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let entries = 0;
    let bytes = 0;
    let buffer = "";
    let stderr = "";
    let failure: Error | null = null;

    const handleLine = (line: string) => {
      if (!line || failure) return;
      entries++;
      try {
        bytes += parseListingSize(line);
      } catch (err) {
        failure = err as Error;
      }
      if (!failure && bytes > limits.maxBytes) failure = new CheckoutTooLargeError("압축을 풀면 2GB 초과");
      if (!failure && entries > limits.maxEntries) failure = new CheckoutTooLargeError("파일 20만 개 초과");
      if (failure) child.kill("SIGKILL");
    };

    child.stdout.setEncoding("latin1"); // Byte-preserving; only the size column matters.
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1 && !failure) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (failure) return reject(failure);
      handleLine(buffer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new CheckoutListingError(stderr.trim().slice(0, 300) || `tar exit ${code}`));
      resolve({ entries, bytes });
    });
  });
}

/**
 * Extracts a GitHub tarball (one top-level directory) into a new directory
 * after checking its uncompressed size, then strips symlinks and other
 * non-regular files, and the search-ignore files a PR could use to hide code.
 */
export async function extractTarball(
  tarPath: string,
  destDir: string,
  signal?: AbortSignal,
  limits?: { maxBytes: number; maxEntries: number },
): Promise<void> {
  await inspectTarball(tarPath, limits, signal);
  await fs.mkdir(destDir);
  await execFileP("tar", ["-xzf", tarPath, "-C", destDir, "--strip-components=1", "--no-same-owner"], {
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  await removeNonRegularFiles(destDir);
  await removeSearchIgnoreFiles(destDir);
}

/**
 * ripgrep (Claude's Grep/Glob) honours `.ignore` and `.rgignore` even outside
 * a git repo, so a PR could hide files from deep-mode search with them.
 * `.gitignore` needs a .git directory, which a tarball checkout never has.
 * Returns how many were removed.
 */
export async function removeSearchIgnoreFiles(root: string): Promise<number> {
  const { stdout } = await execFileP(
    "find",
    [root, "-type", "f", "(", "-name", ".ignore", "-o", "-name", ".rgignore", ")", "-printf", ".", "-delete"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.length;
}

async function downloadTarball(url: string, dest: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { headers: await githubHeaders(), redirect: "follow", signal, cache: "no-store" });
  if (!res.ok || !res.body) {
    throw new Error(`레포 압축 파일을 받지 못했습니다 (HTTP ${res.status}).`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel();
    throw new CheckoutTooLargeError();
  }

  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) callback(new CheckoutTooLargeError());
      else callback(null, chunk);
    },
  });
  // pipeline rejects on ENOSPC, abort, or the limiter error, and destroys every stream.
  await pipeline(
    Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>),
    limiter,
    createWriteStream(dest),
    { signal },
  );
}

/**
 * In-use protection, within this process (refcount) and across processes
 * (the dev server, eval runs, the simulate script share the checkout dir).
 * The cross-process lock is a file NEXT TO the checkout, not inside it, so
 * the checkout stays an exact snapshot of the repo: Claude never sees the
 * lock and lookAt validation cannot point at it.
 *   {baseDir}/{owner}__{repo}__{sha}.inuse-{pid}
 */
const inUse = new Map<string, number>();
const LOCK_RE = /^(.+)\.inuse-(\d+)$/;

export function lockFilePath(dir: string, pid = process.pid): string {
  return `${dir}.inuse-${pid}`;
}

function acquire(dir: string) {
  const n = (inUse.get(dir) ?? 0) + 1;
  inUse.set(dir, n);
  if (n === 1) {
    try {
      writeFileSync(lockFilePath(dir), String(process.pid));
    } catch (err) {
      console.error("[pr-lens] 체크아웃 잠금 파일 생성 실패:", err);
    }
  }
}

function release(dir: string) {
  const n = (inUse.get(dir) ?? 0) - 1;
  if (n > 0) {
    inUse.set(dir, n);
    return;
  }
  inUse.delete(dir);
  rmSync(lockFilePath(dir), { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Keeps the newest `keep` checkouts (by mtime). Never removes one in use by
 * this process or locked by another live process; removes stale locks of dead
 * processes and stale temp files.
 */
export async function evictCheckouts(baseDir: string, keep: number): Promise<void> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  const checkouts: Array<{ p: string; mtime: number }> = [];
  const locked = new Set<string>();
  for (const entry of entries) {
    const p = path.join(baseDir, entry.name);
    const lock = LOCK_RE.exec(entry.name);
    if (lock && entry.isFile()) {
      if (processAlive(Number(lock[2]))) locked.add(path.join(baseDir, lock[1]));
      else await fs.rm(p, { force: true }).catch((err) => console.error("[pr-lens] 오래된 잠금 파일 정리 실패:", err));
      continue;
    }
    const st = await fs.lstat(p).catch(() => null);
    if (!st) continue;
    if (entry.name.startsWith(".")) {
      if (now - st.mtimeMs > STALE_TEMP_MS) {
        await fs.rm(p, { recursive: true, force: true }).catch((err) => console.error("[pr-lens] 임시 파일 정리 실패:", err));
      }
      continue;
    }
    if (st.isDirectory()) checkouts.push({ p, mtime: st.mtimeMs });
  }
  checkouts.sort((a, b) => b.mtime - a.mtime);
  for (const { p } of checkouts.slice(keep)) {
    if (inUse.has(p) || locked.has(p)) continue;
    // Re-check right before deleting: another process may have taken it since the scan.
    if ((await hasLiveLock(p)) || inUse.has(p)) continue;
    // Rename first (atomic) so nobody ever opens a half-deleted checkout.
    const trash = path.join(baseDir, `.evict-${path.basename(p)}-${process.pid}-${Date.now()}`);
    try {
      await fs.rename(p, trash);
    } catch {
      continue; // Already gone or renamed by someone else.
    }
    await fs.rm(trash, { recursive: true, force: true }).catch((err) => console.error("[pr-lens] 체크아웃 정리 실패:", err));
  }
}

/** Whether any live process holds `${dir}.inuse-<pid>`. */
async function hasLiveLock(dir: string): Promise<boolean> {
  const prefix = `${path.basename(dir)}.inuse-`;
  const names = await fs.readdir(path.dirname(dir)).catch(() => [] as string[]);
  return names.some((n) => {
    const pid = n.startsWith(prefix) ? n.slice(prefix.length) : "";
    return /^\d+$/.test(pid) && processAlive(Number(pid));
  });
}

async function isDirectory(p: string): Promise<boolean> {
  return (await fs.lstat(p).catch(() => null))?.isDirectory() ?? false;
}

export interface CheckoutOptions {
  signal?: AbortSignal;
  baseDir?: string;
  maxBytes?: number;
  keep?: number;
  extractLimits?: { maxBytes: number; maxEntries: number };
}

export interface CheckoutHandle {
  dir: string;
  /** Call when done reading the checkout so it can be evicted again. */
  release: () => void;
}

/**
 * Downloads and extracts the repo tarball at `sha`, or reuses an existing
 * checkout. Throws CheckoutTooLargeError above the size limits.
 */
export async function ensureCheckout(
  ref: { owner: string; repo: string; headSha: string },
  options: CheckoutOptions = {},
): Promise<CheckoutHandle> {
  const baseDir = options.baseDir ?? defaultReposDir();
  const name = `${ref.owner}__${ref.repo}__${ref.headSha}`;
  const dir = path.join(baseDir, name);
  await fs.mkdir(baseDir, { recursive: true });
  acquire(dir);
  let released = false;
  const handle: CheckoutHandle = {
    dir,
    release: () => {
      if (released) return;
      released = true;
      release(dir);
    },
  };

  try {
    if (await isDirectory(dir)) {
      const now = new Date();
      await fs.utimes(dir, now, now).catch(() => {});
      // Our lock is in place now; if another process evicted the checkout
      // just before it saw the lock, fall through and extract it again.
      if (await isDirectory(dir)) return handle;
    }

    const tag = `${process.pid}-${Date.now()}`;
    const tarPath = path.join(baseDir, `.dl-${name}-${tag}.tar.gz`);
    const tmpDir = path.join(baseDir, `.x-${name}-${tag}`);
    try {
      await downloadTarball(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball/${ref.headSha}`,
        tarPath,
        options.maxBytes ?? MAX_TARBALL_BYTES,
        options.signal,
      );
      await extractTarball(tarPath, tmpDir, options.signal, options.extractLimits);
      try {
        await fs.rename(tmpDir, dir);
      } catch (err) {
        // A concurrent request may have finished the same checkout first.
        if (!(await exists(dir))) throw err;
      }
    } finally {
      await fs.rm(tarPath, { force: true }).catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    handle.release();
    throw err;
  }

  try {
    await evictCheckouts(baseDir, options.keep ?? MAX_CHECKOUTS);
  } catch (err) {
    console.error("[pr-lens] 체크아웃 정리 실패:", err);
  }
  return handle;
}
