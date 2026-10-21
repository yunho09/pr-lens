import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsPromises } from "node:fs";
import {
  CheckoutListingError,
  CheckoutTooLargeError,
  defaultReposDir,
  ensureCheckout,
  evictCheckouts,
  extractTarball,
  inspectTarball,
  lockFilePath,
  parseListingSize,
  removeNonRegularFiles,
} from "./checkout";

const execFileP = promisify(execFile);

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "pr-lens-checkout-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

/** Paths relative to root, byte-safe ("\xff" names come back as escapes), dirs end in "/", links in "@". */
async function listTree(root: string): Promise<string[]> {
  const { stdout } = await execFileP("find", [root, "-mindepth", "1", "-printf", "%P%y\\n"], { encoding: "buffer" });
  return stdout
    .toString("latin1")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const type = line.slice(-1);
      const rel = line.slice(0, -1);
      const escaped = Array.from(rel, (c) => (c.charCodeAt(0) > 127 ? `\\x${c.charCodeAt(0).toString(16)}` : c)).join("");
      return type === "d" ? `${escaped}/` : type === "f" ? escaped : `${escaped}@${type}`;
    })
    .sort();
}

const bytesPath = (...parts: Array<string | number[] | Buffer>) =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : typeof p === "string" ? Buffer.from(p) : Buffer.from(p))));

describe("removeNonRegularFiles", () => {
  it("deletes symlinks (to files and dirs, inside and outside) and fifos, keeps regular files", async () => {
    const root = path.join(tmp, "repo");
    await mkdir(path.join(root, "src/nested"), { recursive: true });
    await writeFile(path.join(root, "src/a.ts"), "a");
    await writeFile(path.join(root, "src/nested/b.ts"), "b");
    await symlink("/etc/hostname", path.join(root, "src/host.ts"));
    await symlink(os.homedir(), path.join(root, "home"));
    await symlink("a.ts", path.join(root, "src/rel-link.ts"));
    await execFileP("mkfifo", [path.join(root, "src/pipe")]);

    const removed = await removeNonRegularFiles(root);

    expect(removed).toBe(4);
    expect(await listTree(root)).toEqual(["src/", "src/a.ts", "src/nested/", "src/nested/b.ts"]);
    // The link target outside the tree is untouched.
    expect((await lstat("/etc/hostname")).isFile()).toBe(true);
  });

  it("handles names that are not valid UTF-8", async () => {
    const root = path.join(tmp, "repo");
    const latin1Dir = bytesPath(root, "/caf", [0xe9]);
    await mkdir(latin1Dir, { recursive: true });
    await writeFile(bytesPath(latin1Dir, "/keep.txt"), "k");
    await symlink("/etc/hostname", bytesPath(latin1Dir, "/", [0xff]));
    await symlink("/etc", bytesPath(root, "/", [0xff, 0xfe], "dir"));

    expect(await removeNonRegularFiles(root)).toBe(2);
    expect(await listTree(root)).toEqual(["caf\\xe9/", "caf\\xe9/keep.txt"]);
  });
});

