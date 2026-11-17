import { z } from "zod";

export const INTENTS = [
  "new-project",
  "approve",
  "refine",
  "update-brief",
  "revise-back",
  "branch",
  "abort",
  "ask",
] as const;

export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;
