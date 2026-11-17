import { z } from "zod";
import { ConstraintsSchema } from "./constraints.js";

/** A user-uploaded image the message refers to by an @label (e.g. @logo, @image1). */
export const AssetRefSchema = z.object({
  label: z.string(),
  path: z.string(),
  role: z.enum(["logo", "image"]),
});

export const UserMessageSchema = z.object({
  text: z.string(),
  uploadedFiles: z.array(z.string()).optional(),
  assets: z.array(AssetRefSchema).optional(),
  constraints: ConstraintsSchema.optional(),
  /**
   * Client-generated correlation id. Echoed back on the `user.message` event so
   * the web client can dedupe its optimistic bubble against the replayed one.
   */
  clientId: z.string().optional(),
});

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
