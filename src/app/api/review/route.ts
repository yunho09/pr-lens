import { z } from "zod";
import { runReview } from "@/lib/pipeline";
import type { ReviewEvent } from "@/lib/types";
import { checkReviewRequest } from "./guard";

// POST handlers always run per request on the Node.js runtime. With Cache
// Components enabled (next.config.ts), the `runtime`/`dynamic` segment exports
// are not allowed, so none are declared here.

const bodySchema = z.object({
  url: z.string().min(1).max(2000),
  refresh: z.boolean().optional(),
  mode: z.enum(["deep", "fast"]).optional(),
  cacheOnly: z.boolean().optional(),
});

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

function line(event: ReviewEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(request: Request) {
  const guard = checkReviewRequest(request.headers);
  if (!guard.ok) {
    return new Response(line({ type: "error", message: guard.message }), { status: guard.status, headers: NDJSON_HEADERS });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(line({ type: "error", message: "요청 형식이 올바르지 않습니다. { url, refresh?, mode?: \"deep\" | \"fast\", cacheOnly? } 를 보내세요." }), {
      status: 400,
      headers: NDJSON_HEADERS,
    });
  }

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ReviewEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line(event)));
        } catch {
          closed = true;
        }
      };
      try {
        await runReview(
          {
            url: parsed.data.url,
            refresh: parsed.data.refresh ?? false,
            mode: parsed.data.mode ?? "deep",
            cacheOnly: parsed.data.cacheOnly ?? false,
          },
          emit,
          abort.signal,
        );
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a cancelled client.
          }
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
