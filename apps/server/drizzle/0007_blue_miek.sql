CREATE TABLE "video_likes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD COLUMN "product_url" text;--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD COLUMN "free_grant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_sessions" ADD COLUMN "like_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "video_likes" ADD CONSTRAINT "video_likes_session_id_creator_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."creator_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_likes" ADD CONSTRAINT "video_likes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_likes_session_id_user_id_key" ON "video_likes" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "creator_sessions_public_created_at_idx" ON "creator_sessions" USING btree ("is_public","created_at");--> statement-breakpoint
CREATE INDEX "creator_sessions_public_like_count_idx" ON "creator_sessions" USING btree ("is_public","like_count");