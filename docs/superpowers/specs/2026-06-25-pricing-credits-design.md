# Pricing, Credits & Mid-Task Credit Gating — Design

Date: 2026-06-25
Status: Draft for review

## 1. Goal

Add monetization to UltraVora (prompt → finished promo video):

1. **Landing-page pricing** section + a shared pricing/purchase modal.
2. **In-app credits widget** (top-right) showing balance + subscription, with an
   "Upgrade" → pricing modal flow and a "Buy credits" flow.
3. A **credits economy**: subscriptions (Free/Pro/Max/Ultra, monthly or yearly)
   and standalone credit purchases.
4. **Per-operation credit consumption** wired into the generation pipeline.
5. **Mid-task credit gating**: if a run exhausts credits mid-generation, the
   session **pauses without losing work**, the chat shows an upgrade/buy prompt,
   and after a top-up the **same task resumes from where it stopped**.

Everything here is greenfield — there is no billing/credits/subscription code today.

## 2. Cost basis (why the numbers are what they are)

Verified per-video cost (see memory `video-cost-model`; live model is **Gemini
3.1 Pro**, not the repo-default Opus):

- LLM (Gemini 3.1 Pro): ~$0.85 — compose is the heavy phase
- Gemini media (4 images + 5 TTS + 1 Lyria music): ~$0.45 (a hard floor)
- Render (local headless-Chrome + FFmpeg, no GPU) + GCS: ~$0.05
- **Total ≈ $1.35 per typical 1-min / 5-scene video** (plan around $1.50)

Lever: routing the brain to DeepSeek V4 Pro / Gemini 3.5 Flash cuts total to
~$0.70/video, lifting all margins ~20pts. Cost is **not metered to the user** —
credits are a fixed menu (below); this just sets the menu's margin.

## 3. Credit unit & purchases

**1 USD = 100 credits** ($0.01/credit). Purchased credits **never expire**.

Standalone credit packs (one-time):

| Pack | Price | Credits |
|---|---|---|
| Pack 1 | $20 | 2,000 |
| Pack 2 | $50 | 5,000 |
| Pack 3 | $100 | 10,000 |
| Custom | $5 – $1,000 | price × 100 (max 100,000) |

## 4. Subscription tiers

Monthly credits **refresh each month** (subscription credits do **not** roll
over; purchased credits do). Yearly billing = **−20%**.

| Tier | Monthly | Yearly (−20%) | Credits/mo | credits/$ | ≈ videos/mo |
|---|---|---|---|---|---|
| **Free** | $0 | — | **200 one-time signup bonus only** (no refresh) | — | ~½ video to try |
| **Pro** | $20 | $192/yr ($16/mo) | 3,000 | 150 | ~7 |
| **Max** | $40 | $384/yr ($32/mo) | 7,000 | 175 | ~17 |
| **Ultra** | $200 | $1,920/yr ($160/mo) | 40,000 | 200 | ~100 |

`credits/$` ladder rises with commitment (buy 100/$ → Pro 150 → Max 175 →
Ultra 200) to reward subscribing and upgrading. Plan catalog lives in
`packages/shared` so web + server share one source of truth.

> Free's 200-credit signup bonus is **less than one full video (~400)** by
> design — enough to start and see value, then hit the gate (§6). This is the
> primary acquisition→paywall moment.

## 5. Credit consumption menu

Charged **per operation** as the pipeline runs (fixed prices, not metered):

| Operation | Credits | When |
|---|---|---|
| Research + brief | 60 | research phase |
| Script | 10 | script phase |
| Visual design (base) | 15 | design phase |
| Generated image (each) | 20 | design/compose, per image |
| Voiceover (per narrated scene) | 10 | voiceover phase, per scene |
| Background music | 25 | compose phase (if BGM on) |
| Animation & assembly (compose, base) | 160 | compose phase |
| Render & export | 15 | render phase |

Typical 1-min / 5-scene / 4-image / BGM video = 60+10+15+(4×20)+(5×10)+25+160+15
= **~415 ≈ 400 credits** (≈ $4 retail vs ~$1.35 cost → ~3× markup / ~67%
margin). Shorter/simpler videos cost proportionally less.

