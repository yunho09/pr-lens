import { describe, expect, it } from "vitest";
import { parsePatch } from "./diff";
import { ghFile, makePr } from "@/test/fixtures";
import { classifyFile, fileRole, looksLikeFormatting, type ClassifyInput } from "./noise";

const REAL_PATCH = "@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";

function input(filename: string, patch: string | null, extra: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    filename,
    status: "modified",
    changes: 2,
    hasPatch: patch !== null,
    hunks: patch === null ? [] : parsePatch(patch, 0),
    ...extra,
  };
}

function hunks(patch: string) {
  return parsePatch(patch, 0);
}

describe("classifyFile", () => {
  it.each([
    "package-lock.json",
    "apps/web/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
    "ios/Podfile.lock",
  ])("skips lockfile %s", (filename) => {
    expect(classifyFile(input(filename, REAL_PATCH))).toMatchObject({ kind: "skip", category: "lockfile" });
  });

  it.each([
    "dist/index.js",
    "packages/web/dist/index.js",
    "build/out.js",
    "out/main.js",
    ".next/server/app.js",
    "coverage/lcov.info",
    "vendor/github.com/x/y.go",
    "node_modules/x/index.js",
    "src/__generated__/graphql.ts",
    "public/app.min.js",
    "public/app.min.css",
    "public/app.js.map",
    "api/user.pb.go",
    "proto/user_pb2.py",
    "lib/model.g.dart",
    "src/schema.generated.ts",
    "src/vendor/auth.js",
  ])("sends generated/build/vendored %s to Claude, marked generated-path", (filename) => {
    // A GitHub Action's dist/index.js, or vendored code, is what actually runs.
    const file = input(filename, REAL_PATCH);
    expect(classifyFile(file)).toEqual({ kind: "keep" });
    expect(file.hunks.every((h) => h.generatedPath === true)).toBe(true);
  });

  it("does not mark a file merely named like a build dir, or build/ and out/ below the root", () => {
    for (const filename of ["src/build.ts", "scripts/dist-tag.js", "src/build/lib/x.ts", "packages/core/build/out.js", "src/out/report.ts"]) {
      const file = input(filename, REAL_PATCH);
      expect(classifyFile(file)).toEqual({ kind: "keep" });
      expect(file.hunks[0].generatedPath).toBeUndefined();
    }
  });

  it.each(["src/__snapshots__/App.test.tsx.snap", "out.snap"])(
    "skips snapshot %s",
    (filename) => {
      // "out.snap" is not under out/ (file, not dir), so it must hit the snapshot rule.
      expect(classifyFile(input(filename, REAL_PATCH))).toMatchObject({ kind: "skip", category: "snapshot" });
    },
  );

  it("keeps code that merely sits in a __snapshots__ directory", () => {
    expect(classifyFile(input("src/__snapshots__/helper.js", REAL_PATCH))).toEqual({ kind: "keep" });
  });

  it("skips a pure rename with zero changes and mentions the old path", () => {
    const result = classifyFile(
      input("src/new.ts", null, { status: "renamed", changes: 0, previousFilename: "src/old.ts" }),
    );
    expect(result).toMatchObject({ kind: "skip", category: "rename" });
    if (result.kind === "skip") expect(result.reason).toContain("src/old.ts");
  });

  it.each([
    ["docs/example.yml", ".github/workflows/x.yml"],
    [".github/workflows/ci.yml", "docs/ci.yml"],
    ["scripts/pre-commit", ".husky/pre-commit"],
    ["tools/check", ".git-hooks/pre-push"],
    ["scripts/lint", "hooks/post-checkout"],
    ["scripts/run", "bin/run"],
    ["docker/base.txt", "Dockerfile"],
    ["config/build.txt", "Makefile"],
    ["fixtures/pkg.json", "package.json"],
    ["scripts/setup.txt", "scripts/setup.sh"],
    ["ci/pipeline.txt", ".gitlab-ci.yml"],
    ["src/foo.test.js", "src/foo.js"],
    ["src/foo.js", "src/foo.test.js"],
  ])("does not skip a rename that can change what runs: %s → %s", (from, to) => {
    expect(classifyFile(input(to, null, { status: "renamed", changes: 0, previousFilename: from }))).toEqual({
      kind: "unavailable",
      reason: "이름 변경 — 실행 위치가 바뀔 수 있음",
    });
  });

  it.each([
    [".github/workflows/security.yml", ".github/workflows/yarn.lock"],
    [".github/workflows/security.yml", ".github/workflows/security.snap"],
    ["src/policy.js", "src/policy.snap"],
    ["src/policy.js", "src/package-lock.json"],
  ])("does not hide a file renamed to a lockfile/snapshot name: %s → %s", (from, to) => {
    expect(classifyFile(input(to, null, { status: "renamed", changes: 0, previousFilename: from }))).toMatchObject({
      kind: "unavailable",
    });
  });

  it("still skips a lockfile/snapshot that was one before the rename", () => {
    expect(
      classifyFile(input("app/yarn.lock", null, { status: "renamed", changes: 0, previousFilename: "yarn.lock" })),
    ).toMatchObject({ kind: "skip", category: "lockfile" });
    expect(
      classifyFile(input("src/__snapshots__/b.snap", null, { status: "renamed", changes: 0, previousFilename: "src/__snapshots__/a.snap" })),
    ).toMatchObject({ kind: "skip", category: "snapshot" });
  });

  it("keeps a rename that also changes content", () => {
    expect(
      classifyFile(input("src/new.ts", REAL_PATCH, { status: "renamed", previousFilename: "src/old.ts" })),
    ).toEqual({ kind: "keep" });
  });

  it.each(["public/logo.png", "fonts/Pretendard.woff2", "media/intro.mp4", "sounds/ding.mp3", "docs/spec.pdf"])(
    "skips inert media without a patch: %s",
    (filename) => {
      expect(classifyFile(input(filename, null))).toMatchObject({ kind: "skip", category: "binary" });
    },
  );

  it.each([
    "gradle/wrapper/gradle-wrapper.jar",
    "lib/libfoo.so",
    "build/Release/addon.node",
    "bin/tool.exe",
    "win/x.dll",
    "Main.class",
    "app/__pycache__/x.pyc",
    "public/app.wasm",
    "lib/libx.dylib",
    "lib/libx.a",
    "obj/x.o",
    "firmware/image.bin",
  ])("sends an executable or compiled binary to 확인 필요: %s", (filename) => {
    expect(classifyFile(input(filename, null, { changes: 0 }))).toEqual({
      kind: "unavailable",
      reason: "실행 파일·바이너리 변경 — 직접 확인",
    });
  });

  it("sends any other file without a patch to 확인 필요 (extensionless binary, chmod, svg, archive)", () => {
    for (const filename of ["bin/helper", "scripts/run.sh", "assets/logo.svg", "release.zip", "docs/report.docx"]) {
      expect(classifyFile(input(filename, null, { status: "added", changes: 0 }))).toMatchObject({ kind: "unavailable" });
    }
  });

  it("puts a text file without a patch in the unavailable bucket", () => {
    expect(classifyFile(input("src/huge.ts", null, { changes: 5000 }))).toEqual({
      kind: "unavailable",
      reason: "GitHub이 diff를 제공하지 않음 — 직접 확인",
    });
  });

  it("sends a patch that could not be parsed into hunks to 확인 필요", () => {
    expect(classifyFile(input("src/a.ts", "@@ -1 +1 @@\n-a\n+b\n@@ -x +y @@\n-c\n+d"))).toEqual({
      kind: "unavailable",
      reason: "diff를 해석할 수 없음 — 직접 확인",
    });
  });

  it("keeps a hunk whose @@ section text contains U+2028 (it used to vanish)", () => {
    const pr = makePr([ghFile("src/a.js", "@@ -10,3 +10,3 @@ function x() { // a\u2028b\n ctx\n-checkAuth(user);\n+// checkAuth(user);\n ctx\n")]);
    expect(pr.files[0].classification).toEqual({ kind: "keep" });
    expect(pr.files[0].hunks).toHaveLength(1);
  });

  // Trailing whitespace and CR can matter (Makefile values, heredoc terminators,
  // Markdown hard breaks, strings), so they are sent to Claude with a hint.
  it.each([
    ["trailing spaces and tabs", "src/a.ts", "@@ -1,2 +1,2 @@\n-return x;   \n-y();\t\n+return x;\n+y();"],
    ["CRLF to LF", "app/main.py", "@@ -1,2 +1,2 @@\n-a = 1\r\n-b = 2\r\n+a = 1\n+b = 2"],
    ["a final newline added", "src/a.ts", "@@ -1 +1 @@\n-end()\n\\ No newline at end of file\n+end()"],
    ["a Makefile value gaining a trailing space", "Makefile", "@@ -1,3 +1,3 @@\n CC = gcc\n-BUILD_DIR = build\n+BUILD_DIR = build \n clean:\n"],
    ["a heredoc terminator gaining a space", "install.sh", "@@ -3,3 +3,3 @@ cat <<EOF\n usage text\n-EOF\n+EOF \n verify_signature || exit 1\n"],
    ["a heredoc terminator gaining a CR", "install.sh", "@@ -3,3 +3,3 @@ cat <<EOF\n usage text\n-EOF\n+EOF\r\n verify_signature || exit 1\n"],
    ["a Markdown hard break removed", "README.md", "@@ -1,2 +1,2 @@\n-line one  \n+line one\n line two\n"],
  ])("sends a line-end-only change to Claude, marked line-end: %s", (_name, filename, patch) => {
    const file = input(filename, patch);
    expect(classifyFile(file)).toEqual({ kind: "keep" });
    expect(file.hunks.map((h) => [h.lineEndOnly === true, h.likelyFormatting === true])).toEqual([[true, false]]);
  });

  it("does not call a CR after a line-continuation backslash a line-end-only or formatting change", () => {
    const file = input("run.sh", '@@ -1,2 +1,2 @@\n-echo cleaning \\\n+echo cleaning \\\r\n rm -rf "$HOME"\n');
    expect(classifyFile(file)).toEqual({ kind: "keep" });
    expect(file.hunks[0].lineEndOnly).toBeUndefined();
    expect(file.hunks[0].likelyFormatting).toBeUndefined();
  });

  it.each([
    ["blank lines only", "src/a.ts", "@@ -1,2 +1,4 @@\n a\n+\n+   \n b"],
    ["re-indentation", "src/a.ts", "@@ -1,2 +1,2 @@\n-  y()\n+    y()"],
    ["inner spacing", "src/a.ts", "@@ -1 +1 @@\n-foo( a,b )\n+foo(a, b)"],
    ["trailing space after a line-continuation backslash", "scripts/clean.sh", '@@ -1,2 +1,2 @@\n-rm -rf "$DIR" \\ \n+rm -rf "$DIR" \\\n --no-preserve-root'],
  ])("keeps any other whitespace-only change: %s", (_name, filename, patch) => {
    expect(classifyFile(input(filename, patch))).toEqual({ kind: "keep" });
  });

  // Each of these looked whitespace-only to the old normalizer but changes behavior.
  it.each([
    ["a CR inside a line (ASI after return)", "src/a.ts", "@@ -1 +1 @@\n-return BLOCKLIST.has(url);\n+return\rBLOCKLIST.has(url);"],
    ["a CR ending a Python comment", "app/main.py", "@@ -1 +1 @@\n-x = 1  # reset()\n+x = 1  #\rreset()"],
    ["U+2028 ending a // comment", "src/a.ts", "@@ -1 +1 @@\n-// enable(); later\n+//\u2028enable(); later"],
    ["U+2029 ending a // comment", "src/a.ts", "@@ -1 +1 @@\n-// enable(); later\n+//\u2029enable(); later"],
    ["shell inside a template literal", "src/deploy.ts", "@@ -1,3 +1,3 @@\n const script = `\n-rm -rf $DEST/*\n+rm -rf $DEST /*\n `;"],
    ["a shell assignment inside a template literal", "src/deploy.ts", "@@ -1,3 +1,3 @@\n const env = `\n-TARGET=/srv\n+TARGET =/srv\n `;"],
    ["re-indentation in an extensionless Python script", "bin/deploy", "@@ -1,2 +1,2 @@\n if dry_run:\n-    exit(0)\n+exit(0)"],
    ["re-indentation in a Bazel BUILD file", "pkg/BUILD", "@@ -1,2 +1,2 @@\n if dry_run:\n-    exit(0)\n+exit(0)"],
    ["re-indentation in a .bzl file", "tools/defs.bzl", "@@ -1,2 +1,2 @@\n if dry_run:\n-    exit(0)\n+exit(0)"],
    ["re-indentation in a .pyx file", "src/fast.pyx", "@@ -1,2 +1,2 @@\n if dry_run:\n-    exit(0)\n+exit(0)"],
    ["re-indentation in Scala 3", "src/Main.scala", "@@ -1,2 +1,2 @@\n if dryRun then\n-  sys.exit(0)\n+sys.exit(0)"],
    ["re-indentation in Haskell", "src/Main.hs", "@@ -1,2 +1,2 @@\n main = do\n-  run\n+run"],
    ["re-indentation in F#", "src/App.fs", "@@ -1,2 +1,2 @@\n if dryRun then\n-    exit 0\n+exit 0"],
    ["re-indentation in config.yml.dist", "config.yml.dist", "@@ -1,2 +1,2 @@\n db:\n-  host: x\n+host: x"],
    ["a Go build directive turned into a comment", "main.go", "@@ -1,2 +1,2 @@\n-//go:build linux\n+// go:build linux\n package main"],
    ["a division turned into a comment", "src/a.ts", "@@ -1 +1 @@\n-x = a / /re/.source.length;\n+x = a //re/.source.length;"],
    ["PHP concatenation turned into a float", "src/a.php", "@@ -1 +1 @@\n-$x = 1 . 2;\n+$x = 1.2;"],
    ["an exponent split from its number", "src/a.ts", "@@ -1 +1 @@\n-x = 1.e5;\n+x = 1 .e5;"],
    ["spacing inside a Rust raw string", "src/lib.rs", '@@ -1 +1 @@\n-let s = r#"say "hi" now"#;\n+let s = r#"say " hi" now"#;'],
    ["JSX text spacing", "src/App.tsx", "@@ -1 +1 @@\n-<b>Total:</b> {count}\n+<b>Total:</b>{count}"],
    ["a blank line inside a Python string", "app/msg.py", '@@ -1,2 +1,3 @@\n MSG = """hello\n+\n world"""'],
  ])("keeps %s", (_name, filename, patch) => {
    expect(classifyFile(input(filename, patch))).toEqual({ kind: "keep" });
  });

  it("keeps a prettier-style reformat, but marks those hunks as likely formatting", () => {
    const file = input(
      "src/a.ts",
      "@@ -1,3 +1,3 @@\n-const a=1\n-foo( a,b )\n+const a = 1\n+foo(a, b)\n x\n@@ -20 +20 @@\n-run(1)\n+run(2)",
    );
    expect(classifyFile(file)).toEqual({ kind: "keep" });
    expect(file.hunks.map((h) => h.likelyFormatting === true)).toEqual([true, false]);
  });

  it("keeps ordinary code changes", () => {
    expect(classifyFile(input("src/a.ts", REAL_PATCH))).toEqual({ kind: "keep" });
  });
});

