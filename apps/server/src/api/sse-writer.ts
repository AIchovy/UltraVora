import type { SequencedEvent } from "../events/session-event-log.js";

export interface SseSink {
  write(chunk: string): boolean;
}

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx, etc.) so events flush immediately.
    "X-Accel-Buffering": "no",
  };
}

export function writeSseFrame(sink: SseSink, entry: SequencedEvent): void {
  const payload = JSON.stringify(entry);
  sink.write(`id: ${entry.seq}\nevent: ${entry.event.type}\ndata: ${payload}\n\n`);
}

export function writeSseHeartbeat(sink: SseSink): void {
  sink.write(": ping\n\n");
}
