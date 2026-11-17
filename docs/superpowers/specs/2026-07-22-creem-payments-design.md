# Creem Payments Integration — Design

Date: 2026-07-22
Status: approved (user), supersedes the "payments stubbed" §10 of
[2026-06-25-pricing-credits-design.md](2026-06-25-pricing-credits-design.md).

## 1. Goal

Replace the dev billing stubs with real Creem-backed payments:

- Checkout for subscriptions (Pro/Max/Ultra × monthly/yearly) and one-time
  credit top-ups (single pay-what-you-want product).
- A signed webhook applies the money → credits/subscription effects.
- Re-enable the beta-hidden Upgrade/Buy entries in the credits badge.
- All Creem keys/product ids come from env so test → live is a value swap.

Out of scope: in-app upgrade/downgrade (Creem customer portal handles
cancel/plan changes), automatic refund clawback (log only), team plans.

## 2. Creem facts this design relies on

- REST base: `https://api.creem.io` (live) / `https://test-api.creem.io`
  (sandbox). API keys are prefixed `creem_test_` in test mode, which lets the
  base URL be derived from the key. Auth header: `x-api-key`.
- `POST /v1/checkouts` accepts `product_id`, `units`, `success_url`,
  `request_id`, `customer {email}`, `metadata`, `custom_price` (cents,
  one-time products) and returns `checkout_url`.
- Webhooks are signed: `creem-signature` header = HMAC-SHA256(raw body,
  webhook secret), hex. Secret comes from the Creem dashboard
  (Developers → Webhooks). Test and live modes have separate webhook
  configs/secrets.
- Events used: `checkout.completed`, `subscription.paid`,
  `subscription.scheduled_cancel`, `subscription.canceled`,
  `subscription.expired`, `subscription.past_due`. Payloads carry
  `metadata`/`request_id` passthrough, `order.amount` (cents), product id,
  customer id, and subscription period dates.
- After payment Creem redirects to `success_url` with query params
  (`checkout_id`, `order_id`, `request_id`, `signature`, …).

## 3. Configuration

`apps/server/.env` (all replaceable per environment; documented in
`.env.example` with placeholders — real ids/keys are never committed):

```
CREEM_API_KEY=creem_test_…            # creem_test_ prefix → test-api.creem.io
CREEM_WEBHOOK_SECRET=…                # dashboard Developers → Webhooks
CREEM_PRODUCT_CREDITS=prod_…          # PWYW top-up product (min $5)
CREEM_PRODUCT_PRO_MONTHLY=prod_…
CREEM_PRODUCT_PRO_YEARLY=prod_…
CREEM_PRODUCT_MAX_MONTHLY=prod_…
CREEM_PRODUCT_MAX_YEARLY=prod_…
CREEM_PRODUCT_ULTRA_MONTHLY=prod_…
CREEM_PRODUCT_ULTRA_YEARLY=prod_…
# optional: CREEM_API_BASE=…          # explicit base URL override
```

