// Request checks. The app is local-only, but a page on any other site the
// owner visits could otherwise make the browser POST here (CSRF), frame it
// (clickjacking), or reach it through a DNS-rebinding domain with a foreign Host.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export const HOST_REJECTED_MESSAGE = "localhost 또는 127.0.0.1로 접속한 요청만 받습니다.";

export type GuardResult = { ok: true } | { ok: false; status: number; message: string };

function hostname(hostHeader: string): string | null {
  // "localhost:3000", "127.0.0.1", "[::1]:3000"
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim().toLowerCase());
  return m ? m[1] : null;
}

/** Host header is localhost or 127.0.0.1 (any port). Used by proxy.ts for every route. */
export function isAllowedHost(hostHeader: string | null): boolean {
  const host = hostHeader?.trim() ?? "";
  const name = host ? hostname(host) : null;
  return name !== null && LOCAL_HOSTNAMES.has(name);
}

export function checkReviewRequest(headers: Headers): GuardResult {
  if (!isAllowedHost(headers.get("host"))) {
    return { ok: false, status: 403, message: HOST_REJECTED_MESSAGE };
  }
  const host = headers.get("host")!.trim().toLowerCase();

  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") originHost = url.host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (originHost !== host) {
      return { ok: false, status: 403, message: "다른 사이트에서 보낸 요청은 받지 않습니다." };
    }
  }

  const contentType = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, message: "Content-Type: application/json 요청만 받습니다." };
  }

  return { ok: true };
}

/**
 * Whether the review page may start a (paid) analysis on load: only when the
 * user got there from inside this app (the home form or the recent list).
 *
 * Sec-Fetch-Site must be "same-origin". A typed URL, a bookmark or a link
 * clicked in a desktop app (Discord, Slack, mail) all arrive as "none", and a
 * browser without Fetch Metadata sends nothing, so none of those can be told
 * apart from an attacker's link: they show the cached result or wait for a
 * click on 분석 시작. Other sites and other local ports never auto-start.
 *
 * Sec-Fetch-Dest: "document", "empty" (this app's client-side navigation, an
 * RSC fetch) or absent. Frames, objects and embeds never start.
 */
export function shouldAutoStart(secFetchSite: string | null, secFetchDest: string | null = null): boolean {
  const site = secFetchSite?.trim().toLowerCase() ?? null;
  const dest = secFetchDest?.trim().toLowerCase() ?? null;
  const topLevel = dest === null || dest === "document" || dest === "empty";
  return site === "same-origin" && topLevel;
}

/** Sent on every response (next.config.ts headers and proxy.ts rejections). */
export const ANTI_FRAMING_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];
