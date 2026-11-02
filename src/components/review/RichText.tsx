import { Fragment } from "react";
import { splitInlineCode } from "./labels";

/** Prose with `code` spans. Renders React text only, never HTML: PR-derived text is untrusted. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((segment, i) =>
        segment.kind === "code" ? (
          <code key={i} className="inline-code">
            {segment.value}
          </code>
        ) : (
          <Fragment key={i}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}
