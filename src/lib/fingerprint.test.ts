import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";
import { hunkAnchorKey, hunkFingerprint } from "./fingerprint";

const fp = (path: string, patch: string) => hunkFingerprint(path, parsePatch(patch, 0)[0]);

describe("hunkFingerprint", () => {
  const base = "@@ -10,3 +10,3 @@ fn\n ctx\n-old line\n+new line\n tail";

  it("is stable when the hunk only moves (line numbers, header, hunk index)", () => {
    const moved = "@@ -110,3 +125,3 @@ other\n ctx\n-old line\n+new line\n tail";
    expect(fp("src/a.ts", moved)).toBe(fp("src/a.ts", base));
    expect(hunkFingerprint("src/a.ts", parsePatch(base, 7)[0])).toBe(fp("src/a.ts", base));
  });

  it("ignores context lines", () => {
    const otherContext = "@@ -10,3 +10,3 @@ fn\n something else\n-old line\n+new line\n another";
    expect(fp("src/a.ts", otherContext)).toBe(fp("src/a.ts", base));
  });

  it("changes when a changed line changes, including whitespace", () => {
    expect(fp("src/a.ts", base.replace("+new line", "+new line!"))).not.toBe(fp("src/a.ts", base));
    expect(fp("src/a.ts", base.replace("+new line", "+new  line"))).not.toBe(fp("src/a.ts", base));
  });

  it("distinguishes added from removed and depends on the path", () => {
    const flipped = "@@ -10,3 +10,3 @@ fn\n ctx\n+old line\n-new line\n tail";
    expect(fp("src/a.ts", flipped)).not.toBe(fp("src/a.ts", base));
    expect(fp("src/b.ts", base)).not.toBe(fp("src/a.ts", base));
  });

  it("is a 40-char sha1 hex", () => {
    expect(fp("src/a.ts", base)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("hunkAnchorKey", () => {
  const key = (path: string, patch: string) => hunkAnchorKey(path, parsePatch(patch, 0)[0]);
  const base = "@@ -10,5 +10,4 @@ function legacyHandler(req) {\n   const t = req.token;\n-  verify(t);\n   return ok();\n }";

  it("is stable when the hunk only moves (line numbers and hunk index)", () => {
    expect(key("src/a.js", base.replace("@@ -10,5 +10,4 @@", "@@ -110,5 +125,4 @@"))).toBe(key("src/a.js", base));
    expect(hunkAnchorKey("src/a.js", parsePatch(base, 7)[0])).toBe(key("src/a.js", base));
  });

  it("changes when the same edit sits in another function or next to other code", () => {
    // The reviewer's relocate case: identical lines, different enclosing function.
    const relocated = base.replace("function legacyHandler(req) {", "export function handler(req) {");
    expect(hunkFingerprint("src/a.js", parsePatch(relocated, 0)[0])).toBe(hunkFingerprint("src/a.js", parsePatch(base, 0)[0]));
    expect(key("src/a.js", relocated)).not.toBe(key("src/a.js", base));
    expect(key("src/a.js", base.replace("const t = req.token;", "const t = req.session;"))).not.toBe(key("src/a.js", base));
    expect(key("src/b.js", base)).not.toBe(key("src/a.js", base));
  });

  it("only looks at 3 context lines around the change", () => {
    const far = "@@ -1,9 +1,8 @@ fn\n far1\n far2\n c1\n c2\n c3\n-x\n d1\n d2\n d3";
    expect(key("a.ts", far.replace("far1", "other"))).toBe(key("a.ts", far));
    expect(key("a.ts", far.replace("c1", "other"))).not.toBe(key("a.ts", far));
  });

  it("counts a CR or a missing final newline as part of the change (never inherited)", () => {
    // The reviewer's case: `cd /tmp/build` → `cd /tmp/build\r` between pushes.
    const lf = "@@ -1,2 +1,2 @@ sh\n-cd /tmp/old\n+cd /tmp/build\n make";
    expect(key("x.sh", lf.replace("+cd /tmp/build", "+cd /tmp/build\r"))).not.toBe(key("x.sh", lf));
    expect(key("x.sh", lf.replace(/\n/g, "\r\n"))).not.toBe(key("x.sh", lf));
    const eof = "@@ -1 +1 @@\n-a\n+b";
    expect(key("x.sh", `${eof}\n\\ No newline at end of file`)).not.toBe(key("x.sh", eof));
    // The content fingerprint (eval ground truth) stays line-ending agnostic.
    expect(fp("x.sh", lf.replace(/\n/g, "\r\n"))).toBe(fp("x.sh", lf));
  });
});
