import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRepoFiles, normalizeRelPath, validateLookAt, type LookAtContext } from "./lookat";

const hunk = { path: "src/a.ts", newStart: 10, newEnd: 20 };

describe("normalizeRelPath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["  src/a.ts ", "src/a.ts"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeRelPath(input)).toBe(expected);
  });

  it.each(["/etc/passwd", "~/.ssh/id_rsa", "../secret", "src/../../x", "src/./a.ts", "src//a.ts", "C:/x", "a\\b", "", "a\0b"])(
    "rejects %j",
    (input) => {
      expect(normalizeRelPath(input)).toBeNull();
    },
  );
});

describe("validateLookAt", () => {
  const deep: LookAtContext = {
    files: new Map<string, number | null>([
      ["src/a.ts", 100],
      ["src/b.ts", 30],
      ["test/b.test.ts", 50],
      ["src/c.ts", 5],
    ]),
  };

  it("drops absolute paths, `..`, and files missing from the context", () => {
    const out = validateLookAt(
      [
        { path: "/etc/passwd", line: 1, reason: "x" },
        { path: "../outside.ts", line: 1, reason: "x" },
        { path: "src/missing.ts", line: 1, reason: "x" },
        { path: "src/b.ts", line: 3, reason: "호출하는 곳" },
      ],
      deep,
      hunk,
    );
    expect(out).toEqual([{ path: "src/b.ts", line: 3, reason: "호출하는 곳" }]);
  });

  it("clamps lines to the file length and negatives to 0", () => {
    const out = validateLookAt(
      [
        { path: "src/b.ts", line: 999, reason: "끝" },
        { path: "test/b.test.ts", line: -4, reason: "테스트" },
      ],
      deep,
      hunk,
    );
    expect(out).toEqual([
      { path: "src/b.ts", line: 30, reason: "끝" },
      { path: "test/b.test.ts", line: 0, reason: "테스트" },
    ]);
  });

  it("drops entries inside the hunk itself, but keeps other lines of the same file", () => {
    const out = validateLookAt(
      [
        { path: "src/a.ts", line: 15, reason: "same hunk" },
        { path: "src/a.ts", line: 60, reason: "정의" },
      ],
      deep,
      hunk,
    );
    expect(out).toEqual([{ path: "src/a.ts", line: 60, reason: "정의" }]);
  });

  it("dedupes and keeps at most three", () => {
    const out = validateLookAt(
      [
        { path: "src/b.ts", line: 1, reason: "1" },
        { path: "./src/b.ts", line: 1, reason: "dup" },
        { path: "src/c.ts", line: 2, reason: "2" },
        { path: "test/b.test.ts", line: 3, reason: "3" },
        { path: "src/a.ts", line: 90, reason: "4" },
      ],
      deep,
      hunk,
    );
    expect(out.map((e) => e.reason)).toEqual(["1", "2", "3"]);
  });

  it("fast mode: only PR files, no clamping", () => {
    const fast: LookAtContext = { files: new Map([["src/b.ts", null]]) };
    const out = validateLookAt(
      [
        { path: "src/b.ts", line: 5000, reason: "pr file" },
        { path: "src/not-in-pr.ts", line: 1, reason: "x" },
      ],
      fast,
      hunk,
    );
    expect(out).toEqual([{ path: "src/b.ts", line: 5000, reason: "pr file" }]);
  });
});

describe("collectRepoFiles", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pr-lens-lookat-"));
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src/a.ts"), "1\n2\n3\n");
    await writeFile(path.join(dir, "src/b.ts"), "1\n2");
    await writeFile(path.join(dir, "empty.ts"), "");
    await symlink("/etc/hostname", path.join(dir, "link.ts"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns line counts for regular files inside the repo only", async () => {
    const files = await collectRepoFiles(dir, ["src/a.ts", "./src/b.ts", "empty.ts", "link.ts", "missing.ts", "../x", "/etc/hostname"]);
    expect(Object.fromEntries(files)).toEqual({ "src/a.ts": 3, "src/b.ts": 2, "empty.ts": 0 });
  });
});