## 6. Mid-task credit gating (the core mechanism)

### 6.1 Principle
Bill **per billable operation, check-before-run**. Never run an op we can't
charge for; never charge for an op that didn't run. When the next op is
unaffordable, **park the session** (durable) and prompt the user. After a
top-up, **resume from the parked op** — completed phases' artifacts are already
in `artifacts`, and phases are idempotent (`session-orchestrator.ts`), so no
work is lost and nothing is double-charged.

### 6.2 New session state — `awaiting-credits`
Add to the `SessionState` union (mirrors the existing `awaiting-gate`):

```
{ kind: "awaiting-credits", phase, needed, balance }
```

- `creator_sessions.status` gains `awaiting-credits` (text column, no enum
  change needed). `serializeStatus`/`deserializeStatus` handle it.
- It is durable and crash-recoverable exactly like `awaiting-gate`:
  `resumeInterrupted` treats it as a parked, non-terminal state (does **not**
  mark the queue message done — it stays parked until resumed).

### 6.3 Charge flow (in the orchestrator / phase handlers)
For each billable op: **check → run → debit-on-success**.

```
if (!creditService.canAfford(userId, amount)) → park (gate)   // check first
... run the op ...
creditService.debit(userId, amount, { idempotencyKey: `${sid}:${phase}:${opSeq}` })  // on success only
```

- **Affordable** → op runs; on success an atomic ledger entry debits the amount.
  This guarantees we never charge for an op that didn't produce its artifact
  (a failed/transiently-retried op is not debited until it actually succeeds).
- **Insufficient** (the pre-check fails) → orchestrator transitions to
  `awaiting-credits` `{ phase, needed: amount, balance }`, emits a
  `credits.required` event, and stops (no error). Progress so far is persisted.
- **Idempotency**: the unique key per op means a resume that re-enters a phase
  skips ops already debited (no double charge) and continues from the first
  unpaid op. The check uses the live balance, so a concurrent session draining
  the balance simply gates the next op rather than overdrawing.

### 6.4 Events (chat-rendered)
New `ServerEvent` variants (in `packages/shared` events):

- `credits.required` `{ phase, needed, balance }` → chat renders an inline
  `<CreditsGateCard>` with balance/needed and CTAs **Buy credits** / **Upgrade**
  (both open the pricing modal, Credits/Plans tab).
- `credits.resumed` `{ phase }` → chat shows "Resuming…".
- `credits.charged` (optional, low-noise) for a running balance read-out.

### 6.5 Resume
On a successful purchase that lifts the balance, the server **auto-resumes** any
of that user's `awaiting-credits` sessions (re-enqueues the parked message);
the chat also offers an explicit **Continue** button as a fallback. Resume
re-enters the parked phase, the now-affordable op debits and runs, and the
pipeline proceeds. Pre-flight: starting a run is allowed as long as the first
op is affordable — a low balance simply parks later, which is the intended flow.

## 7. Data model (drizzle — new `apps/server/src/db/schema/billing.ts`)

- **`credit_ledger`** (append-only source of truth): `id`, `user_id`,
  `delta` (int, + grant/purchase, − consumption), `reason`
  (`signup_bonus` | `subscription_grant` | `purchase` | `consumption` |
  `refund` | `adjustment`), `ref` (jsonb: session/phase/op, or
  purchase/sub id), `idempotency_key` (unique), `balance_after`, `created_at`.
- **`credit_balance`** (cached, fast reads): `user_id` PK, `balance` (total),
  plus three buckets — `subscription_credits`, `bonus_credits`,
  `purchased_credits` — updated in the same transaction as the ledger insert.
  **Subscription credits reset to the plan's monthly grant each period (do NOT
  roll over); bonus + purchased persist.** Consumption draws
  subscription → bonus → purchased (the expiring bucket first). The credits
  dropdown shows this split with "resets monthly" / "never expires" labels.
  (This implements the non-roll-over behavior earlier deferred in §4.)
- **`subscription`**: `user_id` PK, `tier` (`free|pro|max|ultra`), `status`,
  `interval` (`monthly|yearly`), `current_period_end`, `cancel_at_period_end`,
  `provider_customer_id`, `provider_subscription_id`, `updated_at`.
