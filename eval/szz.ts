import type { DiffLine, FileClassification, FileRole } from "@/lib/types";

// SZZ-lite: a fix PR F points at the merged PR B that introduced the bug.
// B's hunks that added a line F later removed (same path, same trimmed text)
// are labeled buggy. Pure functions only; collect.ts does the I/O.

/** Noise categories whose content is machine-made; the human-written source sits elsewhere in the PR. */
const MACHINE_GENERATED = new Set(["lockfile", "generated", "snapshot"]);
/**
 * Fixes also rename tests, fix typos in docs, and delete changeset files on
 * release; none of that is the bug. Labels come from source and config only.
 */
const LABELED_ROLES = new Set<FileRole>(["source", "config"]);

const TRIVIAL_RES: RegExp[] = [
  /^[\s{}[\]();,]*$/, // braces / brackets only
  /^import[\s{*"']/, // import x from "y" / import { a } / import * / import "side-effect"
  /^export\s*(?:type\s*)?[*{]/, // re-exports
  /^export\s+default\s+[\w$.]+;?$/, // export default Foo;
  /^\}\s*from\s*["']/, // end of a multi-line import/export
  /^from\s+[\w.]+\s+import\s/, // python
  /^(?:const|let|var)\s+[\w${},\s]+=\s*require\(\s*["'][^"']+["']\s*\);?$/,
  /^[\w$]+,?$/, // a lone name, e.g. inside a multi-line import list
  /^(?:\/\/|\/\*|\*\/|\*(?:\s|$)|#(?:\s|$)|<!--)/, // comment lines
];

/** Lines too generic to tie a fix to a change: short, punctuation, imports/exports, comments. */
export function isTrivialLine(trimmed: string): boolean {
  if (trimmed.length < 8) return true;
  return TRIVIAL_RES.some((re) => re.test(trimmed));
}

/** "fixture" and "FIXME" (e.g. "remove FIXME") are not fixes. */
const FIX_RE = /\b(?:fix(?!ture|me)|bug|regression|hotfix)/i;

/** PR templates: drop HTML comments and unchecked checkboxes ("- [ ] Bug fix"). */
export function cleanPrBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*[-*]\s*\[ \]/.test(line))
    .join("\n");
}

export function isFixPr(title: string, body: string): boolean {
  return FIX_RE.test(title) || FIX_RE.test(cleanPrBody(body));
}

/** Reverts match every line, so they do not discriminate. */
export function isRevertPr(title: string, body: string): boolean {
  return (
    /^\W*revert\b/i.test(title.trim()) ||
    /^\s*Reverts\s+[\w.-]+\/[\w.-]+#\d+/im.test(body) ||
    /This reverts commit [0-9a-f]{7,40}/i.test(body)
  );
}

/**
 * Same-repo PR/issue numbers referenced as `#123`, `owner/repo#123`, or a
 * github.com pull/issues URL, in order of appearance, excluding `self`.
 */
export function extractRefs(text: string, owner: string, repo: string, self: number): number[] {
  const same = (o: string, r: string) => o.toLowerCase() === owner.toLowerCase() && r.toLowerCase() === repo.toLowerCase();
  const out: number[] = [];
  const add = (n: number) => {
    if (n !== self && n > 0 && !out.includes(n)) out.push(n);
  };
  const re =
    /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)|(?:^|[^\w/.#-])(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/g;
  for (const m of text.matchAll(re)) {
    if (m[3]) {
      if (same(m[1], m[2])) add(Number(m[3]));
    } else if (!m[4] || same(m[4], m[5])) {
      add(Number(m[6]));
    }
  }
  return out;
}

export interface SzzHunk {
  id: string;
  header: string;
  fingerprint: string;
  lines: DiffLine[];
  /** Build output or vendored code: reaches Claude, but the human-written source is elsewhere. */
  generatedPath?: boolean;
}

export interface FixFile {
  filename: string;
  previousFilename?: string;
  hunks: Array<{ lines: DiffLine[] }>;
}

/**
 * path → trimmed non-trivial lines the fix removed. A file the fix renamed is
 * indexed under both names, since B saw it under the old one.
 */
export function removedLineIndex(files: FixFile[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const paths = file.previousFilename ? [file.filename, file.previousFilename] : [file.filename];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== "del") continue;
        const t = line.content.trim();
        if (isTrivialLine(t)) continue;
        for (const p of paths) {
          let set = index.get(p);
          if (!set) index.set(p, (set = new Set()));
          set.add(t);
        }
      }
    }
  }
  return index;
}

export interface CandidateFile {
  filename: string;
  role: FileRole;
  classification: FileClassification;
  hunks: SzzHunk[];
}

export interface BuggyHunk {
  path: string;
  fingerprint: string;
  /** First added line the fix removed. */
  sample: string;
  header: string;
  /** False when the noise filter drops this hunk (it never reaches Claude). */
  kept: boolean;
}

export type CaseVerdict =
  | { ok: true; buggy: BuggyHunk[]; keptHunks: number }
  | { ok: false; reason: "no-match" | "noise-only" | "too-many"; buggy: BuggyHunk[]; keptHunks: number };

const SAMPLE_MAX = 160;

/**
 * Labels B's hunks against the fix's removed lines and applies the case rule:
 * at least one buggy hunk reaches Claude, and those are at most 50% of
 * B's kept hunks (otherwise the label does not discriminate).
 */
export function labelCase(bugFiles: CandidateFile[], removed: Map<string, Set<string>>): CaseVerdict {
  const buggy: BuggyHunk[] = [];
  let keptHunks = 0;
  for (const file of bugFiles) {
    const c = file.classification;
    const kept = c.kind === "keep";
    if (kept) keptHunks += file.hunks.length;
    if (!LABELED_ROLES.has(file.role) || (c.kind === "skip" && MACHINE_GENERATED.has(c.category))) continue;
    const fixed = removed.get(file.filename);
    if (!fixed) continue;
    for (const hunk of file.hunks) {
      if (hunk.generatedPath) continue;
      const hit = hunk.lines.find((l) => {
        if (l.type !== "add") return false;
        const t = l.content.trim();
        return !isTrivialLine(t) && fixed.has(t);
      });
      if (!hit) continue;
      const sample = hit.content.trim();
      buggy.push({
        path: file.filename,
        fingerprint: hunk.fingerprint,
        sample: sample.length > SAMPLE_MAX ? `${sample.slice(0, SAMPLE_MAX - 1)}…` : sample,
        header: hunk.header,
        kept,
      });
    }
  }
  const keptBuggy = buggy.filter((b) => b.kept).length;
  if (buggy.length === 0) return { ok: false, reason: "no-match", buggy, keptHunks };
  if (keptBuggy === 0) return { ok: false, reason: "noise-only", buggy, keptHunks };
  if (keptBuggy * 2 > keptHunks) return { ok: false, reason: "too-many", buggy, keptHunks };
  return { ok: true, buggy, keptHunks };
}
