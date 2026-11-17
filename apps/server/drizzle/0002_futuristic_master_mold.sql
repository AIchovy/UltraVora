CREATE TABLE "artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"derived_from" jsonb,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_creator_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."creator_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_creator_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."creator_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_session_id_kind_version_key" ON "artifacts" USING btree ("session_id","kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_id_seq_key" ON "session_events" USING btree ("session_id","seq");