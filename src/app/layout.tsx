import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Lens",
  description: "리뷰어를 위한 PR 읽기 가이드 — 먼저 볼 것과 건너뛸 것을 골라 줍니다.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
