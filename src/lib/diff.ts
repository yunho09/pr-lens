import type { DiffLine, ParsedHunk } from "./types";

// The section text (the enclosing function line) may hold any character, including CR, U+2028 and U+2029.
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?([\s\S]*)$/;

export function hunkId(fileIndex: number, hunkIndex: number): string {
  return `f${fileIndex}h${hunkIndex}`;
}

/**
 * Parses a GitHub `patch` (unified diff body without the ---/+++ file headers)
 * into hunks with old/new line numbers.
 *
 * Fails closed: an `@@` line that is not a valid hunk header, or text before
 * the first hunk, yields no hunks at all, never a silently partial diff.
 * classifyFile then sends the file to 확인 필요 (a patch with no hunks).
 */
export function parsePatch(patch: string, fileIndex: number): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const rawLines = patch.split("\n");
  // A trailing "\n" yields one empty string at the end that is not a diff line.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  for (const raw of rawLines) {
    // CRLF files end every line in a CR: keep it as a flag so the content stays comparable.
    const cr = raw.endsWith("\r");
    const line = cr ? raw.slice(0, -1) : raw;
    const header = line.startsWith("@@") ? HUNK_HEADER_RE.exec(line) : null;
    if (line.startsWith("@@") && !header) return [];
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = {
        id: hunkId(fileIndex, hunks.length),
        header: line,
        oldStart: oldLine,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newLine,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5]?.trim() ?? "",
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) return [];

    const marker = line[0];
    let parsed: DiffLine;
    if (marker === "\\") {
      const prev = current.lines[current.lines.length - 1];
      if (prev) prev.noNewline = true;
      continue;
    } else if (marker === "+") {
      parsed = { type: "add", content: line.slice(1), oldLine: null, newLine: newLine++ };
    } else if (marker === "-") {
      parsed = { type: "del", content: line.slice(1), oldLine: oldLine++, newLine: null };
    } else {
      // " " context line; a bare empty line is a context line whose space was stripped.
      parsed = {
        type: "context",
        content: marker === " " ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      };
    }
    if (cr) parsed.cr = true;
    current.lines.push(parsed);
  }

  return hunks;
}

/** Real line-number range present in a hunk for one side, or null if that side has no lines. */
export function hunkSideRange(hunk: Pick<ParsedHunk, "lines">, side: "old" | "new"): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const l of hunk.lines) {
    const n = side === "old" ? l.oldLine : l.newLine;
    if (n === null) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return min === Infinity ? null : [min, max];
}
