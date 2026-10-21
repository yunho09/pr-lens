import { describe, expect, it } from "vitest";
import { parsePrUrl, prUrl } from "./github-url";

const ref = { owner: "vercel", repo: "swr", number: 4012 };

describe("parsePrUrl", () => {
  it.each([
    "https://github.com/vercel/swr/pull/4012",
    "https://github.com/vercel/swr/pull/4012/",
    "https://github.com/vercel/swr/pull/4012/files",
    "https://github.com/vercel/swr/pull/4012/commits",
    "https://github.com/vercel/swr/pull/4012/commits/0123abc",
    "https://github.com/vercel/swr/pull/4012/checks",
    "https://github.com/vercel/swr/pull/4012?diff=split",
    "https://github.com/vercel/swr/pull/4012#discussion_r1",
    "https://github.com/vercel/swr/pull/4012/files?w=1#diff-abc",
    "github.com/vercel/swr/pull/4012",
    "www.github.com/vercel/swr/pull/4012",
    "http://github.com/vercel/swr/pull/4012",
    "  https://github.com/vercel/swr/pull/4012  ",
    "HTTPS://GITHUB.COM/vercel/swr/pull/4012",
  ])("accepts %s", (input) => {
    expect(parsePrUrl(input)).toEqual({ ok: true, ref });
  });

  it("keeps dots, dashes and underscores in repo names", () => {
    expect(parsePrUrl("https://github.com/sindre-sorhus/ky.js_x/pull/7")).toEqual({
      ok: true,
      ref: { owner: "sindre-sorhus", repo: "ky.js_x", number: 7 },
    });
  });

  it.each([
    "",
    "   ",
    "https://gitlab.com/vercel/swr/pull/4012",
    "https://github.com.evil.com/vercel/swr/pull/4012",
    "https://github.com/vercel/swr/issues/4012",
    "https://github.com/vercel/swr/pulls/4012",
    "https://github.com/vercel/swr/pull/",
    "https://github.com/vercel/swr/pull/abc",
    "https://github.com/vercel/swr/pull/0",
    "https://github.com/vercel/swr/pull/-1",
    "https://github.com/vercel/swr",
    "https://github.com/vercel/swr/pull/4012/blob",
    "https://github.com/vercel/swr/pull/4012/files/a/b",
    "https://github.com/-bad/swr/pull/1",
    "https://github.com/vercel/../pull/1",
    "ftp://github.com/vercel/swr/pull/1",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %j with a Korean message", (input) => {
    const result = parsePrUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/[가-힣]/);
  });

  it("round-trips through prUrl", () => {
    expect(parsePrUrl(prUrl(ref))).toEqual({ ok: true, ref });
  });
});
