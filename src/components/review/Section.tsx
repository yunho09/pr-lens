"use client";

import type { ReactNode } from "react";

interface SectionProps {
  id: string;
  icon: string;
  title: string;
  count: number;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function Section({ id, icon, title, count, description, open, onToggle, children }: SectionProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col">
      <h2 id={`${id}-heading`} className="text-base font-semibold text-ink">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className="flex w-full items-center gap-2 rounded-md py-1 text-left hover:text-accent"
        >
          <span aria-hidden>{icon}</span>
          <span>{title}</span>
          <span className="rounded-full bg-skim-soft px-2 py-0.5 text-xs font-semibold text-ink-muted">{count}</span>
          <span className="ml-auto text-xs font-normal text-ink-subtle">{open ? "접기" : "펼치기"}</span>
        </button>
      </h2>
      {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
      <div id={`${id}-body`} hidden={!open} className="mt-3 flex flex-col gap-3">
        {open && children}
      </div>
    </section>
  );
}
