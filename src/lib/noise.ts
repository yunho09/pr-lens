import { hunkAnchorKey } from "./fingerprint";
import type { DiffLine, FileClassification, FileRole, Hunk } from "./types";

// Deterministic noise filter: no LLM involved. Only files that cannot change
// behavior are skipped (⚫); anything else goes to Claude, at worst with a hint
// and a low budget priority, or to 확인 필요 (🟣) when there is no diff to read.

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
  "Package.resolved",
  "packages.lock.json",
  "gradle.lockfile",
]);

/**
 * Build output, generated or vendored code at any depth. Not skipped: it may be
 * what actually ships (a GitHub Action's `dist/index.js`), so it goes to
 * Claude last, with a hint.
 */
const GENERATED_DIRS = new Set(["dist", ".next", "coverage", "vendor", "node_modules", "__generated__"]);
/** Build output only at the repo root: deeper, `build/` and `out/` are often source (`src/build/…`). */
const ROOT_GENERATED_DIRS = new Set(["build", "out"]);
const GENERATED_FILE_RE = [
  /\.min\.[^/.]+$/i,
  /\.map$/i,
  /\.pb\.go$/i,
  /_pb2(_grpc)?\.pyi?$/i,
  /\.(g|freezed)\.dart$/i,
  /\.generated\.[^/]+$/i,
];

/** Binaries that cannot run: skipped when GitHub has no patch. SVG is not here (it can carry script). */
const INERT_MEDIA_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tif", "tiff", "heic", "psd",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // audio / video
  "mp3", "mp4", "m4a", "mov", "webm", "wav", "ogg", "flac", "avi", "mkv",
  "pdf",
]);
/** Executable or compiled binaries: never skipped, sent to 확인 필요. */
const EXECUTABLE_EXTENSIONS = new Set(["jar", "war", "so", "dll", "exe", "class", "pyc", "wasm", "node", "dylib", "a", "o", "bin"]);

/** Directories whose files run: CI, git hooks, executables. */
const RUN_DIRS = new Set([".github", ".husky", ".git-hooks", "hooks", "bin", ".circleci", ".buildkite", ".gitlab"]);
/** Files that define what runs: builds, packages, CI. */
const RUN_BASENAMES = new Set([
  "Dockerfile", "Makefile", "GNUmakefile", "makefile", "Justfile", "justfile", "Jenkinsfile", "Procfile", "package.json",
  ".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "appveyor.yml", ".pre-commit-config.yaml",
]);
const RUN_EXTENSIONS = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);

