// Client-safe GitHub PR URL parser.

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export type ParseResult = { ok: true; ref: PrRef } | { ok: false; message: string };

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TAB_SEGMENTS = new Set(["files", "commits", "checks", "changes"]);

const INVALID =
  "GitHub PR 링크 형식이 아닙니다. 예: https://github.com/owner/repo/pull/123";

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && repo !== "." && repo !== "..";
}

export function parsePrUrl(input: string): ParseResult {
  const raw = input.trim();
  if (!raw) return { ok: false, message: "PR 링크를 입력하세요." };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: INVALID };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: INVALID };
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { ok: false, message: "github.com의 PR 링크만 지원합니다." };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "pull") {
    return { ok: false, message: INVALID };
  }
  const [owner, repo, , numberText, tab, ...rest] = segments;

  if (!isValidOwner(owner) || !isValidRepo(repo)) {
    return { ok: false, message: INVALID };
  }
  if (!/^[1-9]\d{0,9}$/.test(numberText)) {
    return { ok: false, message: "PR 번호가 올바르지 않습니다." };
  }
  if (tab !== undefined && !TAB_SEGMENTS.has(tab)) {
    return { ok: false, message: INVALID };
  }
  // Only /commits/<sha> and /files/<range> may carry one extra segment.
  if (rest.length > 1 || (rest.length === 1 && tab !== "commits" && tab !== "files")) {
    return { ok: false, message: INVALID };
  }

  return { ok: true, ref: { owner, repo, number: Number(numberText) } };
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
