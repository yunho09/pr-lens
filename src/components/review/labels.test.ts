import { describe, expect, it } from "vitest";
import { META } from "@/test/fixtures";
import { blobUrl, lookAtLabel, shortDateTime } from "./labels";

describe("blobUrl", () => {
  it("links to the file at the PR head with a line anchor", () => {
    expect(blobUrl(META, { path: "src/fetch.ts", line: 12 })).toBe(
      `https://github.com/acme/app/blob/${META.headSha}/src/fetch.ts#L12`,
    );
  });

  it("omits the anchor when the line is 0", () => {
    expect(blobUrl(META, { path: "README.md", line: 0 })).toBe(`https://github.com/acme/app/blob/${META.headSha}/README.md`);
  });

  it("encodes each path segment but keeps the slashes", () => {
    expect(blobUrl(META, { path: "docs/한글 문서/#1?.md", line: 3 })).toBe(
      `https://github.com/acme/app/blob/${META.headSha}/docs/${encodeURIComponent("한글 문서")}/%231%3F.md#L3`,
    );
  });
});

describe("lookAtLabel", () => {
  it("shows path:line, or just the path for line 0", () => {
    expect(lookAtLabel({ path: "a.ts", line: 7 })).toBe("a.ts:7");
    expect(lookAtLabel({ path: "a.ts", line: 0 })).toBe("a.ts");
  });
});

describe("shortDateTime", () => {
  it("formats month/day hour:minute in local time", () => {
    expect(shortDateTime(new Date(2026, 9, 21, 14, 3).toISOString())).toBe("10/21 14:03");
    expect(shortDateTime(new Date(2026, 0, 5, 9, 0).toISOString())).toBe("1/5 09:00");
  });

  it("returns unparseable input unchanged", () => {
    expect(shortDateTime("not a date")).toBe("not a date");
  });
});
