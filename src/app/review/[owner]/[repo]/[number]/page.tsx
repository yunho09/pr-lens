import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { shouldAutoStart } from "@/app/api/review/guard";
import { ReviewView } from "@/components/review/ReviewView";
import { isValidOwner, isValidRepo } from "@/lib/github-url";
import type { ReviewMode } from "@/lib/types";

type Params = { owner: string; repo: string; number: string };
type SearchParams = { mode?: string | string[] };

function InvalidRoute() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <p role="alert" className="rounded-lg border border-danger bg-danger-soft p-4 text-sm text-ink">
        잘못된 PR 주소입니다. <Link href="/" className="font-semibold text-accent underline">처음으로</Link>
      </p>
    </main>
  );
}

async function ReviewRoute({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const [{ owner, repo, number }, query, requestHeaders] = await Promise.all([params, searchParams, headers()]);
  if (!isValidOwner(owner) || !isValidRepo(repo) || !/^[1-9]\d{0,9}$/.test(number)) {
    return <InvalidRoute />;
  }
  const mode: ReviewMode = query.mode === "fast" ? "fast" : "deep";
  return (
    <ReviewView
      owner={owner}
      repo={repo}
      number={Number(number)}
      initialMode={mode}
      autoStart={shouldAutoStart(requestHeaders.get("sec-fetch-site"), requestHeaders.get("sec-fetch-dest"))}
    />
  );
}

export default function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  // Params are request-time data under Cache Components, so they resolve inside Suspense.
  return (
    <Suspense fallback={<p className="mx-auto w-full max-w-6xl px-4 py-6 text-sm text-ink-subtle">불러오는 중…</p>}>
      <ReviewRoute params={params} searchParams={searchParams} />
    </Suspense>
  );
}
