import { createHash } from "node:crypto";
import type { DiffLine } from "./types";

/**
 * sha1 of `path + "\n" + the +/- lines` (prefix and exact content). Context
 * lines and line numbers are excluded, so a hunk that only moved keeps its
 * fingerprint while any edit to its changed lines produces a new one.
 * Content only: the same edit in another function has the same fingerprint,
 * so it is eval ground truth, not an identity for inheritance (hunkAnchorKey).
 */
export function hunkFingerprint(path: string, hunk: { lines: DiffLine[] }): string {
  const changed = hunk.lines
    .filter((l) => l.type !== "context")
    .map((l) => `${l.type === "add" ? "+" : "-"}${l.content}`)
    .join("\n");
  return createHash("sha1").update(`${path}\n${changed}`).digest("hex");
}

const ANCHOR_CONTEXT = 3;

/**
 * Position-aware identity of a hunk, for inheriting a classification and for
 * 봤음: sha1 of the path, the @@ section text (the enclosing function), up to 3
 * context lines before and after the change, and everything from the first to
 * the last changed line. Line numbers are excluded, so a hunk that only moved
 * keeps its key, but the same edit in another function or next to other code
 * gets a new one. A CR or a missing final newline is part of the key: in shell
 * or Makefile code they change behaviour, so such an edit is never inherited.
 */
export function hunkAnchorKey(path: string, hunk: { section?: string; lines: DiffLine[] }): string {
  const { lines } = hunk;
  const changed = lines.flatMap((l, i) => (l.type === "context" ? [] : [i]));
  const span =
    changed.length === 0
      ? []
      : lines.slice(Math.max(0, changed[0] - ANCHOR_CONTEXT), changed[changed.length - 1] + 1 + ANCHOR_CONTEXT);
  const body = span
    .map((l) => {
      const marker = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      return `${marker}${l.content}${l.cr ? "\r" : ""}${l.noNewline ? "\n\\" : ""}`;
    })
    .join("\n");
  const section = (hunk.section ?? "").replace(/\r/g, "");
  return createHash("sha1").update(`${path}\n${section}\n${body}`).digest("hex");
}