Creem billing is **enabled** iff `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, and
all seven product ids are set. When disabled and `BILLING_STUBS=1`, the
checkout endpoint falls back to stub behavior (apply effects directly, return
a balance instead of a URL) so local dev works without Creem credentials.
When both are absent the purchase endpoints 404 (today's behavior).

Success URL base = existing `WEB_ORIGIN` (falls back to `BETTER_AUTH_URL` in
same-origin dev), path `/billing/success`.

## 4. Server components

### 4.1 `apps/server/src/billing/creem-config.ts`

Parses env into `CreemConfig | null`:

- `apiKey`, `webhookSecret`, `apiBase` (derived from key prefix unless
  `CREEM_API_BASE` set).
- `products`: bidirectional mapping — `forPlan(tier, interval) → productId`,
  `forCredits() → productId`, `identify(productId) → {kind:"subscription",
  tier, interval} | {kind:"credits"} | null`.

### 4.2 `apps/server/src/billing/creem-client.ts`

Thin fetch client (no SDK dependency), injected so tests fake it:

- `createCheckout(input): Promise<{ checkoutUrl: string }>` —
  `POST {base}/v1/checkouts` with `product_id`, `request_id`, `metadata`
  (`userId`, `kind`, `usd?`), `customer: {email}`, `success_url`, and
  `custom_price` (cents) for credit top-ups. Non-2xx → typed error.
- `createCustomerPortal(customerId): Promise<{ url: string }>` —
  `POST {base}/v1/customers/billing`.
- `verifyWebhookSignature(rawBody: Buffer, header: string | undefined):
  boolean` — constant-time compare of hex HMAC-SHA256.

Note: `custom_price` on a PWYW product is unverified against Creem docs; if
the sandbox rejects it, omit it for the credits product (buyer types the
amount on Creem's page). Credits granted are computed from the webhook's
`order.amount` either way, so the ledger can never disagree with what was
paid.

### 4.3 Billing routes (`billing-routes.ts`)

Registered when Creem is configured (else stub/404 behavior per §3):

- `POST /api/billing/checkout` (session-guarded). Body is the web app's
  `PurchaseIntent`: `{kind:"credits", usd}` or `{kind:"subscription", tier,
  interval}`. Validates `usd` against `CUSTOM_CREDIT_BOUNDS` (5–1000) and
  tier ∈ {pro,max,ultra}. Creates the Creem checkout with
  `metadata = {userId, kind, usd?, tier?, interval?}` and
  `request_id = co:{userId}:{uuid}`. Returns `{url}`.
  Stub fallback returns `{balance}` (no url) after applying today's stub
  effects.
- `POST /api/billing/portal` (session-guarded). Looks up the user's
  `providerCustomerId`; 404 `no_portal` when absent; else returns `{url}`.

### 4.4 Webhook route (`creem-webhook-routes.ts`)

`POST /api/webhooks/creem` — deliberately outside the session guard's
`/api/billing/` prefix; no auth, no CORS requirement (server-to-server).
Registered in an encapsulated Fastify scope whose JSON content-type parser
preserves the raw body for signature verification. Invalid/missing signature
→ 401. Handler always 200s after applying effects (Creem retries on non-2xx;
unknown event types are logged and acknowledged).

Event handling (all ledger writes idempotent via `idempotencyKey`, so
webhook retries and event overlap are safe):

- `checkout.completed`
  - Resolve `userId` from `metadata.userId` (fallback: log + ack).
  - Product identifies as credits → `grant` purchased credits =
    `order.amount` cents (1 credit = 1¢ exactly), key
    `creem:order:{order.id}`, ref `{checkoutId, orderId, amountCents}`.
  - Product identifies as subscription → activate: `setSubscription` with
    tier/interval from the product mapping, `status:"active"`,
    `currentPeriodEnd` from the payload subscription period,
    `providerCustomerId`/`providerSubscriptionId` stored;
    `resetSubscriptionCredits(monthlyCredits)` keyed per period (see the
    key-shape note below).
- `subscription.paid` — renewal (also fires for the first period; the shared
  period-keyed idempotency key dedupes against activation): update
  `currentPeriodEnd`, `resetSubscriptionCredits` keyed on the new period.
- `subscription.scheduled_cancel` — `cancelAtPeriodEnd = true`.
- `subscription.canceled` / `subscription.expired` — `status:"canceled"`,
  subscription bucket reset to 0 (key `creem:subzero:{eventId}`).
- `subscription.past_due` — `status:"past_due"`.
- `refund.created` — log only (manual adjustment if ever needed).

Because yearly subs must refresh credits **monthly** while Creem only bills
yearly, the existing lazy `dueRefresh` in `GET /api/credits` keeps doing the
intra-term monthly resets; the webhook only anchors term boundaries. For
monthly subs `subscription.paid` and `dueRefresh` race benignly: both derive
period-keyed grant keys, and `setSubscription` from the webhook is
authoritative. To avoid key-shape mismatch (`sub:{userId}:{end}` vs
`creem:sub:…`) double-granting a period, the webhook handler reuses
`activateSubscription`/`dueRefresh`-style keys: `sub:{userId}:{periodEndISO}`
for subscription grants. `creem:order:*` keys stay Creem-shaped since only
the webhook mints them.

### 4.5 Subscription record

No migration: `subscription.provider_customer_id` /
`provider_subscription_id` columns already exist. `SubscriptionRecord` and
the repositories gain those two optional fields (read/write pass-through).

## 5. Web app

- `api-client.ts`: `createCheckout(intent) → {url: string | null, balance?}`;
  `createPortalSession() → {url}`. Dev-stub fallback path returns balance.
- `pricing-dialog.tsx` `onPurchase`: call `createCheckout`; if `url` →
  `window.location.assign(url)`; if `balance` (stub mode) → today's
  toast + refresh behavior.
- `credits-badge.tsx`: restore the commented Upgrade plan / Buy credits menu
  items + `PricingDialog`; add "Manage subscription" item (visible when
  `subscription.status` is active/past_due) that calls the portal endpoint
  and opens the URL.
- New `apps/web/src/app/billing/success/page.tsx`: notes the balance on
  first `/api/credits` fetch, polls every 2s (≤60s) until balance or
  subscription tier changes, shows "payment received / credits arriving…" →
  "+N credits" (or new plan name) with a button back home. Timeout state:
  "payment received; credits will appear shortly" (webhook may lag).

## 6. Webhook URLs to configure in Creem

- Production: `https://api.ultra-vora.com/api/webhooks/creem`
- Local dev: `ngrok http 3001` → `https://<ngrok-domain>/api/webhooks/creem`
  (only the webhook needs the tunnel; the browser redirect goes to
  `localhost:3000/billing/success` directly).

## 7. Testing

- Unit (server): config parsing/product mapping; signature verification
  (known HMAC vector, bad/missing header); checkout route (validation,
  product selection, stub fallback, metadata content) with a faked client;
  webhook handler per event type against the in-memory credit repository —
  including retry idempotency (same event twice → one grant) and the
  monthly-refresh key compatibility.
- Unit (web): pricing-dialog redirects on `{url}`, stub path unchanged;
  success-page polling (fake timers); credits-badge menu items render.
- Manual (test mode): full loop — checkout with Creem test card, webhook via
  ngrok, balance lands, success page resolves; portal link opens.

## 8. Decisions

1. Hand-rolled thin client over `creem` SDK / better-auth plugin (2 endpoints
   used; SDK adds an unstable dependency; the plugin owns tables that clash
   with the credits ledger).
2. Cancel/plan changes via Creem customer portal, not in-app.
3. Dedicated `/billing/success` page that polls until the webhook lands.
4. Credits granted = cents actually paid (webhook `order.amount`), never the
   client-requested amount.
5. Test vs live is pure env config; base URL derived from key prefix with an
   explicit override.
