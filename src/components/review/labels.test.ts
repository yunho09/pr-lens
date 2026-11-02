import { describe, expect, it } from "vitest";
import { META } from "@/test/fixtures";
import { blobUrl, shortDateTime, splitInlineCode } from "./labels";

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

describe("splitInlineCode", () => {
  const text = (value: string) => ({ kind: "text", value });
  const code = (value: string) => ({ kind: "code", value });

  it("returns plain text as one segment, and nothing for an empty string", () => {
    expect(splitInlineCode("코드 없음")).toEqual([text("코드 없음")]);
    expect(splitInlineCode("")).toEqual([]);
  });

  it("splits backtick pairs into code segments", () => {
    expect(splitInlineCode("`feedDate`는 `date-time` 형식")).toEqual([
      code("feedDate"),
      text("는 "),
      code("date-time"),
      text(" 형식"),
    ]);
  });

  it("adds no empty text segment at the edges or between adjacent spans", () => {
    expect(splitInlineCode("`a``b`")).toEqual([code("a"), code("b")]);
  });

  it("keeps an unbalanced backtick literal", () => {
    expect(splitInlineCode("a `b` c `d")).toEqual([text("a "), code("b"), text(" c `d")]);
    expect(splitInlineCode("`")).toEqual([text("`")]);
  });

  it("keeps an empty or blank pair literal without shifting later pairs", () => {
    expect(splitInlineCode("a `` b `c` d")).toEqual([text("a `` b "), code("c"), text(" d")]);
    expect(splitInlineCode("a ` ` b")).toEqual([text("a ` ` b")]);
  });

  it("keeps the code exactly as written, markup included", () => {
    expect(splitInlineCode("`<img src=x onerror=alert(1)> != a`")).toEqual([code("<img src=x onerror=alert(1)> != a")]);
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
