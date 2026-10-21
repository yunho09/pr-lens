import { describe, expect, it } from "vitest";
import { ghFile, makePr } from "@/test/fixtures";
import { parsePatch } from "@/lib/diff";
import {
  cleanPrBody,
  extractRefs,
  isFixPr,
  isRevertPr,
  isTrivialLine,
  labelCase,
  removedLineIndex,
  type FixFile,
} from "./szz";

const fix = (filename: string, patch: string, previousFilename?: string): FixFile => ({
  filename,
  previousFilename,
  hunks: parsePatch(patch, 0),
});

/** One hunk per `+` line, so each line is its own hunk in B. */
const hunks = (...added: string[]) => added.map((a, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n ctx\n+${a}`).join("\n");

const BUG = "if (retries > maxRetries) return cached;";

describe("isTrivialLine", () => {
  it.each([
    "}",
    "});",
    "  ]),",
    "short",
    'import { useState } from "react";',
    "import * as path from 'node:path';",
    'import "./styles.css";',
    'export { foo, bar } from "./foo";',
    'export * from "./types";',
    "export type { Foo } from './foo';",
    "export default SomeComponent;",
    '} from "./multi-line";',
    "from os.path import join",
    'const fs = require("node:fs");',
    "useCallback,",
    "// explains the next line",
    "* @param value the value",
    "# python comment here",
  ])("treats %j as trivial", (line) => {
    expect(isTrivialLine(line.trim())).toBe(true);
  });

  it.each([BUG, "export const timeout = 5000;", "return items.filter(Boolean);", "export default function App() {"])(
    "keeps %j",
    (line) => {
      expect(isTrivialLine(line)).toBe(false);
    },
  );
});

describe("isFixPr / isRevertPr", () => {
  it("matches fix keywords in the title or body", () => {
    expect(isFixPr("fix(core): handle empty list", "")).toBe(true);
    expect(isFixPr("Hotfix for login", "")).toBe(true);
    expect(isFixPr("Update deps", "This addresses a regression from #12")).toBe(true);
    expect(isFixPr("Bugfix: x", "")).toBe(true);
  });

  it("ignores fixtures, debug, and unchecked template boxes", () => {
    expect(isFixPr("Add test fixtures", "")).toBe(false);
    expect(isFixPr("Improve debug output", "")).toBe(false);
    expect(isFixPr("Remove FIXME comments", "")).toBe(false);
    expect(isFixPr("Tidy up", "Resolves the old fixme in the parser.")).toBe(false);
    expect(isFixPr("fix: remove FIXME workaround", "")).toBe(true);
    expect(isFixPr("Add feature", "- [ ] Bug fix\n- [x] New feature\n<!-- describe the bug -->")).toBe(false);
    expect(isFixPr("Add feature", "- [x] Bug fix")).toBe(true);
    expect(cleanPrBody("a\n- [ ] Bug fix\n<!-- bug -->b")).toBe("a\nb");
  });

  it("detects reverts by title or GitHub's revert body", () => {
    expect(isRevertPr('Revert "feat: add cache"', "")).toBe(true);
    expect(isRevertPr("fix: crash", "Reverts acme/app#12")).toBe(true);
    expect(isRevertPr("fix: crash", "This reverts commit abc1234def.")).toBe(true);
    expect(isRevertPr("fix: revert-safe parsing", "Fixes #12")).toBe(false);
  });
});

describe("extractRefs", () => {
  it("finds same-repo #N, owner/repo#N, and PR URLs in order, without self or other repos", () => {
    const text = [
      "Fixes a regression from #12 (see also acme/app#34).",
      "Original: https://github.com/acme/app/pull/56#discussion_r1 and https://github.com/ACME/App/issues/78",
      "Unrelated: other/repo#90, https://github.com/other/repo/pull/91, line anchor #L10, #99 is me",
      "Dupe #12",
    ].join("\n");
    expect(extractRefs(text, "acme", "app", 99)).toEqual([12, 34, 56, 78]);
  });

  it("does not read numbers glued to words or paths", () => {
    expect(extractRefs("PR#5 a/b/c#6 x.y#7", "acme", "app", 1)).toEqual([]);
  });
});

describe("removedLineIndex", () => {
  it("indexes trimmed non-trivial removed lines under the new and the old name of a renamed file", () => {
    const index = removedLineIndex([
      fix("src/new.ts", `@@ -1,3 +1,2 @@\n-    ${BUG}\n-}\n+const ok = true;`, "src/old.ts"),
    ]);
    expect([...(index.get("src/new.ts") ?? [])]).toEqual([BUG]);
    expect([...(index.get("src/old.ts") ?? [])]).toEqual([BUG]);
  });
});

describe("labelCase", () => {
  const removed = (path: string, ...lines: string[]) =>
    removedLineIndex([fix(path, `@@ -1,${lines.length} +1,0 @@\n${lines.map((l) => `-${l}`).join("\n")}`)]);

  it("labels B's hunks that added a line the fix removed on the same path (ignoring indentation)", () => {
    const pr = makePr([ghFile("src/a.ts", hunks(`  ${BUG}`, "const other = computeSomething();"))]);
    const verdict = labelCase(pr.files, removed("src/a.ts", BUG));
    expect(verdict.ok).toBe(true);
    expect(verdict.buggy).toHaveLength(1);
    expect(verdict.buggy[0]).toMatchObject({ path: "src/a.ts", sample: BUG, kept: true });
    expect(verdict.buggy[0].fingerprint).toBe(pr.files[0].hunks[0].fingerprint);
    expect(verdict.keptHunks).toBe(2);
  });

  it("does not match the same line on another path", () => {
    const pr = makePr([ghFile("src/a.ts", hunks(BUG, "const other = computeSomething();"))]);
    expect(labelCase(pr.files, removed("src/b.ts", BUG))).toMatchObject({ ok: false, reason: "no-match" });
  });

  it("follows a rename done by the fix", () => {
    const pr = makePr([ghFile("src/old.ts", hunks(BUG, "const other = computeSomething();"))]);
    const index = removedLineIndex([fix("src/new.ts", `@@ -1,1 +1,0 @@\n-${BUG}`, "src/old.ts")]);
    expect(labelCase(pr.files, index).ok).toBe(true);
  });

  it("ignores trivial lines even when they match", () => {
    const pr = makePr([ghFile("src/a.ts", hunks('import { x } from "./x";', "const other = computeSomething();"))]);
    expect(labelCase(pr.files, removed("src/a.ts", 'import { x } from "./x";'))).toMatchObject({
      ok: false,
      reason: "no-match",
    });
  });

  it("applies the 50% rule over kept hunks", () => {
    const lines = ["const a = alpha(1);", "const b = bravo(2);", "const c = charlie(3);", "const d = delta(4);"];
    const pr = makePr([ghFile("src/a.ts", hunks(...lines))]);
    expect(labelCase(pr.files, removed("src/a.ts", lines[0], lines[1]))).toMatchObject({ ok: true, keptHunks: 4 });
    expect(labelCase(pr.files, removed("src/a.ts", lines[0], lines[1], lines[2]))).toMatchObject({
      ok: false,
      reason: "too-many",
    });
    const single = makePr([ghFile("src/a.ts", hunks(lines[0]))]);
    expect(labelCase(single.files, removed("src/a.ts", lines[0]))).toMatchObject({ ok: false, reason: "too-many" });
  });

  it("does not label build output (it reaches Claude, so it counts as kept) and needs a labeled hunk", () => {
    const pr = makePr([
      ghFile("dist/index.js", hunks(BUG)),
      ghFile("src/a.ts", hunks("const a = alpha(1);", "const b = bravo(2);")),
    ]);
    const index = removedLineIndex([fix("dist/index.js", `@@ -1,1 +1,0 @@\n-${BUG}`)]);
    expect(labelCase(pr.files, index)).toMatchObject({ ok: false, reason: "no-match", keptHunks: 3 });
  });

  it("labels source and config files only, but counts tests and docs as kept hunks", () => {
    const pr = makePr([
      ghFile("src/a.test.ts", hunks(BUG)),
      ghFile(".changeset/brave-cats.md", hunks("'@acme/core': patch")),
      ghFile("src/a.ts", hunks("const a = alpha(1);", "const b = bravo(2);")),
    ]);
    const index = new Map([...removed("src/a.test.ts", BUG), ...removed(".changeset/brave-cats.md", "'@acme/core': patch")]);
    expect(labelCase(pr.files, index)).toMatchObject({ ok: false, reason: "no-match", keptHunks: 4 });
    const config = makePr([ghFile("package.json", hunks('"exports": "./dist/index.js",', '"main": "./dist/index.cjs",'))]);
    expect(labelCase(config.files, removed("package.json", '"exports": "./dist/index.js",')).ok).toBe(true);
  });

  it("labels a line-end-only hunk as kept: it is sent to Claude now, not filtered", () => {
    const pr = makePr([
      ghFile("src/fmt.ts", `@@ -1,1 +1,1 @@\n-${BUG}   \n+${BUG}`),
      ghFile("src/a.ts", hunks("const a = alpha(1);", "const b = bravo(2);")),
      ghFile("src/b.ts", hunks("const c = charlie(3);")),
    ]);
    expect(pr.files[0].classification).toEqual({ kind: "keep" });
    expect(pr.files[0].hunks[0].lineEndOnly).toBe(true);
    const verdict = labelCase(pr.files, removed("src/fmt.ts", BUG));
    expect(verdict.ok).toBe(true);
    expect(verdict.buggy.map((b) => [b.path, b.kept])).toEqual([["src/fmt.ts", true]]);
  });
});
