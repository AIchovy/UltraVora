import { z } from "zod";
import { PhaseIdSchema } from "./events.js";

export const SESSION_STATUSES = [
  "idle",
  "running",
  "awaiting-gate",
  "awaiting-credits",
  "error",
  "done",
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Sidebar/list row for one of the current user's sessions. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: SessionStatusSchema,
  currentPhase: PhaseIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
