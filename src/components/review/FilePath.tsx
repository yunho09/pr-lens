import { Fragment } from "react";

/** A path that wraps at slashes. The basename keeps the parent's colour, so it still reads as a link inside one. */
export function FilePath({ path, line }: { path: string; line?: number }) {
  const dirs = path.split("/");
  const base = dirs.pop();
  return (
    <span className="font-mono">
      {dirs.map((dir, i) => (
        <Fragment key={i}>
          <span className="text-ink-muted">{dir}/</span>
          <wbr />
        </Fragment>
      ))}
      <span className="font-semibold">{base}</span>
      {line !== undefined && line > 0 && <span className="text-ink-muted">:{line}</span>}
    </span>
  );
}
