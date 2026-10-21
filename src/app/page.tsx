import { Suspense } from "react";
import { PrInputForm } from "@/components/PrInputForm";
import { RecentReviews } from "@/components/RecentReviews";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-16 sm:py-24">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-ink">PR Lens</h1>
        <p className="mt-2 text-ink-muted">
          노이즈를 걸러내고, 리뷰어가 <strong className="text-ink">먼저 볼 것</strong>과{" "}
          <strong className="text-ink">건너뛰어도 될 것</strong>을 알려 주는 읽기 가이드
        </p>
      </header>

      <PrInputForm />

      <section className="mt-12" aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-3 text-sm font-semibold text-ink-muted">
          최근 분석
        </h2>
        <Suspense fallback={<p className="text-sm text-ink-subtle">불러오는 중…</p>}>
          <RecentReviews />
        </Suspense>
      </section>
    </main>
  );
}