/** Languages where leading indentation changes meaning. Matched against every dotted part (`config.yml.dist`). */
const INDENT_SENSITIVE_EXT = new Set([
  "py", "pyi", "pyx", "pxd", "pxi", "bzl", "bazel", "star", "yaml", "yml", "haml", "pug", "jade", "sass", "styl",
  "coffee", "nim", "slim", "hs", "lhs", "fs", "fsi", "fsx", "scala", "sc", "mk",
]);
const INDENT_SENSITIVE_BASENAMES = new Set([
  "Makefile", "GNUmakefile", "makefile", "BUILD", "WORKSPACE", "SConstruct", "SConscript",
]);

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function extension(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

function dirSegments(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

function isIndentSensitive(path: string): boolean {
  const base = basename(path);
  if (INDENT_SENSITIVE_BASENAMES.has(base)) return true;
  const parts = base.split(".").slice(1).map((p) => p.toLowerCase());
  // No extension: the language is unknown (an extensionless script may well be Python).
  return parts.length === 0 || parts.some((p) => INDENT_SENSITIVE_EXT.has(p));
}

const JS_EXT = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
/**
 * Languages where a space between a name and punctuation never changes meaning
 * (`a=1` vs `a = 1`). Elsewhere (shell, Ruby, CSS, YAML, C macros, …) it can,
 * so there whitespace runs are only collapsed to one space.
 */
const SPACING_INSENSITIVE_EXT = new Set([
  ...JS_EXT, "py", "pyi", "java", "kt", "kts", "scala", "go", "rs", "cs", "dart", "php", "json", "jsonc",
]);
/** Punctuation that can merge with a neighbour into another operator or a comment (`- -` vs `--`, `/ /` vs `//`). */
const OPERATOR_CHARS = new Set("+-*/%=<>!&|^~?:.#@\\");
/** After these words a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORDS = new Set([
  "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "yield", "await", "of",
]);
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
/** Whitespace that is not a line terminator: CR, U+2028 and U+2029 end lines (and `//` comments) in JS or Python. */
const SPACE = /[^\S\r\n\u2028\u2029\u0085]/;
const SPACE_RUN = /[^\S\r\n\u2028\u2029\u0085]+/g;

type TokenKind = "word" | "str" | "op" | "sep";

interface LineStyle {
  keepIndent: boolean;
  /** Whitespace next to a bracket, or between a name and an operator, is insignificant. */
  lenient: boolean;
  regexLiterals: boolean;
}

/** JS: a `/` begins a regex literal unless it starts a comment or follows a value. */
function canStartRegex(prev: { kind: TokenKind; text: string } | null, next: string | undefined): boolean {
  if (next === "/" || next === "*") return false;
  if (prev === null) return true;
  if (prev.kind === "word") return REGEX_AFTER_WORDS.has(prev.text);
  return prev.kind !== "str" && prev.text !== ")" && prev.text !== "]";
}

/** Index of the `/` closing the regex literal that starts at `start`, or -1 when the line has none. */
function regexEnd(text: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return -1;
}

/**
 * One line as an ordered token string: words, punctuation, and string/regex
 * literals verbatim. Whitespace between tokens becomes one space; in
 * spacing-insensitive languages it is dropped unless it separates two words,
 * two literals, or two operator characters. Empty for a blank line.
 */
function normalizeLine(content: string, style: LineStyle): string {
  const body = content.trim();
  if (body === "") return "";
  let out = style.keepIndent ? (/^\s*/.exec(content)?.[0] ?? "") : "";
  let prev: { kind: TokenKind; text: string } | null = null;
  let space = false;
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (SPACE.test(c)) {
      space = true;
      i++;
      continue;
    }
    let kind: TokenKind;
    let end = i + 1;
    let text: string | null = null;
    const regexClose = c === "/" && style.regexLiterals && canStartRegex(prev, body[i + 1]) ? regexEnd(body, i) : -1;
    if (c === '"' || c === "'" || c === "`") {
      kind = "str";
      while (end < body.length && body[end] !== c) end += body[end] === "\\" ? 2 : 1;
      if (end < body.length) {
        end++;
      } else {
        // Unterminated: a multi-line string or an apostrophe in a comment. Take the rest of the line.
        end = body.length;
        text = body.slice(i).replace(SPACE_RUN, " ");
      }
    } else if (regexClose !== -1) {
      kind = "str";
      end = regexClose + 1;
    } else if (WORD_CHAR.test(c)) {
      kind = "word";
      while (end < body.length && WORD_CHAR.test(body[end])) end++;
    } else {
      kind = OPERATOR_CHARS.has(c) ? "op" : "sep";
    }
    if (space && prev !== null && (!style.lenient || (prev.kind === kind && kind !== "sep"))) out += " ";
    text ??= body.slice(i, end);
    out += text;
    prev = { kind, text };
    space = false;
    i = end;
  }
  return out;
}

/**
 * Compares each hunk's removed and added lines as two ordered streams, with
 * context lines as barriers between segments, after `normalize` (null drops a
 * line). True when every segment matches and something changed.
 */
function changesMatch(hunks: Pick<Hunk, "lines">[], normalize: (line: DiffLine) => string | null): boolean {
  if (hunks.length === 0) return false;
  let sawChange = false;
  for (const hunk of hunks) {
    let removed: string[] = [];
    let added: string[] = [];
    const segmentMatches = () => {
      const same = removed.length === added.length && removed.every((line, i) => line === added[i]);
      removed = [];
      added = [];
      return same;
    };
    for (const line of hunk.lines) {
      if (line.type === "context") {
        if (!segmentMatches()) return false;
        continue;
      }
      sawChange = true;
      const n = normalize(line);
      if (n !== null) (line.type === "del" ? removed : added).push(n);
    }
    if (!segmentMatches()) return false;
  }
  return sawChange;
}

/**
 * A line ending in `\` continues onto the next one (shell, C, Python, Makefile):
 * a space or CR after it changes that, so such a line is compared exactly.
 */
function continuedLine(line: DiffLine): string | null {
  return line.content.replace(/[ \t]+$/, "").endsWith("\\") ? `${line.content}${line.cr ? "\r" : ""}` : null;
}

/**
 * True when lines only change at their very end: trailing spaces/tabs, CR
 * (CRLF ↔ LF) or the final newline. Lines must pair up one to one, so blank
 * lines, indentation and inner spacing do not qualify. A hint, not a skip:
 * trailing whitespace and CR matter in Makefiles, heredocs, Markdown and strings.
 */
function isLineEndOnly(hunks: Pick<Hunk, "lines">[]): boolean {
  return changesMatch(hunks, (line) => continuedLine(line) ?? line.content.replace(/[ \t]+$/, ""));
}

/**
 * A hint, never a skip: true when the hunks look whitespace-only to a lenient
 * normalizer (ordered token streams, see normalizeLine). Claude still reads
 * them and is asked to verify; this cannot see inside multi-line strings or
 * know every language's spacing rules. Blank lines are ignored; for
 * indentation-sensitive or unknown languages leading indentation counts.
 */
export function looksLikeFormatting(hunks: Pick<Hunk, "lines">[], filename: string): boolean {
  const ext = extension(filename);
  const style: LineStyle = {
    keepIndent: isIndentSensitive(filename),
    lenient: SPACING_INSENSITIVE_EXT.has(ext),
    regexLiterals: JS_EXT.has(ext),
  };
  return changesMatch(hunks, (line) => continuedLine(line) ?? (normalizeLine(line.content, style) || null));
}

function isGeneratedPath(filename: string): boolean {
  const dirs = dirSegments(filename);
  return (
    dirs.some((d) => GENERATED_DIRS.has(d)) ||
    ROOT_GENERATED_DIRS.has(dirs[0]) ||
    GENERATED_FILE_RE.some((re) => re.test(basename(filename)))
  );
}

function runsSomething(path: string): boolean {
  const base = basename(path);
  return (
    dirSegments(path).some((d) => RUN_DIRS.has(d)) ||
    RUN_BASENAMES.has(base) ||
    /^Dockerfile\./.test(base) ||
    RUN_EXTENSIONS.has(extension(path))
  );
}

/** Whether a rename alone can change what runs: into or out of CI/hooks/bin, onto a build or script file, or across test/non-test. */
function renameMayChangeBehavior(from: string | undefined, to: string): boolean {
  if (!from) return true;
  return runsSomething(from) || runsSomething(to) || (fileRole(from) === "test") !== (fileRole(to) === "test");
}

type ClassifiedHunk = Pick<Hunk, "lines" | "anchorKey" | "likelyFormatting" | "lineEndOnly" | "generatedPath"> &
  Partial<Pick<Hunk, "section">>;

export interface ClassifyInput {
  filename: string;
  previousFilename?: string;
  status: string;
  changes: number;
  hasPatch: boolean;
  hunks: ClassifiedHunk[];
}

/**
 * Skips (⚫) only lockfiles, snapshots, harmless renames and inert media.
 * Also annotates the hunks: `anchorKey` on all, and for a kept file the hints
 * Claude and the UI see (generatedPath, lineEndOnly, likelyFormatting).
 */
export function classifyFile(file: ClassifyInput): FileClassification {
  const { filename } = file;
  const base = basename(filename);
  for (const hunk of file.hunks) hunk.anchorKey = hunkAnchorKey(filename, hunk);

  // A rename only counts as a lockfile/snapshot when it was one before too:
  // renaming a CI workflow or source file to `yarn.lock`/`*.snap` must not hide it.
  const from = file.status === "renamed" ? (file.previousFilename ?? "") : undefined;

  if (LOCKFILES.has(base) && (from === undefined || LOCKFILES.has(basename(from)))) {
    return { kind: "skip", category: "lockfile", reason: "락파일 — 의존성 버전을 고정하는 자동 생성 파일" };
  }

  if (extension(filename) === "snap" && (from === undefined || extension(from) === "snap")) {
    return { kind: "skip", category: "snapshot", reason: "테스트 스냅샷 — 자동 생성 결과" };
  }

  if (from !== undefined && file.changes === 0) {
    if (renameMayChangeBehavior(file.previousFilename, filename) || extension(from) !== extension(filename)) {
      return { kind: "unavailable", reason: "이름 변경 — 실행 위치가 바뀔 수 있음" };
    }
    return { kind: "skip", category: "rename", reason: `내용 변경 없는 이름 변경·이동 (${file.previousFilename}에서)` };
  }

  if (!file.hasPatch) {
    const ext = extension(filename);
    if (INERT_MEDIA_EXTENSIONS.has(ext)) return { kind: "skip", category: "binary", reason: "이미지·폰트·미디어 파일" };
    if (EXECUTABLE_EXTENSIONS.has(ext)) return { kind: "unavailable", reason: "실행 파일·바이너리 변경 — 직접 확인" };
    return {
      kind: "unavailable",
      reason:
        file.changes === 0
          ? "diff 없음 (권한 변경·빈 파일·바이너리일 수 있음) — 직접 확인"
          : "GitHub이 diff를 제공하지 않음 — 직접 확인",
    };
  }

  // A patch that parsePatch could not read (it fails closed with no hunks).
  if (file.hunks.length === 0) return { kind: "unavailable", reason: "diff를 해석할 수 없음 — 직접 확인" };

  const generated = isGeneratedPath(filename);
  for (const hunk of file.hunks) {
    if (generated) hunk.generatedPath = true;
    if (isLineEndOnly([hunk])) hunk.lineEndOnly = true;
    else if (looksLikeFormatting([hunk], filename)) hunk.likelyFormatting = true;
  }
  return { kind: "keep" };
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__mocks__", "cypress", "testdata", "fixtures"]);
const DOC_EXT = new Set(["md", "mdx", "rst", "txt", "adoc"]);
const CONFIG_EXT = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env", "editorconfig"]);
const CONFIG_BASENAMES = new Set(["Dockerfile", "Makefile", "Procfile", "Brewfile", "Gemfile", "Pipfile", "CODEOWNERS"]);

/** Coarse role of a file, used to prioritise hunks when the prompt budget is tight. */
export function fileRole(filename: string): FileRole {
  const base = basename(filename);
  const dirs = dirSegments(filename);
  const ext = extension(filename);

  if (
    dirs.some((d) => TEST_DIRS.has(d)) ||
    /\.(test|spec)\.[^.]+$/i.test(base) ||
    /_test\.(go|py|rb|exs?)$/.test(base) ||
    /^test_.+\.py$/.test(base) ||
    /Tests?\.(java|kt|cs|swift|scala)$/.test(base)
  ) {
    return "test";
  }
  if (DOC_EXT.has(ext) || dirs.includes("docs") || /^(LICENSE|CHANGELOG|README|CONTRIBUTING|AUTHORS)/i.test(base)) {
    return "docs";
  }
  if (
    CONFIG_EXT.has(ext) ||
    CONFIG_BASENAMES.has(base) ||
    base.startsWith(".") ||
    dirs.includes(".github") ||
    /\.config\.[cm]?[jt]s$/.test(base) ||
    /^Dockerfile\./.test(base)
  ) {
    return "config";
  }
  return "source";
}
