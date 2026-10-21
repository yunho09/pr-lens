import { NextResponse, type NextRequest } from "next/server";
import { ANTI_FRAMING_HEADERS, HOST_REJECTED_MESSAGE, isAllowedHost } from "@/app/api/review/guard";

// Runs before every route (pages, API, static assets). Rejects any Host other
// than localhost / 127.0.0.1 so a DNS-rebinding domain that resolves to this
// machine cannot read pages such as `/`, which lists private PR titles.
export function proxy(request: NextRequest) {
  if (isAllowedHost(request.headers.get("host"))) return NextResponse.next();
  const response = new NextResponse(HOST_REJECTED_MESSAGE, {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
  for (const { key, value } of ANTI_FRAMING_HEADERS) response.headers.set(key, value);
  return response;
}
