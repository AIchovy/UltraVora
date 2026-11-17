// Credits & billing tables. The ledger is the append-only source of truth; the
// balance row is a cached scalar updated in the same transaction. The unique
// idempotency_key enforces "apply each grant/debit at most once" at the DB
// level, which is what makes resume-after-top-up safe (no double charge).
import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  bigserial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const creditBalance = pgTable("credit_balance", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // `balance` is the maintained total = subscription + bonus + purchased.
  balance: integer("balance").notNull().default(0),
  // Subscription credits reset to the plan's monthly grant each period (do NOT
  // roll over); bonus (signup) and purchased credits persist. Consumption draws
  // subscription → bonus → purchased so the expiring bucket is spent first.
  subscriptionCredits: integer("subscription_credits").notNull().default(0),
  bonusCredits: integer("bonus_credits").notNull().default(0),
  purchasedCredits: integer("purchased_credits").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Positive = grant/purchase/refund; negative = consumption.
    delta: integer("delta").notNull(),
    // signup_bonus | subscription_grant | purchase | consumption | refund | adjustment
    reason: text("reason").notNull(),
    // Free-form provenance: { sessionId, phase } for consumption; { pack, usd } or
    // { subscriptionId, period } for grants.
    ref: jsonb("ref"),
    // Globally unique — the same key applied twice is a no-op (idempotency).
    idempotencyKey: text("idempotency_key").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    idempotencyKeyKey: uniqueIndex("credit_ledger_idempotency_key_key").on(t.idempotencyKey),
    userCreatedIdx: index("credit_ledger_user_id_created_at_idx").on(t.userId, t.createdAt),
  }),
);

export const subscription = pgTable("subscription", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  tier: text("tier").notNull(), // free | pro | max | ultra
  status: text("status").notNull(), // active | canceled | past_due
  interval: text("interval").notNull(), // monthly | yearly
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // Payment-provider linkage (Creem) — unused until the provider is wired up.
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
