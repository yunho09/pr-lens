"use client";

import { useState } from "react";
import type { Hunk, OmittedHunk, PrFile, PrMeta } from "@/lib/types";
import { HunkDiff } from "./HunkDiff";
import { fileUrl, lineUrl, primaryLine } from "./labels";

function Stat({ file }: { file: PrFile }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-ok">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
    </span>
  );
}

/** Files the deterministic noise filter skipped, with reasons. */
export function NoiseList({ files, meta }: { files: PrFile[]; meta: PrMeta }) {
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {files.map((file) => (
        <li key={file.index} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
          <a
            href={fileUrl(meta, file)}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-all font-mono text-xs text-ink hover:text-accent hover:underline"
          >
            {file.filename}
          </a>
          <span className="text-ink-muted">
            {file.classification.kind !== "keep" ? file.classification.reason : ""}
          </span>
          <span className="ml-auto">
            <Stat file={file} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Files GitHub gave no diff for: the reviewer has to open them directly. */
export function UnavailableList({ files, meta }: { files: PrFile[]; meta: PrMeta }) {
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-attention bg-surface">
      {files.map((file) => (
        <li key={file.index} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
          <a
            href={fileUrl(meta, file)}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-all font-mono text-xs text-accent hover:underline"
          >
            {file.filename}
          </a>
          <span className="text-attention">
            {file.classification.kind === "unavailable" ? file.classification.reason : ""}
          </span>
          <span className="ml-auto">
            <Stat file={file} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface OmittedEntry {
  omitted: OmittedHunk;
  hunk: Hunk;
  file: PrFile;
}

/** Hunks left out of the Claude prompt because of the size budget. */
export function OmittedCard({ entry, meta }: { entry: OmittedEntry; meta: PrMeta }) {
  const [expanded, setExpanded] = useState(false);
  const { hunk, file, omitted } = entry;
  const target = primaryLine(null, hunk);
  return (
    <article className="overflow-hidden rounded-lg border border-l-4 border-line border-l-attention bg-surface">
      <div className="p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <a
            href={lineUrl(meta, file, target)}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-all font-mono text-xs text-accent hover:underline"
          >
            {file.filename}:{target.line}
          </a>
          <span className="text-sm text-attention">{omitted.reason}</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-xs font-medium text-ink-muted hover:text-ink"
        >
          {expanded ? "▾ 코드 접기" : `▸ 코드 보기 (${hunk.lines.length}줄)`}
        </button>
      </div>
      {expanded && <HunkDiff hunk={hunk} />}
    </article>
  );
}

/** Shown while Claude is still reading: which files are being analyzed. */
export function KeptFileList({ files }: { files: PrFile[] }) {
  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {files.map((file) => (
        <li key={file.index} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
          <span className="min-w-0 break-all font-mono text-xs text-ink">{file.filename}</span>
          <span className="text-xs text-ink-subtle">코드 조각 {file.hunks.length}개</span>
          <span className="ml-auto">
            <Stat file={file} />
          </span>
        </li>
      ))}
    </ul>
  );
}
