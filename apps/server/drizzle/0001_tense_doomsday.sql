CREATE TABLE "creator_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"current_phase" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD CONSTRAINT "creator_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_sessions_user_id_updated_at_idx" ON "creator_sessions" USING btree ("user_id","updated_at");