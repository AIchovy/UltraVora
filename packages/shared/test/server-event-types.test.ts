import { describe, expect, test } from "vitest";
import { SERVER_EVENT_TYPES, ServerEventSchema } from "../src/events.js";

describe("SERVER_EVENT_TYPES", () => {
  // The SSE transport names every frame by event type, and the browser
  // EventSource only delivers a named event to a listener registered for that
  // exact name. The web stream registers one listener per entry in this list,
  // so it MUST cover the whole ServerEvent union or frames are silently dropped
  // (the `credits.required` drop that left "out of credits" invisible).
  test("covers every ServerEvent type, with no drift from the schema", () => {
    const fromSchema = ServerEventSchema.options
      .map((o) => o.shape.type.value as string)
      .sort();
    expect([...SERVER_EVENT_TYPES].sort()).toEqual(fromSchema);
  });

  test("includes the credit + intent notice events that were being dropped", () => {
    expect(SERVER_EVENT_TYPES).toContain("credits.required");
    expect(SERVER_EVENT_TYPES).toContain("credits.resumed");
    expect(SERVER_EVENT_TYPES).toContain("intent.unhandled");
  });
});