describe("looksLikeFormatting (a hint for Claude, never a skip)", () => {
  it("does not count line terminators inside a line as spaces", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-return x;\n+return\rx;"), "a.ts")).toBe(false);
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-// a b\n+// a\u2028b"), "a.ts")).toBe(false);
  });

  it("treats indentation as meaningful when the language is unknown or indentation-sensitive", () => {
    const dedent = "@@ -1,2 +1,2 @@\n if x:\n-    run()\n+run()";
    for (const name of ["bin/deploy", "pkg/BUILD", "defs.bzl", "fast.pyx", "Main.hs", "App.fs", "Main.scala", "config.yml.dist"]) {
      expect(looksLikeFormatting(hunks(dedent), name)).toBe(false);
    }
  });

  it("is true for re-indentation and spacing changes", () => {
    expect(looksLikeFormatting(hunks("@@ -1,2 +1,2 @@\n-if(x){\n-  y()\n+if (x) {\n+    y()"), "a.ts")).toBe(true);
  });

  it("is false when identical lines are reordered within a hunk", () => {
    expect(looksLikeFormatting(hunks("@@ -1,2 +1,2 @@\n-a\n-b\n+b \n+ a"), "a.ts")).toBe(false);
  });

  // A hostile PR must not be able to hide a real change in the collapsed noise section.
  it.each([
    [
      "a statement moved out of a guard across a context line",
      "@@ -1,3 +1,3 @@\n if(!authorized){\n-return deny();\n }\n+return deny();",
      "src/auth.ts",
    ],
    [
      "two statements swapped",
      "@@ -1,2 +1,2 @@\n-checkAuth(req);\n-deleteAll(db);\n+deleteAll(db);\n+checkAuth(req);",
      "src/handler.ts",
    ],
    ["whitespace inside a string literal", '@@ -1 +1 @@\n-exec("rm -rf " + dir);\n+exec("rm -rf" + dir);', "src/clean.ts"],
    ["two words joined into one", "@@ -1 +1 @@\n-const u = await fetchUser(id);\n+const u = awaitfetchUser(id);", "src/user.ts"],
    [
      "a Python statement reorder",
      "@@ -1,3 +1,3 @@\n def handle(user):\n-    check_permission(user)\n-    delete_account(user)\n+    delete_account(user)\n+    check_permission(user)",
      "app/views.py",
    ],
    ["a line break that changes ASI", "@@ -1,2 +1 @@\n-return\n-  value;\n+return value;", "src/a.ts"],
    ["operators merged (`i++ + j` vs `i + ++j`)", "@@ -1 +1 @@\n-x = i++ + j;\n+x = i + ++j;", "src/a.ts"],
    ["spacing inside a regex literal", "@@ -1 +1 @@\n-if (/^admin +$/.test(role)) allow();\n+if (/^admin+$/.test(role)) allow();", "src/a.ts"],
    ["spacing around `=` in a shell script", "@@ -1 +1 @@\n-FOO=bar\n+FOO = bar", "scripts/run.sh"],
    ["a CSS descendant selector", "@@ -1 +1 @@\n-div .item { color: red }\n+div.item { color: red }", "src/app.css"],
  ])("is false for %s", (_name, patch, filename) => {
    expect(looksLikeFormatting(hunks(patch), filename)).toBe(false);
  });

  it("keeps spacing-only changes around operators and brackets as formatting", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-x = a/b + c;\n+x = a / b + c;"), "a.ts")).toBe(true);
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-const s = 'a  b';  // note\n+const s = 'a  b'; // note"), "a.ts")).toBe(true);
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-run  --fast   now\n+run --fast now"), "scripts/run.sh")).toBe(true);
  });

  it("is true when only blank lines are added or removed", () => {
    expect(looksLikeFormatting(hunks("@@ -1,2 +1,4 @@\n a\n+\n+   \n b"), "a.ts")).toBe(true);
  });

  it("is true for trailing whitespace removal", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-return x;   \n+return x;"), "a.ts")).toBe(true);
  });

  it("is false when a token changes", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-return x;\n+return y;"), "a.ts")).toBe(false);
  });

  it("is false when punctuation changes (trailing comma, semicolon)", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-foo(a, b)\n+foo(a, b,)"), "a.ts")).toBe(false);
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-x = 1\n+x = 1;"), "a.ts")).toBe(false);
  });

  it("is false when a line is duplicated (multiset counts matter)", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1,2 @@\n-call()\n+call()\n+call()"), "a.ts")).toBe(false);
  });

  it("is false when any one hunk has a real change", () => {
    const patch = "@@ -1 +1 @@\n-a=1\n+a = 1\n@@ -10 +10 @@\n-b = 1\n+b = 2";
    expect(looksLikeFormatting(hunks(patch), "a.ts")).toBe(false);
  });

  it("is false when there are no changed lines at all", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n same"), "a.ts")).toBe(false);
    expect(looksLikeFormatting([], "a.ts")).toBe(false);
  });

  it("treats indentation as meaningful in indentation-sensitive languages", () => {
    const dedent = "@@ -1,2 +1,2 @@\n if x:\n-    run()\n+run()";
    expect(looksLikeFormatting(hunks(dedent), "app/main.py")).toBe(false);
    expect(looksLikeFormatting(hunks(dedent), "app/main.ts")).toBe(true);
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-  key: 1\n+key: 1"), "config.yaml")).toBe(false);
  });

  it("still allows inner-spacing changes in indentation-sensitive languages", () => {
    expect(looksLikeFormatting(hunks("@@ -1 +1 @@\n-    x=f( 1 )\n+    x = f(1)"), "main.py")).toBe(true);
  });
});

describe("fileRole", () => {
  it.each([
    ["src/app.ts", "source"],
    ["src/app.test.ts", "test"],
    ["src/app.spec.tsx", "test"],
    ["src/__tests__/app.ts", "test"],
    ["tests/test_app.py", "test"],
    ["pkg/app_test.go", "test"],
    ["README.md", "docs"],
    ["docs/guide.ts", "docs"],
    ["CHANGELOG", "docs"],
    ["package.json", "config"],
    [".github/workflows/ci.yml", "config"],
    ["next.config.ts", "config"],
    [".eslintrc", "config"],
    ["Dockerfile", "config"],
  ] as const)("%s → %s", (filename, role) => {
    expect(fileRole(filename)).toBe(role);
  });
});
