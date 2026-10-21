import { describe, expect, it } from "vitest";
import { readNdjson } from "./ndjson";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("readNdjson", () => {
  it("parses values split across chunk boundaries, including multi-byte characters", async () => {
    const values: unknown[] = [];
    const text = '{"type":"stage","message":"가져오는 중"}\n{"type":"result","data":{"n":1}}\n';
    const bytes = new TextEncoder().encode(text);
    // Split in the middle of a Hangul character's UTF-8 bytes.
    const cut = 28;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    await readNdjson(stream, (v) => values.push(v));
    expect(values).toEqual([
      { type: "stage", message: "가져오는 중" },
      { type: "result", data: { n: 1 } },
    ]);
  });

  it("handles a final line without a trailing newline and skips blank lines", async () => {
    const values: unknown[] = [];
    await readNdjson(streamOf(['{"a":1}\n\n', '{"b":2}']), (v) => values.push(v));
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
