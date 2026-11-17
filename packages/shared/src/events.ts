import { z } from "zod";
import { ArtifactKindSchema } from "./artifact.js";

export const PhaseIdSchema = z.enum([
  "research",
  "design",
  "script",
  "voiceover",
  "compose",
  "render",
]);

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user.message"),
    text: z.string(),
    files: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    at: z.string(),
  }),
  z.object({ type: z.literal("phase.started"), phase: PhaseIdSchema, at: z.string() }),
  z.object({ type: z.literal("phase.progress"), phase: PhaseIdSchema, message: z.string() }),
  z.object({ type: z.literal("phase.error"), phase: PhaseIdSchema, error: z.string() }),
  z.object({ type: z.literal("gate.awaiting"), phase: PhaseIdSchema }),
  // Mid-task credit gating: the run paused because the balance can't cover the
  // next phase. The chat renders this as a buy/upgrade card; a top-up resumes
  // the same session from this phase. See the pricing/credits design spec.
  z.object({
    type: z.literal("credits.required"),
    phase: PhaseIdSchema,
    needed: z.number().int().nonnegative(),
    balance: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("credits.resumed"), phase: PhaseIdSchema }),
  z.object({ type: z.literal("artifact.created"), kind: ArtifactKindSchema, version: z.number().int().positive() }),
  z.object({ type: z.literal("artifact.stale"), kind: ArtifactKindSchema, version: z.number().int().positive() }),
  z.object({ type: z.literal("render.progress"), percent: z.number().min(0).max(100) }),
  z.object({ type: z.literal("render.done"), mp4Path: z.string() }),
  z.object({ type: z.literal("render.error"), error: z.string() }),
  z.object({ type: z.literal("agent.thinking_start"), phase: PhaseIdSchema }),
  z.object({ type: z.literal("agent.thinking"), phase: PhaseIdSchema, text: z.string() }),
  z.object({ type: z.literal("agent.text"), phase: PhaseIdSchema, text: z.string(), isFinal: z.boolean() }),
  z.object({
    type: z.literal("agent.tool_start"),
    phase: PhaseIdSchema,
    toolCallId: z.string(),
    toolName: z.string(),
    toolLabel: z.string(),
    argsSummary: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.tool_end"),
    phase: PhaseIdSchema,
    toolCallId: z.string(),
    toolName: z.string(),
    toolLabel: z.string(),
    resultSummary: z.string().optional(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal("intent.unhandled"), message: z.string() }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

/**
 * Every ServerEvent `type`, derived from the schema so it can never drift from
 * the union. The SSE transport names each frame by event type and the browser
 * EventSource only delivers a named event to a listener registered for that
 * exact name — so the web stream registers one listener per entry here. A
 * missing entry silently drops that event type on the wire (the dropped
 * `credits.required` that left the out-of-credits gate invisible).
 */
export const SERVER_EVENT_TYPES = ServerEventSchema.options.map(
  (option) => option.shape.type.value,
) as ServerEvent["type"][];

export const PHASE_IDS = PhaseIdSchema.options; // readonly ["research","design","script","voiceover","compose","render"]
export type PhaseId = z.infer<typeof PhaseIdSchema>;
