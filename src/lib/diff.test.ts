import { describe, expect, it } from "vitest";
import { hunkSideRange, parsePatch } from "./diff";

const multiHunk = [
  "@@ -1,4 +1,5 @@ import things",
  " import a from 'a';",
  "-import b from 'b';",
  "+import b from 'bee';",
  "+import c from 'c';",
  " ",
  " export {};",
  "@@ -40,6 +41,4 @@ function main() {",
  "   const x = 1;",
  "-  const y = 2;",
  "-  const z = 3;",
  "+  const yz = 5;",
  "   return x;",
  " }",
  "-// end",
].join("\n");

describe("parsePatch", () => {
  it("splits hunks and assigns stable ids", () => {
    const hunks = parsePatch(multiHunk, 3);
    expect(hunks.map((h) => h.id)).toEqual(["f3h0", "f3h1"]);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, section: "import things" });
    expect(hunks[1]).toMatchObject({ oldStart: 40, oldLines: 6, newStart: 41, newLines: 4, section: "function main() {" });
    expect(hunks[1].header).toBe("@@ -40,6 +41,4 @@ function main() {");
  });

  it("numbers old and new lines independently", () => {
    const [first, second] = parsePatch(multiHunk, 0);
    expect(first.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
    expect(second.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ["context", 40, 41],
      ["del", 41, null],
      ["del", 42, null],
      ["add", null, 42],
      ["context", 43, 43],
      ["context", 44, 44],
      ["del", 45, null],
    ]);
    expect(second.lines[1].content).toBe("  const y = 2;");
  });

  it("treats a context line whose leading space was stripped as context", () => {
    const [hunk] = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c", 0);
    expect(hunk.lines[1]).toEqual({ type: "context", content: "", oldLine: 2, newLine: 2 });
  });

  it("marks lines followed by '\\ No newline at end of file' without adding a line", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old last",
      "\\ No newline at end of file",
      "+new last",
      "\\ No newline at end of file",
    ].join("\n");
    const [hunk] = parsePatch(patch, 0);
    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines[1]).toMatchObject({ type: "del", content: "old last", oldLine: 2, noNewline: true });
    expect(hunk.lines[2]).toMatchObject({ type: "add", content: "new last", newLine: 2, noNewline: true });
    expect(hunk.lines[0].noNewline).toBeUndefined();
  });

  it("defaults omitted hunk lengths to 1 and handles new files", () => {
    const [hunk] = parsePatch("@@ -0,0 +1 @@\n+only line", 0);
    expect(hunk).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: "" });
    expect(hunk.lines).toEqual([{ type: "add", content: "only line", oldLine: null, newLine: 1 }]);
  });

  it("ignores a trailing newline and CRLF endings", () => {
    const [hunk] = parsePatch("@@ -1 +1 @@\r\n-a\r\n+b\r\n", 0);
    expect(hunk.lines.map((l) => l.content)).toEqual(["a", "b"]);
  });

  it("returns no hunks for an empty patch", () => {
    expect(parsePatch("", 0)).toEqual([]);
  });

  it("keeps a line's CR as a flag (not in the content) so a CR-only change stays visible", () => {
    const [hunk] = parsePatch("@@ -1,2 +1,2 @@\n-EOF\n+EOF\r\n x", 0);
    expect(hunk.lines.map((l) => [l.content, l.cr === true])).toEqual([
      ["EOF", false],
      ["EOF", true],
      ["x", false],
    ]);
  });

  // The reviewer's realpatch repro: git puts the enclosing function line after @@,
  // and that text may contain line terminators other than \n.
  it.each([
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["a CR", "\r"],
  ])("parses a hunk header whose section text contains %s", (_name, ch) => {
    const patch = `@@ -10,3 +10,3 @@ function x() { // a${ch}b\n ctx\n-checkAuth(user);\n+// checkAuth(user);\n ctx`;
    const hunks = parsePatch(patch, 0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.filter((l) => l.type !== "context").map((l) => l.content)).toEqual([
      "checkAuth(user);",
      "// checkAuth(user);",
    ]);
  });

  it("fails closed with no hunks on an @@ line it cannot parse, or text before the first hunk", () => {
    expect(parsePatch("@@ -1 +1 @@\n-a\n+b\n@@ -x +y @@\n-c\n+d", 0)).toEqual([]);
    expect(parsePatch("garbage\n@@ -1 +1 @@\n-a\n+b", 0)).toEqual([]);
  });
});

describe("hunkSideRange", () => {
  it("reports the real line range per side", () => {
    const [, second] = parsePatch(multiHunk, 0);
    expect(hunkSideRange(second, "old")).toEqual([40, 45]);
    expect(hunkSideRange(second, "new")).toEqual([41, 44]);
  });

  it("returns null for a side with no lines", () => {
    const [hunk] = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b", 0);
    expect(hunkSideRange(hunk, "old")).toBeNull();
  });
});
