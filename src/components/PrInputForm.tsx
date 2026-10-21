"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { parsePrUrl } from "@/lib/github-url";

export function PrInputForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [deep, setDeep] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parsePrUrl(value);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    const { owner, repo, number } = parsed.ref;
    startTransition(() => router.push(`/review/${owner}/${repo}/${number}${deep ? "" : "?mode=fast"}`));
  }

  return (
    <form onSubmit={onSubmit} className="w-full" noValidate>
      <label htmlFor="pr-url" className="sr-only">
        GitHub PR 링크
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="pr-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="PR 링크를 붙여넣으세요"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "pr-url-error" : "pr-url-hint"}
          className="h-12 min-w-0 flex-1 rounded-lg border border-line bg-surface px-4 text-base text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-12 shrink-0 rounded-lg bg-accent px-6 font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "여는 중…" : "읽기 가이드 만들기"}
        </button>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={deep}
          onChange={(e) => setDeep(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />
        <span>
          깊게 보기 (주변 코드 읽기)
          <span className="block text-xs text-ink-subtle sm:ml-1.5 sm:inline">
            레포를 내려받아 호출부·정의·테스트까지 확인 · 더 느리고 비쌈
          </span>
        </span>
      </label>
      {error ? (
        <p id="pr-url-error" role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : (
        <p id="pr-url-hint" className="mt-2 text-sm text-ink-subtle">
          예: https://github.com/vercel/swr/pull/1234 — /files, 쿼리, # 붙은 링크도 됩니다.
        </p>
      )}
    </form>
  );
}