describe("inspectTarball / extractTarball", () => {
  async function makeTarball(build: (top: string) => Promise<void>): Promise<string> {
    const top = path.join(tmp, "src", "owner-repo-abc123");
    await mkdir(top, { recursive: true });
    await build(top);
    const tarPath = path.join(tmp, "repo.tar.gz");
    await execFileP("tar", ["-czf", tarPath, "-C", path.join(tmp, "src"), "owner-repo-abc123"]);
    return tarPath;
  }

  it("strips the top-level directory and removes planted symlinks after extraction", async () => {
    const tarPath = await makeTarball(async (top) => {
      await mkdir(path.join(top, "lib"));
      await writeFile(path.join(top, "lib/index.ts"), "export {};\n");
      await symlink("/etc/hostname", path.join(top, "lib/secret.ts"));
      await symlink("../../../../../../etc", path.join(top, "etc-dir"));
    });

    const dest = path.join(tmp, "out");
    await extractTarball(tarPath, dest);

    expect(await listTree(dest)).toEqual(["lib/", "lib/index.ts"]);
    expect(await readFile(path.join(dest, "lib/index.ts"), "utf8")).toBe("export {};\n");
  });

  it("extracts a crafted tarball with a \\xff symlink and a Latin-1 directory without crashing", async () => {
    const tarPath = await makeTarball(async (top) => {
      const dir = bytesPath(top, "/r", [0xe9], "sum", [0xe9]);
      await mkdir(dir);
      await writeFile(bytesPath(dir, "/doc.md"), "d");
      await symlink("/etc/hostname", bytesPath(top, "/", [0xff]));
      await symlink(os.homedir(), bytesPath(dir, "/", [0xff], "home"));
    });

    const dest = path.join(tmp, "out");
    await extractTarball(tarPath, dest);

    expect(await listTree(dest)).toEqual(["r\\xe9sum\\xe9/", "r\\xe9sum\\xe9/doc.md"]);
  });

  it("measures uncompressed size and entry count without extracting", async () => {
    const tarPath = await makeTarball(async (top) => {
      await writeFile(path.join(top, "a.bin"), Buffer.alloc(5000));
      await writeFile(path.join(top, "b.bin"), Buffer.alloc(3000));
    });
    const info = await inspectTarball(tarPath, { maxBytes: 1e9, maxEntries: 100 });
    expect(info.bytes).toBe(8000);
    expect(info.entries).toBe(3); // top dir + 2 files
  });

  it("rejects decompression bombs by size and by entry count before extracting anything", async () => {
    // 50 MB of zeros compresses to ~50 KB.
    const tarPath = await makeTarball(async (top) => {
      await writeFile(path.join(top, "zeros.bin"), Buffer.alloc(50 * 1024 * 1024));
      for (let i = 0; i < 30; i++) await writeFile(path.join(top, `f${i}`), "");
    });

    const dest = path.join(tmp, "out");
    await expect(extractTarball(tarPath, dest, undefined, { maxBytes: 10 * 1024 * 1024, maxEntries: 1000 })).rejects.toThrow(
      /2GB 초과/,
    );
    await expect(extractTarball(tarPath, dest, undefined, { maxBytes: 1e12, maxEntries: 10 })).rejects.toBeInstanceOf(
      CheckoutTooLargeError,
    );
    await expect(lstat(dest)).rejects.toThrow(); // nothing extracted
  });
});

describe("tar listing parse fails closed", () => {
  it("reads the size column of a numeric-owner listing", () => {
    expect(parseListingSize("-rw-r--r-- 1000/1000      1234 2026-10-21 01:00 dir/a b.txt")).toBe(1234);
    expect(parseListingSize("drwxr-xr-x 0/0 0 2026-10-21 01:00 dir/")).toBe(0);
  });

  it.each([
    "-rw-r--r-- John Doe/staff 1234 2026-10-21 01:00 a.txt", // owner name with a space shifts the columns
    "brw-rw---- 0/6 8,0 2026-10-21 01:00 dev/sda", // device "major,minor"
    "-rw-r--r-- 0/0 -5 2026-10-21 01:00 neg",
    "garbage",
  ])("rejects %j with a listing error (not 'too large')", (line) => {
    expect(() => parseListingSize(line)).toThrow(CheckoutListingError);
    expect(() => parseListingSize(line)).toThrow(/레포 목록을 확인할 수 없음/);
  });

  it("reports an unreadable archive as a listing error", async () => {
    const bogus = path.join(tmp, "bogus.tar.gz");
    await writeFile(bogus, "this is not a tarball");
    await expect(inspectTarball(bogus)).rejects.toBeInstanceOf(CheckoutListingError);
  });

  it("counts sizes correctly for an archive whose owner and group names contain spaces", async () => {
    const top = path.join(tmp, "src", "owner-repo-abc123");
    await mkdir(top, { recursive: true });
    await writeFile(path.join(top, "a.bin"), Buffer.alloc(4096));
    const tarPath = path.join(tmp, "spaced.tar.gz");
    await execFileP("tar", [
      "-czf",
      tarPath,
      "--owner=John Doe:1234",
      "--group=Some Group:5678",
      "-C",
      path.join(tmp, "src"),
      "owner-repo-abc123",
    ]);
    // Without --numeric-owner the size column would be "Doe/Some" and silently count as 0.
    const { stdout } = await execFileP("tar", ["-tvzf", tarPath]);
    expect(stdout).toContain("John Doe/Some Group");
    expect(await inspectTarball(tarPath, { maxBytes: 4095, maxEntries: 100 }).catch((e) => e)).toBeInstanceOf(
      CheckoutTooLargeError,
    );
    expect(await inspectTarball(tarPath, { maxBytes: 1e9, maxEntries: 100 })).toEqual({ entries: 2, bytes: 4096 });
  });
});

