// Shared data shapes. Client-safe: no Node imports here.

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLine: number | null;
  newLine: number | null;
  /** The line was followed by "\ No newline at end of file". */
  noNewline?: boolean;
  /** The line ended in a CR (CRLF); `content` excludes it. */
  cr?: boolean;
}

export interface ParsedHunk {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
}

export interface Hunk extends ParsedHunk {
  /** sha1 of path + the +/- lines; stable when the hunk only moves. Content only: eval ground truth. */
  fingerprint: string;
  /**
   * Position-aware identity (path, @@ section, nearby context, changed lines):
   * what inheritance and 봤음 match on. Absent in entries cached before it existed.
   */
  anchorKey?: string;
  /**
   * Looks whitespace-only to a lenient heuristic. Still sent to Claude (late
   * in the budget, marked for verification); a hint, never a skip.
   */
  likelyFormatting?: boolean;
  /** Only trailing spaces/tabs, CR or the final newline changed. Sent to Claude with a hint. */
  lineEndOnly?: boolean;
  /** In a build-output, generated or vendored path. Sent to Claude last, with a hint. */
  generatedPath?: boolean;
}

export type ReviewMode = "deep" | "fast";

export type FileRole = "source" | "test" | "docs" | "config";

export type NoiseCategory =
  | "lockfile"
  | "generated"
  | "snapshot"
  | "rename"
  | "no-change"
  | "binary"
  | "formatting";

export type FileClassification =
  | { kind: "keep" }
  | { kind: "skip"; category: NoiseCategory; reason: string }
  | { kind: "unavailable"; reason: string };

export interface PrFile {
  index: number;
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  hasPatch: boolean;
  role: FileRole;
  /** sha256 hex of the filename — GitHub's `#diff-…` anchor. */
  anchor: string;
  hunks: Hunk[];
  classification: FileClassification;
}

export interface PrMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  headSha: string;
  baseRef: string;
  /** Base branch commit; absent in entries cached before phase 2. */
  baseSha?: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  htmlUrl: string;
}

export interface PrData {
  meta: PrMeta;
  files: PrFile[];
}

export const PRIORITIES = ["must", "should", "skim"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CATEGORIES = [
  "logic",
  "security",
  "api-contract",
  "data",
  "error-handling",
  "concurrency",
  "performance",
  "test",
  "config",
  "refactor",
  "style",
  "docs",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface HighlightRef {
  side: "old" | "new";
  line: number;
}

/** A place outside the hunk worth opening alongside it. `line` is 0 when not applicable. */
export interface LookAt {
  path: string;
  line: number;
  reason: string;
}

export interface TriageItem {
  hunkId: string;
  priority: Priority;
  category: Category;
  title: string;
  /** What the code does, for someone new to the codebase. */
  explain: string;
  /** Why the reviewer should look (risk), or why skimming is safe. */
  why: string;
  check: string;
  highlight: HighlightRef[];
  lookAt: LookAt[];
  /** True when the hunk did not exist in the previous analysis. */
  isNew: boolean;
  /**
   * "fallback": Claude returned no item for this hunk.
   * "inherited": copied from the previous analysis because the hunk is unchanged.
   */
  source: "ai" | "fallback" | "inherited";
}

export interface OmittedHunk {
  hunkId: string;
  reason: string;
}

/** Hunk counts, one per hunk: a current hunk pairs with at most one previous hunk of the same fingerprint. */
export interface ReviewDelta {
  /** Kept hunks with no counterpart in the previous analysis. */
  new: number;
  /** Kept hunks with a counterpart in the previous analysis. */
  unchanged: number;
  /** Previous kept hunks with no counterpart now. */
  resolved: number;
  /**
   * Of `unchanged`, hunks Claude classified again in this run (previously
   * unclassified or omitted, or a full re-analysis). Absent before this was tracked.
   */
  reanalyzed?: number;
}

export interface ReviewResult {
  /** Mode actually used (deep falls back to fast when the checkout fails). */
  mode: ReviewMode;
  summary: string;
  readingOrder: string[];
  items: TriageItem[];
  omitted: OmittedHunk[];
  /** Hunk ids sent to Claude in this run (inherited hunks are not sent). */
  sentHunkIds: string[];
  warnings: string[];
  previous: { headSha: string; analyzedAt: string } | null;
  delta: ReviewDelta | null;
  cached: boolean;
  analyzedAt: string;
  costUsd: number | null;
  durationMs: number | null;
  /** Read/Grep/Glob calls Claude made (deep mode). */
  toolCalls: number | null;
}

export type ReviewStage = "fetching" | "filtering" | "checkout" | "analyzing";

export const ACTIVITY_TOOLS = ["Read", "Grep", "Glob"] as const;
export type ActivityTool = (typeof ACTIVITY_TOOLS)[number];

export interface Activity {
  tool: ActivityTool;
  /** Repo-relative path for Read, the pattern for Grep/Glob. */
  target: string;
}

export type ReviewEvent =
  | { type: "stage"; stage: ReviewStage; message: string }
  | { type: "pr"; data: PrData }
  | ({ type: "activity" } & Activity)
  | { type: "result"; data: ReviewResult }
  | { type: "error"; message: string };
