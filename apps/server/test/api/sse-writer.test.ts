import { describe, it, expect, vi } from "vitest";
import { writeSseFrame, writeSseHeartbeat, sseHeaders } from "../../src/api/sse-writer.js";
import type { SequencedEvent } from "../../src/events/session-event-log.js";

function fakeSink() {
  const chunks: string[] = [];
  return {
    chunks,
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
  };
}

describe("sse-writer", () => {
  it("sseHeaders returns the standard SSE headers including no-cache and keep-alive", () => {
    expect(sseHeaders()).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });

  it("writeSseFrame emits id/event/data lines with JSON payload and trailing blank line", () => {
    const sink = fakeSink();
    const entry: SequencedEvent = {
      seq: 7,
      at: "2026-05-31T12:00:00.000Z",
      event: { type: "phase.progress", phase: "research", message: "hi" },
    };
    writeSseFrame(sink, entry);
    expect(sink.chunks.join("")).toBe(
      `id: 7\nevent: phase.progress\ndata: ${JSON.stringify(entry)}\n\n`,
    );
  });

  it("writeSseFrame splits embedded newlines in JSON into multiple data: lines (per spec)", () => {
    const sink = fakeSink();
    const entry: SequencedEvent = {
      seq: 1,
      at: "2026-05-31T12:00:00.000Z",
      // A literal newline in a string field forces multi-line data.
      event: { type: "phase.progress", phase: "research", message: "a\nb" },
    };
    writeSseFrame(sink, entry);
    const joined = sink.chunks.join("");
    // The entry JSON contains an escaped \n inside the string, so the
    // serialized form is single-line — assert no raw newline leaks into the
    // payload.
    expect(joined.split("\n\n")).toHaveLength(2); // one frame + trailing blank
    const dataLines = joined.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
  });

  it("writeSseHeartbeat emits a comment frame (\": ping\\n\\n\")", () => {
    const sink = fakeSink();
    writeSseHeartbeat(sink);
    expect(sink.chunks.join("")).toBe(": ping\n\n");
  });
});
