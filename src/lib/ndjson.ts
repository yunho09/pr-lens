// Client-safe NDJSON stream reader.

export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onValue: (value: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) onValue(JSON.parse(trimmed));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      flushLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  flushLine(buffer + decoder.decode());
}