describe("evictCheckouts", () => {
  it("keeps the newest N checkouts by mtime and never one that is in use", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const base = path.join(tmp, "repos");
    const names = ["o__r__1", "o__r__2", "o__r__3", "o__r__4"];
    for (const [i, n] of names.entries()) {
      await mkdir(path.join(base, n), { recursive: true });
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      await utimes(path.join(base, n), t, t);
    }
    // Mark the oldest as in use (reuse path, no download), then put its mtime back.
    const handle = await ensureCheckout({ owner: "o", repo: "r", headSha: "1" }, { baseDir: base });
    await utimes(handle.dir, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));

    await evictCheckouts(base, 2);
    expect((await readdir(base)).sort()).toEqual(["o__r__1", `o__r__1.inuse-${process.pid}`, "o__r__3", "o__r__4"]);

    handle.release();
    await evictCheckouts(base, 2);
    expect((await readdir(base)).sort()).toEqual(["o__r__3", "o__r__4"]);
  });
});

describe("defaultReposDir", () => {
  it("lives outside the project, under XDG_CACHE_HOME or ~/.cache", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/var/tmp/xdg");
    expect(defaultReposDir()).toBe("/var/tmp/xdg/pr-lens/repos");
    vi.stubEnv("XDG_CACHE_HOME", "relative/ignored");
    expect(defaultReposDir()).toBe(path.join(os.homedir(), ".cache", "pr-lens", "repos"));
    expect(defaultReposDir().startsWith(process.cwd())).toBe(false);
  });
});

describe("ensureCheckout", () => {
  const ref = { owner: "o", repo: "r", headSha: "a".repeat(40) };

  it("reuses an existing checkout without downloading", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const dir = path.join(tmp, `o__r__${ref.headSha}`);
    await mkdir(dir);
    const handle = await ensureCheckout(ref, { baseDir: tmp });
    expect(handle.dir).toBe(dir);
    expect(fetchSpy).not.toHaveBeenCalled();
    handle.release();
  });

  it("aborts above the download limit (streamed or declared) and leaves nothing behind", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(64)));
    await expect(ensureCheckout(ref, { baseDir: tmp, maxBytes: 16 })).rejects.toBeInstanceOf(CheckoutTooLargeError);

    vi.stubGlobal("fetch", async () => new Response("x", { headers: { "content-length": "999999" } }));
    await expect(ensureCheckout(ref, { baseDir: tmp, maxBytes: 16 })).rejects.toBeInstanceOf(CheckoutTooLargeError);

    expect(await readdir(tmp)).toEqual([]);
  });

  it("rejects (does not hang) when the request is aborted mid-download", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(10));
              // Never closes: only the abort can end this download.
            },
          }),
        ),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(ensureCheckout(ref, { baseDir: tmp, signal: controller.signal })).rejects.toThrow();
    expect(await readdir(tmp)).toEqual([]);
  });

  it("downloads, extracts and sanitizes a tarball into the final directory", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const src = path.join(tmp, "build", "o-r-aaaaaaa");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "a.ts"), "a\n");
    await symlink("/etc/hostname", path.join(src, "evil.ts"));
    const tarPath = path.join(tmp, "build.tar.gz");
    await execFileP("tar", ["-czf", tarPath, "-C", path.join(tmp, "build"), "o-r-aaaaaaa"]);
    const bytes = await readFile(tarPath);
    let requested = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requested = url;
      return new Response(bytes);
    });

    const base = path.join(tmp, "repos");
    const handle = await ensureCheckout(ref, { baseDir: base });

    expect(requested).toBe(`https://api.github.com/repos/o/r/tarball/${ref.headSha}`);
    expect(handle.dir).toBe(path.join(base, `o__r__${ref.headSha}`));
    expect(await listTree(handle.dir)).toEqual(["a.ts"]);
    // Temp files cleaned up; only the checkout and this process's in-use lock remain.
    expect((await readdir(base)).sort()).toEqual([`o__r__${ref.headSha}`, `o__r__${ref.headSha}.inuse-${process.pid}`]);
    handle.release();
    expect(await readdir(base)).toEqual([`o__r__${ref.headSha}`]);
  });
});

