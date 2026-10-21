import type { HighlightRef, Hunk } from "@/lib/types";

export function HunkDiff({ hunk, highlight = [] }: { hunk: Hunk; highlight?: HighlightRef[] }) {
  const marked = new Set(highlight.map((h) => `${h.side}:${h.line}`));

  return (
    <div className="diff-scroll">
      <table className="diff-table">
        <tbody>
          <tr className="diff-row-hunk">
            <td className="diff-code" colSpan={3}>
              {hunk.header}
            </td>
          </tr>
          {hunk.lines.map((line, i) => {
            const isMarked =
              (line.newLine !== null && marked.has(`new:${line.newLine}`)) ||
              (line.oldLine !== null && marked.has(`old:${line.oldLine}`));
            const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
            return (
              <tr
                key={i}
                className={`diff-row-${line.type}${isMarked ? " diff-row-hl" : ""}`}
                title={isMarked ? "Claude가 짚은 줄" : undefined}
              >
                <td className="diff-num">{line.oldLine ?? ""}</td>
                <td className="diff-num">{line.newLine ?? ""}</td>
                <td className="diff-code">
                  {isMarked && <span className="sr-only">중요 줄: </span>}
                  <span className="diff-marker" aria-hidden>
                    {marker}
                  </span>
                  {line.content}
                  {line.cr && (
                    <span className="diff-eof" title="줄 끝에 CR(\r) 문자가 있음">
                      ␍
                    </span>
                  )}
                  {line.noNewline && <span className="diff-eof"> ⏎ 파일 끝 줄바꿈 없음</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
