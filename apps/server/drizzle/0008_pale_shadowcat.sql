ALTER TABLE "creator_sessions" ADD COLUMN "run_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD COLUMN "pending_refinement" text;