describe("cross-process in-use locks", () => {
  async function makeCheckouts(base: string, names: string[]) {
    for (const [i, n] of names.entries()) {
      await mkdir(path.join(base, n), { recursive: true });
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      await utimes(path.join(base, n), t, t);
    }
  }

  it("writes a lock next to the checkout (not inside it) while acquired and removes it on release", async () => {
    const base = path.join(tmp, "repos");
    await mkdir(path.join(base, "o__r__x"), { recursive: true });
    const handle = await ensureCheckout({ owner: "o", repo: "r", headSha: "x" }, { baseDir: base });
    expect(await readdir(base)).toEqual(["o__r__x", `o__r__x.inuse-${process.pid}`]);
    expect(await readdir(handle.dir)).toEqual([]); // the checkout itself is untouched
    expect(lockFilePath(handle.dir)).toBe(path.join(base, `o__r__x.inuse-${process.pid}`));
    handle.release();
    expect(await readdir(base)).toEqual(["o__r__x"]);
  });

  it("does not evict a checkout locked by another live process, and clears locks of dead ones", async () => {
    const base = path.join(tmp, "repos");
    await makeCheckouts(base, ["o__r__1", "o__r__2", "o__r__3", "o__r__4"]);

    const other = spawn("sleep", ["30"]);
    const dead = spawn("true");
    await new Promise((r) => dead.on("exit", r));
    try {
      await writeFile(path.join(base, `o__r__1.inuse-${other.pid}`), "");
      await writeFile(path.join(base, `o__r__2.inuse-${dead.pid}`), "");

      await evictCheckouts(base, 1);

      // 1 is locked by a live process; 2 had only a stale lock; 3 is older than the kept newest (4).
      expect((await readdir(base)).sort()).toEqual(["o__r__1", `o__r__1.inuse-${other.pid}`, "o__r__4"]);
    } finally {
      other.kill();
    }
  });
});

describe("eviction and acquire races", () => {
  it("re-checks for a live lock right before deleting (lock taken after the scan)", async () => {
    const base = path.join(tmp, "repos");
    for (const [i, n] of ["o__r__1", "o__r__2"].entries()) {
      await mkdir(path.join(base, n), { recursive: true });
      await utimes(path.join(base, n), new Date(Date.UTC(2026, 0, 1 + i)), new Date(Date.UTC(2026, 0, 1 + i)));
    }
    const other = spawn("sleep", ["30"]);
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    let calls = 0;
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation((async (...args: Parameters<typeof realReaddir>) => {
      calls++;
      // The scan is the first readdir; another process locks o__r__1 right after it.
      if (calls === 2) await writeFile(path.join(base, `o__r__1.inuse-${other.pid}`), "");
      return realReaddir(...args);
    }) as typeof fsPromises.readdir);
    try {
      await evictCheckouts(base, 1);
      expect((await realReaddir(base)).sort()).toEqual(["o__r__1", `o__r__1.inuse-${other.pid}`, "o__r__2"]);
    } finally {
      spy.mockRestore();
      other.kill();
    }
  });

  it("extracts again when the checkout is evicted between the existence check and use", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const ref = { owner: "o", repo: "r", headSha: "c".repeat(40) };
    const base = path.join(tmp, "repos");
    const dir = path.join(base, `o__r__${ref.headSha}`);
    await mkdir(dir, { recursive: true }); // looks reusable...

    const src = path.join(tmp, "build", "o-r-ccc");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "fresh.ts"), "x\n");
    const tarPath = path.join(tmp, "fresh.tar.gz");
    await execFileP("tar", ["-czf", tarPath, "-C", path.join(tmp, "build"), "o-r-ccc"]);
    const bytes = await readFile(tarPath);
    let downloads = 0;
    vi.stubGlobal("fetch", async () => {
      downloads++;
      return new Response(bytes);
    });
    // ...but another process evicts it right after our first check.
    const spy = vi.spyOn(fsPromises, "utimes").mockImplementation(async (p) => {
      await rm(p as string, { recursive: true, force: true });
    });
    try {
      const handle = await ensureCheckout(ref, { baseDir: base });
      expect(downloads).toBe(1);
      expect(await listTree(handle.dir)).toEqual(["fresh.ts"]);
      handle.release();
    } finally {
      spy.mockRestore();
    }
  });
});
