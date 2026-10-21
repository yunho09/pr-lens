import Link from "next/link";
import { connection } from "next/server";
import { listRecentReviews } from "@/lib/cache";
import { formatDateTime } from "@/lib/format";

export async function RecentReviews() {
  // Read the cache directory on every request, never at build time.
  await connection();
  const reviews = await listRecentReviews(20);

  if (reviews.length === 0) {
    return <p className="text-sm text-ink-subtle">아직 분석한 PR이 없습니다.</p>;
  }

  return (
    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
      {reviews.map((r) => (
        <li key={`${r.owner}/${r.repo}#${r.number}`}>
          <Link
            href={`/review/${r.owner}/${r.repo}/${r.number}${r.mode === "fast" ? "?mode=fast" : ""}`}
            className="flex flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-baseline sm:gap-3"
          >
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{r.title}</span>
            <span className="shrink-0 font-mono text-xs text-ink-muted">
              {r.owner}/{r.repo}#{r.number}
            </span>
            <span className="shrink-0 text-xs text-ink-subtle">
              {r.mode === "deep" ? "깊게 · " : "빠르게 · "}
              {formatDateTime(r.analyzedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