- Monthly grant: a scheduled job (or on-read top-up) credits the tier's
  `credits/mo` at each period boundary via a `subscription_grant` ledger entry
  (idempotent per period).

## 8. Backend API (Fastify, new `billing-routes.ts`)

- `GET /api/credits` → `{ balance, subscription }`.
- `GET /api/billing/plans` → plan + pack catalog (from shared).
- `POST /api/billing/checkout` `{ kind: "subscription"|"credits", tier?, interval?, pack?|customUsd? }`
  → creates a payment-provider checkout, returns redirect URL.
- `POST /api/billing/webhook` → provider webhook: on payment success, write the
  `purchase`/`subscription_grant` ledger entry + activate/extend subscription,
  then trigger auto-resume of parked sessions.
- `POST /api/billing/portal` → provider customer portal (manage/cancel) [phase 2].
- Credit checks/debits are internal (`creditService`), called by the
  orchestrator — not a public route.

## 9. Frontend (Next 15 + shadcn)

- **Shared plan catalog + `<PricingPanel>`** (tier cards, monthly/yearly toggle,
  credit packs, custom amount) — used by both the landing section and the modal.
- **Landing**: new `marketing/landing-pricing.tsx` section + a "Pricing" nav
  link in `landing-header.tsx`; CTAs → `/login`.
- **Pricing modal** `<PricingDialog>` (tabs: Plans / Credits / Team[later]),
  matching the reference screenshots; opened from the credits widget and the
  in-session gate card.
- **Top-right credits widget**: add a desktop header slot to `AppShell`'s
  `Main` (currently mobile-only). `<CreditsBadge>` shows `✦ {balance}`; click →
  dropdown with balance, subscription status/renewal, **Upgrade** (→ Plans) and
  **Buy credits** (→ Credits).
- **In-session gate**: `chat-stream.tsx` renders `credits.required` as
  `<CreditsGateCard>` → opens `<PricingDialog>`; on success, shows resume.
- State via TanStack Query (`useCredits`, `useSubscription`); invalidate on
  purchase/resume. Balance also updated live via the existing SSE stream
  (`credits.charged`/`credits.resumed`).

## 10. Payments

Provider: **Creem** — but **not wired up yet**. The billing layer is built
against a small internal `PaymentProvider` interface
(`createCheckout`, `handleWebhook`) with a **dev/stub implementation only** for
now: `POST /api/billing/grant` (dev-guarded) credits an account directly so the
whole purchase→credits→resume loop is testable end-to-end without a real
processor. A `CreemPaymentProvider` slots into the same interface in a later
pass. No Creem SDK/keys/webhooks in this build.

## 11. Phasing

- **Phase 1 — Credits core + gating + UI** (no real money): ledger/balance,
  consumption wired into the pipeline, `awaiting-credits` pause/resume,
  credits widget, pricing panel/modal, landing pricing section. A dev-only
  `grant credits` endpoint stands in for checkout so the full pause→top-up→resume
  loop is testable end-to-end.
- **Phase 2 — Stripe**: real checkout, webhooks, monthly grants, customer portal.

## 12. Decisions (resolved)

1. Payment provider — **Creem**, **not implemented yet** (dev stub only; see §10).
2. Free signup bonus = **200, one-time only** (no daily/monthly refresh).
3. Yearly subscribers get **monthly refresh** on the annual term (not 12 months
   up front).
4. Tier gating: **none on output quality.** Free has NO resolution limit — every
   tier renders full resolution (per aspect ratio: 16:9→1920×1080, 9:16/1:1→1080)
   with no watermark. Tiers differ only by price + monthly credit grant. The
   output resolution is shown to the user as info (composer settings), not gated.
   *(Supersedes the earlier "Free = 720p" note.)*
5. Team/multi-seat (the reference's "Team" tab) — out of scope for now.

Implementation: build **Phase 1 directly** (credits core + consumption + gating
+ full UI, payments stubbed per §10). Phase 2 (Creem) is a later pass.

## 13. Out of scope (now)

Team/seats, gift cards, referral credits, usage analytics dashboards,
per-model dynamic pricing, tax/VAT handling beyond what the provider gives.
