import type { Category, DiffLine, HighlightRef, Hunk, LookAt, PrFile, PrMeta, TriageItem } from "@/lib/types";

export const CATEGORY_LABEL: Record<Category, string> = {
  logic: "로직",
  security: "보안",
  "api-contract": "API 계약",
  data: "데이터",
  "error-handling": "에러 처리",
  concurrency: "동시성",
  performance: "성능",
  test: "테스트",
  config: "설정",
  refactor: "리팩터링",
  style: "스타일",
  docs: "문서",
};

export function fileUrl(meta: PrMeta, file: PrFile): string {
  return `${meta.htmlUrl}/files#diff-${file.anchor}`;
}

export function lineUrl(meta: PrMeta, file: PrFile, ref: HighlightRef): string {
  return `${fileUrl(meta, file)}${ref.side === "new" ? "R" : "L"}${ref.line}`;
}

/** File at the PR head on GitHub, each path segment URI-encoded. */
export function blobUrl(meta: PrMeta, entry: Pick<LookAt, "path" | "line">): string {
  const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${meta.owner}/${meta.repo}/blob/${meta.headSha}/${encoded}${entry.line > 0 ? `#L${entry.line}` : ""}`;
}

export function lookAtLabel(entry: Pick<LookAt, "path" | "line">): string {
  return entry.line > 0 ? `${entry.path}:${entry.line}` : entry.path;
}

/** "10/21 14:03" in local time, for the incremental banner. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The line a card links to: first highlight, else the first changed line. */
export function primaryLine(item: Pick<TriageItem, "highlight"> | null, hunk: Hunk): HighlightRef {
  if (item?.highlight[0]) return item.highlight[0];
  const change = hunk.lines.find((l: DiffLine) => l.type !== "context");
  if (change?.type === "add" && change.newLine !== null) return { side: "new", line: change.newLine };
  if (change?.type === "del" && change.oldLine !== null) return { side: "old", line: change.oldLine };
  return { side: "new", line: hunk.newStart };
}
