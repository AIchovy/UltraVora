ALTER TABLE "credit_balance" ADD COLUMN "subscription_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_balance" ADD COLUMN "bonus_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_balance" ADD COLUMN "purchased_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: existing (pre-bucket) balances are treated as persistent purchased credits.
UPDATE "credit_balance" SET "purchased_credits" = "balance" WHERE "balance" <> 0;