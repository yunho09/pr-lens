// Client-safe display helpers.

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatCost(usd: number | null): string | null {
  if (usd === null) return null;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatSeconds(ms: number | null): string | null {
  if (ms === null) return null;
  return `${Math.round(ms / 1000)}초`;
}
