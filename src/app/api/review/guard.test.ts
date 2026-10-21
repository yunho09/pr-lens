import { describe, expect, it } from "vitest";
import { checkReviewRequest, isAllowedHost, shouldAutoStart } from "./guard";

function h(values: Record<string, string>): Headers {
  return new Headers(values);
}
const JSON_CT = { "content-type": "application/json" };

describe("checkReviewRequest", () => {
  it.each(["localhost:3000", "127.0.0.1:3917", "localhost", "LOCALHOST:80"])("accepts Host %s without Origin", (host) => {
    expect(checkReviewRequest(h({ host, ...JSON_CT }))).toEqual({ ok: true });
  });

  it("accepts a same-host Origin and a charset parameter", () => {
    expect(
      checkReviewRequest(h({ host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json; charset=utf-8" })),
    ).toEqual({ ok: true });
  });

  it.each(["evil.example:3000", "192.168.1.10:3000", "localhost.evil.com", "[::1]:3000", ""])("rejects Host %j", (host) => {
    const headers = host ? h({ host, ...JSON_CT }) : h(JSON_CT);
    expect(checkReviewRequest(headers)).toMatchObject({ ok: false, status: 403 });
  });

  it.each(["https://evil.example", "http://localhost:3001", "http://127.0.0.1:3000", "null", "file://x"])(
    "rejects cross-origin Origin %s",
    (origin) => {
      expect(checkReviewRequest(h({ host: "localhost:3000", origin, ...JSON_CT }))).toMatchObject({ ok: false, status: 403 });
    },
  );

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
    "rejects Content-Type %s (no preflight-free requests)",
    (contentType) => {
      const headers = h(contentType ? { host: "localhost:3000", "content-type": contentType } : { host: "localhost:3000" });
      expect(checkReviewRequest(headers)).toMatchObject({ ok: false, status: 415 });
    },
  );
});

describe("shouldAutoStart (Sec-Fetch-Site / Sec-Fetch-Dest of the review page request)", () => {
  it.each([
    [null, null, true],
    ["none", null, true],
    ["none", "document", true],
    ["same-origin", "document", true],
    ["same-origin", "empty", true], // the app's own client-side navigation (RSC fetch)
    ["same-site", "document", false],
    ["cross-site", "document", false],
    ["cross-site", null, false],
    ["none", "iframe", false],
    ["same-origin", "iframe", false],
    ["same-origin", "frame", false],
    ["same-origin", "object", false],
    ["same-origin", "embed", false],
    ["cross-site", "empty", false],
    ["none", "empty", false],
  ] as const)("site=%s dest=%s → %s", (site, dest, expected) => {
    expect(shouldAutoStart(site, dest)).toBe(expected);
  });
});

describe("isAllowedHost (proxy.ts, every route)", () => {
  it.each(["localhost:3000", "127.0.0.1:3917", "localhost", "LOCALHOST:80"])("allows %s", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });
  it.each(["rebind.attacker.example:3000", "localhost.evil.com", "127.0.0.1.nip.io", "[::1]:3000", "", null])(
    "rejects %j",
    (host) => {
      expect(isAllowedHost(host)).toBe(false);
    },
  );
});
