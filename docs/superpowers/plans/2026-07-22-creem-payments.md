# Creem Payments Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dev billing stubs with real Creem checkout + signed webhook so subscriptions and credit top-ups are paid for, and re-enable the beta-hidden purchase entries in the web app.

**Architecture:** A thin hand-rolled Creem HTTP client (no SDK) behind env-driven config. `POST /api/billing/checkout` creates a Creem checkout and the browser redirects to it; `POST /api/webhooks/creem` (unauthenticated, HMAC-verified) applies money→credits effects through the existing idempotent `CreditRepository`. Spec: `docs/superpowers/specs/2026-07-22-creem-payments-design.md`.

**Tech Stack:** Fastify, zod v3, node:crypto, vitest, Next.js App Router, TanStack Query.

## Global Constraints

- Zero new dependencies (no `creem` SDK; use `fetch` + `node:crypto`).
- 1 credit = 1 US cent exactly; credits granted from webhook `order.amount` (cents), never from client input.
- All ledger writes go through `CreditRepository` with idempotency keys; webhook retries must never double-grant purchased credits.
- Subscription credit grants always use `resetSubscriptionCredits` (SET semantics).
- Env names: `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `CREEM_API_BASE` (optional), `CREEM_PRODUCT_CREDITS`, `CREEM_PRODUCT_{PRO|MAX|ULTRA}_{MONTHLY|YEARLY}`.
- Webhook path is exactly `/api/webhooks/creem` (must NOT start with `/api/billing/` — that prefix is session-guarded).
- Run tests from repo root: `pnpm exec vitest run --workspace ./vitest.suites.ts <file>`; run `pnpm typecheck` before the final commit.
- Commit after every task (branch `claude/pricing-page-rates-248ba7`).
- Real key/product-id VALUES go only in gitignored `apps/server/.env`; `.env.example` gets placeholders.

---

### Task 1: Creem config (env parsing + product catalog)

**Files:**
- Create: `apps/server/src/billing/creem-config.ts`
- Test: `apps/server/test/billing/creem-config.test.ts`

**Interfaces:**
- Produces:
  - `interface CreemProductCatalog { credits: string; plans: Record<"pro"|"max"|"ultra", Record<"monthly"|"yearly", string>> }`
  - `interface CreemConfig { apiKey: string; webhookSecret: string; apiBase: string; products: CreemProductCatalog }`
  - `creemConfigFromEnv(env: Record<string, string | undefined>): CreemConfig | null` — null unless key, secret, and all 7 product ids are set. `apiBase` = `CREEM_API_BASE` if set, else `https://test-api.creem.io` when the key starts with `creem_test_`, else `https://api.creem.io`.
  - `identifyProduct(catalog: CreemProductCatalog, productId: string): { kind: "credits" } | { kind: "subscription"; tier: "pro"|"max"|"ultra"; interval: "monthly"|"yearly" } | null`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/billing/creem-config.test.ts
import { describe, it, expect } from "vitest";
import { creemConfigFromEnv, identifyProduct } from "../../src/billing/creem-config.js";

const FULL_ENV = {
  CREEM_API_KEY: "creem_test_abc",
  CREEM_WEBHOOK_SECRET: "whsec_1",
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm",
  CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm",
  CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um",
  CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
};

describe("creemConfigFromEnv", () => {
  it("parses a full env and derives the test base URL from the key prefix", () => {
    const cfg = creemConfigFromEnv(FULL_ENV);
    expect(cfg).not.toBeNull();
    expect(cfg!.apiBase).toBe("https://test-api.creem.io");
    expect(cfg!.products.plans.max.yearly).toBe("prod_my");
    expect(cfg!.products.credits).toBe("prod_credits");
  });

  it("derives the live base URL for a live key, and honors an explicit override", () => {
    expect(creemConfigFromEnv({ ...FULL_ENV, CREEM_API_KEY: "creem_live_x" })!.apiBase)
      .toBe("https://api.creem.io");
    expect(creemConfigFromEnv({ ...FULL_ENV, CREEM_API_BASE: "http://localhost:9999" })!.apiBase)
      .toBe("http://localhost:9999");
  });

  it("returns null when any required var is missing", () => {
    expect(creemConfigFromEnv({})).toBeNull();
    const { CREEM_PRODUCT_ULTRA_YEARLY: _drop, ...partial } = FULL_ENV;
    expect(creemConfigFromEnv(partial)).toBeNull();
    expect(creemConfigFromEnv({ ...FULL_ENV, CREEM_WEBHOOK_SECRET: "" })).toBeNull();
  });
});

describe("identifyProduct", () => {
  const catalog = creemConfigFromEnv(FULL_ENV)!.products;
  it("maps ids back to credits / plan / null", () => {
    expect(identifyProduct(catalog, "prod_credits")).toEqual({ kind: "credits" });
    expect(identifyProduct(catalog, "prod_py")).toEqual({ kind: "subscription", tier: "pro", interval: "yearly" });
    expect(identifyProduct(catalog, "prod_unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-config.test.ts`
Expected: FAIL — cannot find module `../../src/billing/creem-config.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/billing/creem-config.ts
// Creem env parsing + product-id catalog. All ids/keys are env-supplied so
// test → live is a pure value swap (design §3).

export interface CreemProductCatalog {
  credits: string;
  plans: Record<"pro" | "max" | "ultra", Record<"monthly" | "yearly", string>>;
}

export interface CreemConfig {
  apiKey: string;
  webhookSecret: string;
  /** REST base; derived from the key prefix unless CREEM_API_BASE overrides. */
  apiBase: string;
  products: CreemProductCatalog;
}

const TIERS = ["pro", "max", "ultra"] as const;
const INTERVALS = ["monthly", "yearly"] as const;

/** null unless the API key, webhook secret, and all seven product ids are set. */
export function creemConfigFromEnv(env: Record<string, string | undefined>): CreemConfig | null {
  const apiKey = env.CREEM_API_KEY;
  const webhookSecret = env.CREEM_WEBHOOK_SECRET;
  const credits = env.CREEM_PRODUCT_CREDITS;
  if (!apiKey || !webhookSecret || !credits) return null;

  const plans = {} as CreemProductCatalog["plans"];
  for (const tier of TIERS) {
    const byInterval = {} as Record<"monthly" | "yearly", string>;
    for (const interval of INTERVALS) {
      const id = env[`CREEM_PRODUCT_${tier.toUpperCase()}_${interval.toUpperCase()}`];
      if (!id) return null;
      byInterval[interval] = id;
    }
    plans[tier] = byInterval;
  }

  const apiBase =
    env.CREEM_API_BASE ??
    (apiKey.startsWith("creem_test_") ? "https://test-api.creem.io" : "https://api.creem.io");
  return { apiKey, webhookSecret, apiBase, products: { credits, plans } };
}

export type CreemProductIdentity =
  | { kind: "credits" }
  | { kind: "subscription"; tier: "pro" | "max" | "ultra"; interval: "monthly" | "yearly" };

export function identifyProduct(
  catalog: CreemProductCatalog,
  productId: string,
): CreemProductIdentity | null {
  if (productId === catalog.credits) return { kind: "credits" };
  for (const tier of TIERS) {
    for (const interval of INTERVALS) {
      if (catalog.plans[tier][interval] === productId) return { kind: "subscription", tier, interval };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-config.test.ts`
Expected: PASS (6 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/billing/creem-config.ts apps/server/test/billing/creem-config.test.ts
git commit -m "feat(server): Creem env config + product catalog mapping"
```

---

### Task 2: Creem HTTP client + webhook signature verification

**Files:**
- Create: `apps/server/src/billing/creem-client.ts`
- Test: `apps/server/test/billing/creem-client.test.ts`

**Interfaces:**
- Consumes: `CreemConfig` fields `apiKey`/`apiBase` (Task 1).
- Produces:
  - `interface CreemCheckoutInput { productId: string; requestId: string; successUrl: string; customerEmail?: string; metadata: Record<string, string | number>; customPriceCents?: number }`
  - `interface CreemClient { createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }>; createCustomerPortal(customerId: string): Promise<{ url: string }> }`
  - `class HttpCreemClient implements CreemClient` — constructor `({ apiKey, apiBase }: { apiKey: string; apiBase: string })`.
  - `verifyCreemSignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean` — hex HMAC-SHA256, constant-time compare.

Creem API facts: `POST {base}/v1/checkouts` with header `x-api-key`, JSON body `{ product_id, request_id, success_url, metadata, customer?: { email }, custom_price? }` → `{ checkout_url }`. `POST {base}/v1/customers/billing` body `{ customer_id }` → `{ customer_portal_link }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/billing/creem-client.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { HttpCreemClient, verifyCreemSignature } from "../../src/billing/creem-client.js";

const cfg = { apiKey: "creem_test_k", apiBase: "https://test-api.creem.io" };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("HttpCreemClient.createCheckout", () => {
  it("POSTs the checkout and returns the checkout URL", async () => {
    const fetchFn = stubFetch(200, { id: "ch_1", checkout_url: "https://creem.io/test/checkout/x" });
    const client = new HttpCreemClient(cfg);
    const out = await client.createCheckout({
      productId: "prod_pm",
      requestId: "co:u1:abc",
      successUrl: "http://localhost:3000/billing/success?kind=subscription&tier=pro",
      customerEmail: "test@example.com",
      metadata: { userId: "u1", kind: "subscription" },
    });
    expect(out).toEqual({ checkoutUrl: "https://creem.io/test/checkout/x" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test-api.creem.io/v1/checkouts");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("creem_test_k");
    expect(JSON.parse(init.body as string)).toEqual({
      product_id: "prod_pm",
      request_id: "co:u1:abc",
      success_url: "http://localhost:3000/billing/success?kind=subscription&tier=pro",
      customer: { email: "test@example.com" },
      metadata: { userId: "u1", kind: "subscription" },
    });
  });

  it("passes custom_price (cents) when set and omits customer without an email", async () => {
    const fetchFn = stubFetch(200, { checkout_url: "https://c/x" });
    await new HttpCreemClient(cfg).createCheckout({
      productId: "prod_credits",
      requestId: "co:u1:def",
      successUrl: "http://localhost:3000/billing/success",
      metadata: { userId: "u1" },
      customPriceCents: 1250,
    });
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.custom_price).toBe(1250);
    expect(body.customer).toBeUndefined();
  });

  it("throws a typed error on a non-2xx response", async () => {
    stubFetch(400, { error: "invalid product" });
    await expect(
      new HttpCreemClient(cfg).createCheckout({
        productId: "nope",
        requestId: "r",
        successUrl: "s",
        metadata: {},
      }),
    ).rejects.toThrow(/creem checkout failed: 400/);
  });
});

describe("HttpCreemClient.createCustomerPortal", () => {
  it("returns the portal link", async () => {
    const fetchFn = stubFetch(200, { customer_portal_link: "https://creem.io/portal/x" });
    const out = await new HttpCreemClient(cfg).createCustomerPortal("cust_1");
    expect(out).toEqual({ url: "https://creem.io/portal/x" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test-api.creem.io/v1/customers/billing");
    expect(JSON.parse(init.body as string)).toEqual({ customer_id: "cust_1" });
  });
});

describe("verifyCreemSignature", () => {
  const secret = "whsec_test";
  const body = Buffer.from(JSON.stringify({ id: "evt_1" }));
  const good = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts the matching HMAC and rejects everything else", () => {
    expect(verifyCreemSignature(body, good, secret)).toBe(true);
    expect(verifyCreemSignature(body, undefined, secret)).toBe(false);
    expect(verifyCreemSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyCreemSignature(Buffer.from("tampered"), good, secret)).toBe(false);
    expect(verifyCreemSignature(body, good, "other_secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-client.test.ts`
Expected: FAIL — cannot find module `../../src/billing/creem-client.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/billing/creem-client.ts
// Thin Creem REST client + webhook signature check. Deliberately not the
// `creem` SDK: two endpoints, injected as an interface so tests fake it
// (design §4.2, decision 1).
import { createHmac, timingSafeEqual } from "node:crypto";

export interface CreemCheckoutInput {
  productId: string;
  /** Merchant-side correlation id; echoed back in webhooks/redirects. */
  requestId: string;
  successUrl: string;
  customerEmail?: string;
  metadata: Record<string, string | number>;
  /** One-time products only: pre-set price in cents (PWYW credits top-up). */
  customPriceCents?: number;
}

export interface CreemClient {
  createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }>;
  createCustomerPortal(customerId: string): Promise<{ url: string }>;
}

export class HttpCreemClient implements CreemClient {
  constructor(private readonly cfg: { apiKey: string; apiBase: string }) {}

  private async post(path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "x-api-key": this.cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`creem ${what} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }> {
    const out = await this.post(
      "/v1/checkouts",
      {
        product_id: input.productId,
        request_id: input.requestId,
        success_url: input.successUrl,
        metadata: input.metadata,
        ...(input.customerEmail ? { customer: { email: input.customerEmail } } : {}),
        ...(input.customPriceCents !== undefined ? { custom_price: input.customPriceCents } : {}),
      },
      "checkout",
    );
    const url = out.checkout_url;
    if (typeof url !== "string") throw new Error("creem checkout: no checkout_url in response");
    return { checkoutUrl: url };
  }

  async createCustomerPortal(customerId: string): Promise<{ url: string }> {
    const out = await this.post("/v1/customers/billing", { customer_id: customerId }, "portal");
    const url = out.customer_portal_link;
    if (typeof url !== "string") throw new Error("creem portal: no customer_portal_link in response");
    return { url };
  }
}

/** creem-signature header = hex HMAC-SHA256(raw body, webhook secret). */
export function verifyCreemSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header, "hex");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/billing/creem-client.ts apps/server/test/billing/creem-client.test.ts
git commit -m "feat(server): thin Creem HTTP client + webhook signature verification"
```

---

### Task 3: Provider linkage fields on SubscriptionRecord

**Files:**
- Modify: `apps/server/src/credits/credit-repository.ts:42-49` (SubscriptionRecord)
- Modify: `apps/server/src/credits/pg-credit-repository.ts:90-118` (get/setSubscription)
- Test: `apps/server/test/credits/memory-credit-repository.test.ts` (extend) — check the exact filename with `ls apps/server/test/credits/`; if the repo contract test lives elsewhere (e.g. `credit-repository.contract.test.ts`), add the case there.

**Interfaces:**
- Produces: `SubscriptionRecord` gains `providerCustomerId?: string | null; providerSubscriptionId?: string | null`. DB columns already exist ([billing.ts:68-69](../../apps/server/src/db/schema/billing.ts)) — **no migration**.

- [ ] **Step 1: Write the failing test** — add to the existing repository test file:

```ts
it("persists provider linkage ids on the subscription", async () => {
  const repo = new MemoryCreditRepository();
  await repo.setSubscription({
    userId: "u1",
    tier: "pro",
    status: "active",
    interval: "monthly",
    currentPeriodEnd: "2026-08-22T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    providerCustomerId: "cust_1",
    providerSubscriptionId: "sub_1",
  });
  const sub = await repo.getSubscription("u1");
  expect(sub?.providerCustomerId).toBe("cust_1");
  expect(sub?.providerSubscriptionId).toBe("sub_1");
});
```

If a matching `*.pg.test.ts` contract test exists for `PgCreditRepository`, add the same case there.

- [ ] **Step 2: Run to verify it fails** (type error on unknown fields):

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/credits/`
Expected: FAIL (TS: unknown properties `providerCustomerId`).

- [ ] **Step 3: Implement**

In `credit-repository.ts`, extend the interface:

```ts
export interface SubscriptionRecord {
  userId: string;
  tier: PlanTier;
  status: "active" | "canceled" | "past_due";
  interval: "monthly" | "yearly";
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
  /** Payment-provider linkage (Creem); absent for stub-activated subs. */
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
}
```

`MemoryCreditRepository` needs no change (it spreads the record). In `pg-credit-repository.ts` add to the `getSubscription` return object:

```ts
      providerCustomerId: r.providerCustomerId ?? null,
      providerSubscriptionId: r.providerSubscriptionId ?? null,
```

and to the `setSubscription` `values` object:

```ts
      providerCustomerId: sub.providerCustomerId ?? null,
      providerSubscriptionId: sub.providerSubscriptionId ?? null,
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/credits/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/credits/ apps/server/test/credits/
git commit -m "feat(server): provider linkage fields on SubscriptionRecord"
```

---

### Task 4: Monthly credit-refresh cadence for yearly plans

Yearly billing must still refresh credits **monthly** (pricing spec decision 3: "monthly refresh on the annual term"), but `activateSubscription`/`dueRefresh` currently step `currentPeriodEnd` by the billing interval — a yearly subscriber would get one grant per YEAR. Fix: `currentPeriodEnd` is the **credit-refresh boundary** and always steps monthly; `interval` stays as billing/display data. Cancellation at term end is handled by Creem webhooks (Task 5), so a canceled yearly sub keeps refreshing monthly until Creem says it expired — which is correct (they paid for the year).

**Files:**
- Modify: `apps/server/src/credits/subscription.ts`
- Test: `apps/server/test/credits/subscription.test.ts`

**Interfaces:**
- `activateSubscription`/`dueRefresh` signatures unchanged. Behavior change only: monthly step for both intervals.

- [ ] **Step 1: Update/extend the tests** — in `subscription.test.ts` add:

```ts
describe("yearly billing still refreshes credits monthly", () => {
  it("activateSubscription(yearly) sets a one-MONTH refresh boundary", () => {
    const r = activateSubscription("u1", "pro", "yearly", now); // now = 2026-06-26
    expect(r.sub.interval).toBe("yearly");
    expect(r.sub.currentPeriodEnd).toBe("2026-07-26T00:00:00.000Z");
    expect(r.amount).toBe(3000);
  });

  it("dueRefresh on a yearly sub rolls forward one month", () => {
    const sub = activateSubscription("u1", "pro", "yearly", now).sub;
    const r = dueRefresh(sub, new Date("2026-07-26T00:00:00.000Z"));
    expect(r!.sub.currentPeriodEnd).toBe("2026-08-26T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/credits/subscription.test.ts`
Expected: the two new tests FAIL (yearly currently steps +1 year).

- [ ] **Step 3: Implement** — in `subscription.ts`, change both call sites of `nextPeriodEnd` to a fixed monthly step and document why:

```ts
// currentPeriodEnd is the CREDIT-REFRESH boundary, not the billing term:
// yearly plans bill once a year but refresh credits monthly (pricing spec
// decision 3). Billing-term boundaries live with the payment provider and
// arrive via webhooks.
```

In `activateSubscription`: `currentPeriodEnd: nextPeriodEnd(now, "monthly").toISOString()`.
In `dueRefresh`: `const end = nextPeriodEnd(new Date(sub.currentPeriodEnd), "monthly").toISOString();`
`nextPeriodEnd` itself keeps both intervals (still exported/tested).

- [ ] **Step 4: Run the full credits + api suites** (billing-routes tests assert subscribe behavior):

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/credits/ apps/server/test/api/billing-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/credits/subscription.ts apps/server/test/credits/subscription.test.ts
git commit -m "fix(server): yearly plans refresh credits monthly, not yearly"
```

---

### Task 5: Webhook event handler (pure module)

**Files:**
- Create: `apps/server/src/billing/creem-webhook.ts`
- Test: `apps/server/test/billing/creem-webhook.test.ts`

**Interfaces:**
- Consumes: `CreditRepository` (grant/resetSubscriptionCredits/get/setSubscription), `CreemProductCatalog` + `identifyProduct` (Task 1), `activateSubscription` (Task 4 semantics), `getPlan` from `@ultracreator/shared`.
- Produces: `handleCreemEvent(deps: { credits: CreditRepository; catalog: CreemProductCatalog; log?: (msg: string, data?: unknown) => void }, event: unknown): Promise<void>` — never throws on unknown/malformed events (logs and returns); throws only on repository errors (route will 500 → Creem retries).

Payload notes (zod v3, `.passthrough()` everywhere; `product`/`customer` may be an id string or an object):

- Envelope: `{ id, eventType, object }`.
- `checkout.completed` object: `{ id, request_id?, metadata?: { userId }, order: { id, amount /* cents */, product }, product, customer, subscription? }`.
- `subscription.*` object: `{ id, product, customer, metadata?: { userId }, current_period_start_date?, current_period_end_date? }`.

Effects (design §4.4):

| Event | Effect |
|---|---|
| `checkout.completed` (credits product) | `grant` purchased credits = `order.amount`, key `creem:order:{order.id}` |
| `checkout.completed` (plan product) | `activateSubscription` + provider ids, `resetSubscriptionCredits(monthlyCredits)` with the activation `grantKey` |
| `subscription.paid` | ensure status active + provider ids; `resetSubscriptionCredits` keyed `creem:subpaid:{sub.id}:{current_period_start_date}` |
| `subscription.scheduled_cancel` | `cancelAtPeriodEnd = true` |
| `subscription.canceled` / `subscription.expired` | status `canceled`, bucket → 0, key `creem:subzero:{envelope.id}` |
| `subscription.past_due` | status `past_due` |
| anything else | log + ignore |

All subscription grants are SETs so replay/racing with `dueRefresh` is value-idempotent; the purchased-credits grant is an ADD and keys on the Creem order id.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/billing/creem-webhook.test.ts
import { describe, it, expect } from "vitest";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import { handleCreemEvent } from "../../src/billing/creem-webhook.js";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";

const catalog = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: "s",
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!.products;

function deps() {
  const credits = new MemoryCreditRepository();
  return { credits, catalog };
}

const creditsCheckout = (amount: number) => ({
  id: "evt_1",
  eventType: "checkout.completed",
  object: {
    id: "ch_1",
    request_id: "co:u1:x",
    metadata: { userId: "u1", kind: "credits" },
    order: { id: "ord_1", amount, product: "prod_credits" },
    product: { id: "prod_credits" },
    customer: { id: "cust_1", email: "t@e.com" },
  },
});

const subCheckout = {
  id: "evt_2",
  eventType: "checkout.completed",
  object: {
    id: "ch_2",
    metadata: { userId: "u1", kind: "subscription" },
    order: { id: "ord_2", amount: 2000, product: "prod_pm" },
    product: { id: "prod_pm" },
    customer: { id: "cust_1", email: "t@e.com" },
    subscription: {
      id: "sub_1",
      current_period_start_date: "2026-07-22T00:00:00.000Z",
      current_period_end_date: "2026-08-22T00:00:00.000Z",
    },
  },
};

describe("handleCreemEvent: checkout.completed for credits", () => {
  it("grants exactly the cents paid, into the purchased bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, creditsCheckout(1250));
    expect(await d.credits.getBalance("u1")).toBe(1250);
    expect((await d.credits.getBreakdown("u1")).purchased).toBe(1250);
  });

  it("is idempotent across webhook retries (same order id)", async () => {
    const d = deps();
    await handleCreemEvent(d, creditsCheckout(2000));
    await handleCreemEvent(d, creditsCheckout(2000));
    expect(await d.credits.getBalance("u1")).toBe(2000);
  });
});

describe("handleCreemEvent: checkout.completed for a plan", () => {
  it("activates the subscription with provider ids and grants the first month", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    const sub = await d.credits.getSubscription("u1");
    expect(sub).toMatchObject({
      tier: "pro", interval: "monthly", status: "active",
      providerCustomerId: "cust_1", providerSubscriptionId: "sub_1",
    });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });

  it("re-delivery does not change the outcome (SET semantics)", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subCheckout);
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });
});

describe("handleCreemEvent: subscription lifecycle", () => {
  const subEvent = (eventType: string, extra: Record<string, unknown> = {}) => ({
    id: `evt_${eventType}`,
    eventType,
    object: {
      id: "sub_1",
      product: "prod_pm",
      customer: "cust_1",
      metadata: { userId: "u1" },
      current_period_start_date: "2026-08-22T00:00:00.000Z",
      current_period_end_date: "2026-09-22T00:00:00.000Z",
      ...extra,
    },
  });

  it("paid: refreshes the subscription bucket keyed on the Creem period", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await d.credits.debit({ userId: "u1", amount: 500, idempotencyKey: "spend1", reason: "consumption" });
    await handleCreemEvent(d, subEvent("subscription.paid"));
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000); // SET back to the grant
    await handleCreemEvent(d, subEvent("subscription.paid")); // retry: same key, no change
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });

  it("scheduled_cancel: flags cancelAtPeriodEnd, stays active", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.scheduled_cancel"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("canceled: marks canceled and zeroes the subscription bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.canceled"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "canceled" });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(0);
  });

  it("past_due: marks past_due, keeps the bucket", async () => {
    const d = deps();
    await handleCreemEvent(d, subCheckout);
    await handleCreemEvent(d, subEvent("subscription.past_due"));
    expect(await d.credits.getSubscription("u1")).toMatchObject({ status: "past_due" });
    expect((await d.credits.getBreakdown("u1")).subscription).toBe(3000);
  });
});

describe("handleCreemEvent: robustness", () => {
  it("ignores unknown event types, unknown products, and missing userId", async () => {
    const d = deps();
    await handleCreemEvent(d, { id: "e", eventType: "refund.created", object: { id: "ref_1" } });
    const noUser = creditsCheckout(1000);
    (noUser.object.metadata as Record<string, unknown>).userId = undefined;
    await handleCreemEvent(d, noUser);
    const badProduct = creditsCheckout(1000);
    badProduct.object.order.product = "prod_unknown";
    (badProduct.object.product as { id: string }).id = "prod_unknown";
    await handleCreemEvent(d, badProduct);
    await handleCreemEvent(d, "not even an object");
    expect(await d.credits.getBalance("u1")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-webhook.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/billing/creem-webhook.ts
// Applies Creem webhook events to the credit ledger/subscription. Pure of
// HTTP concerns — the route (creem-webhook-routes.ts) verifies the signature
// and JSON-parses before calling in. Idempotency: purchased-credit grants key
// on the Creem order id (ADD, must never replay); subscription grants are
// SETs, so replays and races with the lazy dueRefresh converge on the same
// value (design §4.4).
import { z } from "zod";
import { getPlan } from "@ultracreator/shared";
import type { CreditRepository } from "../credits/credit-repository.js";
import { activateSubscription } from "../credits/subscription.js";
import { identifyProduct, type CreemProductCatalog } from "./creem-config.js";

export interface CreemWebhookDeps {
  credits: CreditRepository;
  catalog: CreemProductCatalog;
  log?: (msg: string, data?: unknown) => void;
}

/** Creem sends `product`/`customer` as either a bare id or an expanded object. */
const IdRef = z.union([z.string(), z.object({ id: z.string() }).passthrough()]);
const idOf = (v: z.infer<typeof IdRef>): string => (typeof v === "string" ? v : v.id);

const Metadata = z.object({ userId: z.string().min(1) }).passthrough();

const Envelope = z.object({
  id: z.string(),
  eventType: z.string(),
  object: z.record(z.unknown()),
}).passthrough();

const CheckoutObject = z.object({
  id: z.string(),
  metadata: Metadata,
  order: z.object({ id: z.string(), amount: z.number().int().positive(), product: IdRef }).passthrough(),
  product: IdRef,
  customer: IdRef,
  subscription: z.object({ id: z.string() }).passthrough().optional(),
}).passthrough();

const SubscriptionObject = z.object({
  id: z.string(),
  product: IdRef,
  customer: IdRef,
  metadata: Metadata,
  current_period_start_date: z.string().optional(),
  current_period_end_date: z.string().optional(),
}).passthrough();

export async function handleCreemEvent(deps: CreemWebhookDeps, event: unknown): Promise<void> {
  const log = deps.log ?? (() => {});
  const env = Envelope.safeParse(event);
  if (!env.success) {
    log("creem webhook: unparseable event", { issues: env.error.issues });
    return;
  }
  const { eventType, object } = env.data;

  switch (eventType) {
    case "checkout.completed":
      return handleCheckoutCompleted(deps, log, object);
    case "subscription.paid":
    case "subscription.scheduled_cancel":
    case "subscription.canceled":
    case "subscription.expired":
    case "subscription.past_due":
      return handleSubscriptionEvent(deps, log, env.data.id, eventType, object);
    default:
      log(`creem webhook: ignoring event type ${eventType}`);
  }
}

async function handleCheckoutCompleted(
  deps: CreemWebhookDeps,
  log: NonNullable<CreemWebhookDeps["log"]>,
  object: unknown,
): Promise<void> {
  const parsed = CheckoutObject.safeParse(object);
  if (!parsed.success) {
    log("creem webhook: checkout.completed missing fields", { issues: parsed.error.issues });
    return;
  }
  const co = parsed.data;
  const userId = co.metadata.userId;
  const identity = identifyProduct(deps.catalog, idOf(co.order.product));
  if (!identity) {
    log("creem webhook: unknown product on order", { product: idOf(co.order.product) });
    return;
  }

  if (identity.kind === "credits") {
    // 1 credit = 1 cent: whatever was actually paid is exactly what lands.
    await deps.credits.grant({
      userId,
      amount: co.order.amount,
      idempotencyKey: `creem:order:${co.order.id}`,
      reason: "purchase",
      ref: { provider: "creem", checkoutId: co.id, orderId: co.order.id, amountCents: co.order.amount },
    });
    return;
  }

  const { sub, grantKey, amount } = activateSubscription(userId, identity.tier, identity.interval, new Date());
  await deps.credits.setSubscription({
    ...sub,
    providerCustomerId: idOf(co.customer),
    providerSubscriptionId: co.subscription?.id ?? null,
  });
  await deps.credits.resetSubscriptionCredits({
    userId,
    amount,
    idempotencyKey: grantKey,
    reason: "subscription_grant",
    ref: { provider: "creem", checkoutId: co.id, tier: identity.tier, interval: identity.interval },
  });
}

async function handleSubscriptionEvent(
  deps: CreemWebhookDeps,
  log: NonNullable<CreemWebhookDeps["log"]>,
  eventId: string,
  eventType: string,
  object: unknown,
): Promise<void> {
  const parsed = SubscriptionObject.safeParse(object);
  if (!parsed.success) {
    log(`creem webhook: ${eventType} missing fields`, { issues: parsed.error.issues });
    return;
  }
  const ev = parsed.data;
  const userId = ev.metadata.userId;
  const existing = await deps.credits.getSubscription(userId);
  if (!existing) {
    log(`creem webhook: ${eventType} for user without a subscription`, { userId });
    return;
  }
  const linked = { ...existing, providerCustomerId: idOf(ev.customer), providerSubscriptionId: ev.id };

  switch (eventType) {
    case "subscription.paid":
      await deps.credits.setSubscription({ ...linked, status: "active" });
      await deps.credits.resetSubscriptionCredits({
        userId,
        amount: getPlan(existing.tier).monthlyCredits,
        idempotencyKey: `creem:subpaid:${ev.id}:${ev.current_period_start_date ?? "unknown"}`,
        reason: "subscription_grant",
        ref: { provider: "creem", subscriptionId: ev.id, periodStart: ev.current_period_start_date },
      });
      return;
    case "subscription.scheduled_cancel":
      await deps.credits.setSubscription({ ...linked, cancelAtPeriodEnd: true });
      return;
    case "subscription.canceled":
    case "subscription.expired":
      await deps.credits.setSubscription({ ...linked, status: "canceled" });
      // Subscription credits die with the subscription (bonus/purchased persist).
      await deps.credits.resetSubscriptionCredits({
        userId,
        amount: 0,
        idempotencyKey: `creem:subzero:${eventId}`,
        reason: "subscription_grant",
        ref: { provider: "creem", subscriptionId: ev.id, event: eventType },
      });
      return;
    case "subscription.past_due":
      await deps.credits.setSubscription({ ...linked, status: "past_due" });
      return;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/billing/creem-webhook.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/billing/creem-webhook.ts apps/server/test/billing/creem-webhook.test.ts
git commit -m "feat(server): Creem webhook event handler (credits, activation, lifecycle)"
```

---

### Task 6: Webhook route (raw body + signature) and app wiring

**Files:**
- Create: `apps/server/src/api/creem-webhook-routes.ts`
- Modify: `apps/server/src/api/app.ts` (AppDeps + registration)
- Test: `apps/server/test/api/creem-webhook-routes.test.ts`

**Interfaces:**
- Consumes: `verifyCreemSignature` (Task 2), `handleCreemEvent` (Task 5), `CreemConfig` (Task 1).
- Produces:
  - `AppDeps` gains `creem?: { config: CreemConfig; client: CreemClient }`.
  - `registerCreemWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void>` — registers `POST /api/webhooks/creem` only when `deps.creem` and `deps.credits` are set.
  - Route: 401 bad/missing signature; 400 unparseable JSON; 200 `{ received: true }` otherwise.

Fastify note: content-type parsers are encapsulated per plugin scope, so the raw-body parser is added inside `app.register(async (scope) => …)` and cannot leak to other routes. The test asserts other JSON routes still work.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/api/creem-webhook-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";
import type { CreemClient } from "../../src/billing/creem-client.js";

const SECRET = "whsec_route_test";
const config = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: SECRET,
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!;

const fakeClient: CreemClient = {
  createCheckout: async () => ({ checkoutUrl: "https://creem.io/x" }),
  createCustomerPortal: async () => ({ url: "https://creem.io/portal" }),
};

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let eventLog: SessionEventLog;
let credits: MemoryCreditRepository;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-creem-webhook-"));
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const sessions = new InMemorySessionRepository();
  credits = new MemoryCreditRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts,
    phases: new PhaseRegistry(), intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(), sessions, messages: new InMemoryMessageStore(), credits,
  });
  eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  const deps: AppDeps = {
    workspaces, events, artifacts, phases: new PhaseRegistry(), orchestrator, eventLog,
    auth: fakeAuthService(null), // logged OUT: the webhook must not need a session
    sessions, credits,
    creem: { config, client: fakeClient },
  };
  // billingStubs keeps a JSON-parsing POST route (/api/billing/grant)
  // registered so we can prove the raw-body parser stays scoped to the
  // webhook plugin and does not hijack app-wide JSON parsing.
  app = await createApp(deps, { billingStubs: true });
});

afterEach(async () => {
  await app.close();
  await eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

const event = JSON.stringify({
  id: "evt_1",
  eventType: "checkout.completed",
  object: {
    id: "ch_1",
    metadata: { userId: "u-hook" },
    order: { id: "ord_1", amount: 2000, product: "prod_credits" },
    product: "prod_credits",
    customer: "cust_1",
  },
});
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("POST /api/webhooks/creem", () => {
  it("applies a correctly-signed event without any auth session", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(event) },
      payload: event,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await credits.getBalance("u-hook")).toBe(2000);
  });

  it("rejects a bad or missing signature with 401 and applies nothing", async () => {
    const bad = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(event, "wrong") },
      payload: event,
    });
    expect(bad.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json" },
      payload: event,
    });
    expect(missing.statusCode).toBe(401);
    expect(await credits.getBalance("u-hook")).toBe(0);
  });

  it("400s on signed-but-unparseable JSON", async () => {
    const junk = "{not json";
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/creem",
      headers: { "content-type": "application/json", "creem-signature": sign(junk) },
      payload: junk,
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not break JSON parsing on other routes (parser is scoped)", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    // Body parsing runs BEFORE the auth preHandler in Fastify's lifecycle, so a
    // 401 (not 400/415) proves normal JSON parsing survived on this POST route.
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/grant",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ usd: 20 }),
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/api/creem-webhook-routes.test.ts`
Expected: FAIL — `creem` is not a known AppDeps property / route 404.

- [ ] **Step 3: Implement**

`apps/server/src/api/creem-webhook-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { verifyCreemSignature } from "../billing/creem-client.js";
import { handleCreemEvent } from "../billing/creem-webhook.js";

/**
 * POST /api/webhooks/creem — Creem server→server events. Unauthenticated by
 * design (the session guard only covers /api/sessions*, /api/credits and
 * /api/billing/*): authenticity comes from the HMAC signature over the RAW
 * body. The raw-body content-type parser lives in an encapsulated plugin
 * scope so the rest of the app keeps Fastify's normal JSON parsing.
 */
export async function registerCreemWebhookRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const creem = deps.creem;
  const credits = deps.credits;
  if (!creem || !credits) return;

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/api/webhooks/creem", async (req, reply) => {
      const raw = req.body as Buffer;
      const signature = req.headers["creem-signature"];
      if (!verifyCreemSignature(raw, typeof signature === "string" ? signature : undefined, creem.config.webhookSecret)) {
        reply.code(401).send({ error: "bad_signature" });
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        reply.code(400).send({ error: "bad_json" });
        return;
      }
      // Repository failures throw → 500 → Creem retries with the same event id;
      // idempotency keys make the retry safe.
      await handleCreemEvent(
        { credits, catalog: creem.config.products, log: (msg, data) => req.log.warn(data ?? {}, msg) },
        event,
      );
      reply.send({ received: true });
    });
  });
}
```

`apps/server/src/api/app.ts` — add imports and the dep:

```ts
import type { CreemConfig } from "../billing/creem-config.js";
import type { CreemClient } from "../billing/creem-client.js";
import { registerCreemWebhookRoutes } from "./creem-webhook-routes.js";
```

In `AppDeps`:

```ts
  /** Optional: Creem payment provider (real checkout + webhook). */
  creem?: { config: CreemConfig; client: CreemClient };
```

After the `registerBillingRoutes(...)` line:

```ts
  await registerCreemWebhookRoutes(app, deps);
```

- [ ] **Step 4: Run to verify it passes** (plus the untouched billing suite):

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/api/creem-webhook-routes.test.ts apps/server/test/api/billing-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/creem-webhook-routes.ts apps/server/src/api/app.ts apps/server/test/api/creem-webhook-routes.test.ts
git commit -m "feat(server): signed Creem webhook route with scoped raw-body parsing"
```

---

### Task 7: Checkout + portal endpoints

**Files:**
- Modify: `apps/server/src/api/billing-routes.ts`
- Modify: `apps/server/src/api/app.ts:128` (pass `webOrigin` through)
- Test: `apps/server/test/api/billing-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `deps.creem` (Task 6 shape), `CUSTOM_CREDIT_BOUNDS`/`creditsForUsd` from shared, existing stub helpers.
- Produces:
  - `CreateAppOptions` gains `webOrigin?: string` (browser origin for the success redirect; server.ts passes CORS allowlist[0] ?? BETTER_AUTH_URL).
  - `registerBillingRoutes(app, deps, opts: { stubs?: boolean; webOrigin?: string })`.
  - `POST /api/billing/checkout` body `{ kind: "credits", usd } | { kind: "subscription", tier, interval }`:
    - Creem configured → `200 { url }` (Creem checkout URL). Subscription intents 409 `{ error: "existing_subscription" }` when the user already has a non-canceled provider-linked subscription (portal handles changes).
    - No Creem + `stubs` → applies the existing stub effects, returns `200 { balance }` (no `url`).
    - Neither → 404 (route not registered).
  - `POST /api/billing/portal` → `200 { url }`, or 404 `{ error: "no_portal" }` without a provider-linked subscription.

Success URL construction (server-side, so the success page can show concrete copy):
- credits: `{webOrigin}/billing/success?kind=credits&credits={round(usd*100)}`
- subscription: `{webOrigin}/billing/success?kind=subscription&tier={tier}`

- [ ] **Step 1: Write the failing tests** — append to `billing-routes.test.ts`. Reuse the existing `makeApp` helper, extending it to accept deps overrides:

Change the helper signature to `function makeApp(loggedIn: boolean, opts: CreateAppOptions = {}, extraDeps: Partial<AppDeps> = {})` and spread `...extraDeps` into `deps` before `createApp`. Then add:

```ts
import { creemConfigFromEnv } from "../../src/billing/creem-config.js";
import type { CreemCheckoutInput, CreemClient } from "../../src/billing/creem-client.js";

const creemTestConfig = creemConfigFromEnv({
  CREEM_API_KEY: "creem_test_k", CREEM_WEBHOOK_SECRET: "whsec",
  CREEM_PRODUCT_CREDITS: "prod_credits",
  CREEM_PRODUCT_PRO_MONTHLY: "prod_pm", CREEM_PRODUCT_PRO_YEARLY: "prod_py",
  CREEM_PRODUCT_MAX_MONTHLY: "prod_mm", CREEM_PRODUCT_MAX_YEARLY: "prod_my",
  CREEM_PRODUCT_ULTRA_MONTHLY: "prod_um", CREEM_PRODUCT_ULTRA_YEARLY: "prod_uy",
})!;

function fakeCreemClient() {
  const calls: CreemCheckoutInput[] = [];
  const client: CreemClient = {
    createCheckout: async (input) => {
      calls.push(input);
      return { checkoutUrl: `https://creem.io/checkout/${input.productId}` };
    },
    createCustomerPortal: async (customerId) => ({ url: `https://creem.io/portal/${customerId}` }),
  };
  return { client, calls };
}

describe("POST /api/billing/checkout (Creem configured)", () => {
  let calls: CreemCheckoutInput[];
  beforeEach(async () => {
    await app.close();
    await eventLog.closeAll();
    const fake = fakeCreemClient();
    calls = fake.calls;
    app = await makeApp(true, { webOrigin: "http://web.test" }, { creem: { config: creemTestConfig, client: fake.client } });
  });

  it("maps a subscription intent to the right product and returns the checkout URL", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "max", interval: "yearly" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://creem.io/checkout/prod_my" });
    expect(calls[0]).toMatchObject({
      productId: "prod_my",
      customerEmail: "test@example.com",
      successUrl: "http://web.test/billing/success?kind=subscription&tier=max",
      metadata: { userId: "u-test", kind: "subscription", tier: "max", interval: "yearly" },
    });
    expect(calls[0].customPriceCents).toBeUndefined();
  });

  it("maps a credits intent with custom_price cents and the credits success URL", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "credits", usd: 12.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      productId: "prod_credits",
      customPriceCents: 1250,
      successUrl: "http://web.test/billing/success?kind=credits&credits=1250",
      metadata: { userId: "u-test", kind: "credits", usd: 12.5 },
    });
  });

  it("validates the body (bounds, tier, kind)", async () => {
    for (const payload of [
      { kind: "credits", usd: 4 },
      { kind: "credits", usd: 1001 },
      { kind: "subscription", tier: "free", interval: "monthly" },
      { kind: "nope" },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/billing/checkout", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("409s a subscription intent when a provider-linked subscription is active", async () => {
    await credits.setSubscription({
      userId: "u-test", tier: "pro", status: "active", interval: "monthly",
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      providerCustomerId: "cust_1", providerSubscriptionId: "sub_1",
    });
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "max", interval: "monthly" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "existing_subscription" });
    // Credits top-ups stay allowed.
    const topUp = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(topUp.statusCode).toBe(200);
  });
});

describe("POST /api/billing/checkout (stub fallback, no Creem)", () => {
  it("applies the stub effects directly and returns a balance instead of a url", async () => {
    // `app` from the outer beforeEach: billingStubs on, no creem dep.
    const credits20 = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(credits20.statusCode).toBe(200);
    expect(credits20.json()).toEqual({ balance: 2000 });

    const sub = await app.inject({
      method: "POST", url: "/api/billing/checkout",
      payload: { kind: "subscription", tier: "pro", interval: "monthly" },
    });
    expect(sub.json()).toEqual({ balance: 5000 }); // 2000 + 3000 sub grant
  });

  it("404s when neither Creem nor stubs are enabled", async () => {
    await app.close();
    await eventLog.closeAll();
    app = await makeApp(true);
    const res = await app.inject({
      method: "POST", url: "/api/billing/checkout", payload: { kind: "credits", usd: 20 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/billing/portal", () => {
  it("returns the portal URL for a provider-linked subscription, 404 otherwise", async () => {
    await app.close();
    await eventLog.closeAll();
    const fake = fakeCreemClient();
    app = await makeApp(true, {}, { creem: { config: creemTestConfig, client: fake.client } });

    const none = await app.inject({ method: "POST", url: "/api/billing/portal" });
    expect(none.statusCode).toBe(404);

    await credits.setSubscription({
      userId: "u-test", tier: "pro", status: "active", interval: "monthly",
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
      providerCustomerId: "cust_9", providerSubscriptionId: "sub_9",
    });
    const res = await app.inject({ method: "POST", url: "/api/billing/portal" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://creem.io/portal/cust_9" });
  });
});
```

Note: `makeApp` reassigns the module-level `credits` variable, so `credits.setSubscription` targets the live repo. The auth fake's user email is `test@example.com` (TEST_USER).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/api/billing-routes.test.ts`
Expected: new tests FAIL (404 on /checkout, unknown opts); pre-existing tests PASS.

- [ ] **Step 3: Implement** — in `billing-routes.ts`:

Add imports: `creditsForUsd` from shared, `randomUUID` from `node:crypto`, `activateSubscription` already imported.

```ts
const CheckoutBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("credits"),
    usd: z.number().min(CUSTOM_CREDIT_BOUNDS.minUsd).max(CUSTOM_CREDIT_BOUNDS.maxUsd),
  }),
  z.object({
    kind: z.literal("subscription"),
    tier: z.enum(["pro", "max", "ultra"]),
    interval: z.enum(["monthly", "yearly"]),
  }),
]);
```

Register `POST /api/billing/checkout` when `deps.creem || opts.stubs` (before the `if (!opts.stubs) return;` line — restructure: keep `/grant` + `/subscribe` under the stubs flag as-is, and place `/checkout` + `/portal` above it):

```ts
  const creem = deps.creem;
  const webOrigin = (opts.webOrigin ?? "http://localhost:3000").replace(/\/$/, "");

  if (creem || opts.stubs) {
    app.post("/api/billing/checkout", async (req, reply) => {
      const userId = req.authUser?.id;
      if (!userId) { reply.code(401).send({ error: "unauthorized" }); return; }
      if (!credits) { reply.code(503).send({ error: "credits_disabled" }); return; }
      const parsed = CheckoutBody.safeParse(req.body ?? {});
      if (!parsed.success) { reply.code(400).send({ error: "invalid body" }); return; }
      const intent = parsed.data;

      if (!creem) {
        // Dev stub fallback: apply the effects directly (BILLING_STUBS=1).
        if (intent.kind === "credits") {
          const amount = creditsForUsd(intent.usd);
          const result = await credits.grant({
            userId, amount,
            idempotencyKey: `dev-grant:${userId}:${Date.now()}:${amount}`,
            reason: "purchase", ref: { dev: true },
          });
          reply.send({ balance: result.balanceAfter });
          return;
        }
        const { sub, grantKey, amount } = activateSubscription(userId, intent.tier, intent.interval, new Date());
        await credits.setSubscription(sub);
        await credits.resetSubscriptionCredits({
          userId, amount, idempotencyKey: grantKey,
          reason: "subscription_grant", ref: { tier: intent.tier, interval: intent.interval },
        });
        reply.send({ balance: await credits.getBalance(userId) });
        return;
      }

      if (intent.kind === "subscription") {
        // Plan changes go through the Creem customer portal — a second live
        // subscription would double-bill.
        const existing = await credits.getSubscription(userId);
        if (existing && existing.status !== "canceled" && existing.providerSubscriptionId) {
          reply.code(409).send({ error: "existing_subscription" });
          return;
        }
      }

      const requestId = `co:${userId}:${randomUUID()}`;
      const input =
        intent.kind === "credits"
          ? {
              productId: creem.config.products.credits,
              requestId,
              successUrl: `${webOrigin}/billing/success?kind=credits&credits=${creditsForUsd(intent.usd)}`,
              metadata: { userId, kind: "credits", usd: intent.usd },
              customPriceCents: Math.round(intent.usd * 100),
              ...(req.authUser?.email ? { customerEmail: req.authUser.email } : {}),
            }
          : {
              productId: creem.config.products.plans[intent.tier][intent.interval],
              requestId,
              successUrl: `${webOrigin}/billing/success?kind=subscription&tier=${intent.tier}`,
              metadata: { userId, kind: "subscription", tier: intent.tier, interval: intent.interval },
              ...(req.authUser?.email ? { customerEmail: req.authUser.email } : {}),
            };
      const { checkoutUrl } = await creem.client.createCheckout(input);
      reply.send({ url: checkoutUrl });
    });
  }

  if (creem) {
    app.post("/api/billing/portal", async (req, reply) => {
      const userId = req.authUser?.id;
      if (!userId) { reply.code(401).send({ error: "unauthorized" }); return; }
      if (!credits) { reply.code(503).send({ error: "credits_disabled" }); return; }
      const sub = await credits.getSubscription(userId);
      if (!sub?.providerCustomerId) { reply.code(404).send({ error: "no_portal" }); return; }
      const { url } = await creem.client.createCustomerPortal(sub.providerCustomerId);
      reply.send({ url });
    });
  }
```

Update the function signature/JSDoc: `opts: { stubs?: boolean; webOrigin?: string }`. In `app.ts`, add `webOrigin?: string` to `CreateAppOptions` (doc: "Browser origin used to build payment success redirects.") and pass it: `registerBillingRoutes(app, deps, { stubs: opts.billingStubs ?? false, webOrigin: opts.webOrigin })`.

Check `AuthUser` has `email` (it does: `apps/server/test/helpers/fake-auth.ts` TEST_USER).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/server/test/api/billing-routes.test.ts apps/server/test/api/creem-webhook-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/billing-routes.ts apps/server/src/api/app.ts apps/server/test/api/billing-routes.test.ts
git commit -m "feat(server): Creem checkout + customer-portal endpoints with stub fallback"
```

---

### Task 8: server.ts wiring + env files

**Files:**
- Modify: `apps/server/src/api/server.ts` (~line 100, next to BILLING_STUBS; and the `createApp` call ~line 259)
- Modify: `apps/server/.env.example`
- Modify: `apps/server/.env` (gitignored — real test-mode values)

**Interfaces:**
- Consumes: `creemConfigFromEnv` (Task 1), `HttpCreemClient` (Task 2), `webOrigin` opt (Task 7).

- [ ] **Step 1: Wire server.ts** — after the `BILLING_STUBS` block:

```ts
// Creem payments: enabled only when the API key, webhook secret, and all
// seven product ids are present (see creem-config.ts). Test vs live is pure
// env config — a creem_test_ key targets test-api.creem.io automatically.
const creemConfig = creemConfigFromEnv(process.env);
if (!creemConfig) {
  console.log(
    `Creem env not fully set — real billing disabled${BILLING_STUBS ? " (dev payment stubs active)" : ""}.`,
  );
}
```

Imports: `import { creemConfigFromEnv } from "../billing/creem-config.js";` and `import { HttpCreemClient } from "../billing/creem-client.js";`

In the `createApp` call, extend deps + opts:

```ts
const app = await createApp(
  {
    ...composed, eventLog, auth: betterAuthService(auth), sessions, credits, publicVideos,
    ...(creemConfig ? { creem: { config: creemConfig, client: new HttpCreemClient(creemConfig) } } : {}),
  },
  {
    logger: true,
    authPublicOrigin: BETTER_AUTH_URL,
    ...(corsAllowlist ? { corsOrigin: corsAllowlist } : {}),
    billingStubs: BILLING_STUBS,
    webOrigin: corsAllowlist?.[0] ?? BETTER_AUTH_URL,
    healthCheck: () => pool.query("select 1"),
  },
);
```

- [ ] **Step 2: Append to `.env.example`**

```bash
# Creem payments (test → live is a pure value swap). Real billing turns on
# only when ALL of these are set; otherwise BILLING_STUBS=1 keeps the dev
# stub checkout. A creem_test_ key auto-targets test-api.creem.io.
# CREEM_API_KEY=creem_test_xxx
# CREEM_WEBHOOK_SECRET=whsec_xxx   # dashboard Developers → Webhooks
# CREEM_PRODUCT_CREDITS=prod_xxx   # pay-what-you-want top-up product (min $5)
# CREEM_PRODUCT_PRO_MONTHLY=prod_xxx
# CREEM_PRODUCT_PRO_YEARLY=prod_xxx
# CREEM_PRODUCT_MAX_MONTHLY=prod_xxx
# CREEM_PRODUCT_MAX_YEARLY=prod_xxx
# CREEM_PRODUCT_ULTRA_MONTHLY=prod_xxx
# CREEM_PRODUCT_ULTRA_YEARLY=prod_xxx
# Optional explicit base-URL override:
# CREEM_API_BASE=https://api.creem.io
# Webhook URL to register in the Creem dashboard:
#   prod:  https://api.ultra-vora.com/api/webhooks/creem
#   local: ngrok http 3001 → https://<tunnel>/api/webhooks/creem
```

- [ ] **Step 3: Append the real test-mode values to the local `apps/server/.env`** (gitignored; user-provided ids):

```bash
CREEM_API_KEY=your-creem-api-key
# CREEM_WEBHOOK_SECRET=   ← fill in after creating the webhook in the Creem test dashboard
CREEM_PRODUCT_CREDITS=your-creem-product-credits
CREEM_PRODUCT_PRO_MONTHLY=your-creem-product-pro-monthly
CREEM_PRODUCT_PRO_YEARLY=your-creem-product-pro-yearly
CREEM_PRODUCT_MAX_MONTHLY=your-creem-product-max-monthly
CREEM_PRODUCT_MAX_YEARLY=your-creem-product-max-yearly
CREEM_PRODUCT_ULTRA_MONTHLY=your-creem-product-ultra-monthly
CREEM_PRODUCT_ULTRA_YEARLY=your-creem-product-ultra-yearly
```

If `apps/server/.env` does not exist in this worktree, create it from `.env.example` first and note that to the user.

- [ ] **Step 4: Verify boot + typecheck**

Run: `pnpm -F @ultracreator/server exec tsc --noEmit`
Expected: clean. (Full boot needs PG; typecheck suffices here.)

- [ ] **Step 5: Commit** (only tracked files — `.env` is gitignored):

```bash
git add apps/server/src/api/server.ts apps/server/.env.example
git commit -m "feat(server): wire Creem config/client from env"
```

---

### Task 9: Web checkout flow (api-client + pricing dialog)

**Files:**
- Modify: `apps/web/src/lib/api-client.ts:146-179` (replace `grantCredits`/`subscribe` with `createCheckout` + `createPortalSession`)
- Modify: `apps/web/src/lib/api-types.ts` (add `CheckoutResponse`)
- Modify: `apps/web/src/components/pricing/pricing-dialog.tsx`
- Test: `apps/web/test/components/pricing-dialog.test.tsx` (create or extend — check `ls apps/web/test/components/` first; a pricing-panel test exists, dialog test may not)

**Interfaces:**
- Consumes: `POST /api/billing/checkout` and `/api/billing/portal` (Task 7 shapes).
- Produces:
  - `interface CheckoutResponse { url: string | null; balance?: number }` in api-types.
  - `createCheckout(intent: PurchaseIntent): Promise<CheckoutResponse>` (import `PurchaseIntent` type from the pricing-panel or re-declare the union inline in api-client to avoid a component import from lib — declare inline: `{ kind: "credits"; usd: number } | { kind: "subscription"; tier: "pro" | "max" | "ultra"; interval: "monthly" | "yearly" }`).
  - `createPortalSession(): Promise<{ url: string }>` — throws `ApiError` 404 when no portal.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/components/pricing-dialog.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PricingDialog } from "@/components/pricing/pricing-dialog";

const { createCheckout } = vi.hoisted(() => ({ createCheckout: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  createCheckout,
  getCredits: vi.fn(), // use-credits imports it from the same module
  ApiError: class extends Error { constructor(public status: number) { super("api"); } },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PricingDialog open onOpenChange={() => {}} mode="app" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createCheckout.mockReset();
  // window.location.assign is not writable in jsdom; stub the whole location.
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: vi.fn() },
    writable: true,
  });
});

describe("PricingDialog purchase flow", () => {
  it("redirects to the Creem checkout URL for a subscription", async () => {
    createCheckout.mockResolvedValue({ url: "https://creem.io/checkout/x" });
    renderDialog();
    await userEvent.click(screen.getAllByRole("button", { name: /subscribe/i })[0]);
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("https://creem.io/checkout/x"));
    expect(createCheckout).toHaveBeenCalledWith({ kind: "subscription", tier: "pro", interval: "monthly" });
  });

  it("stays in-app on the stub fallback (balance, no url)", async () => {
    createCheckout.mockResolvedValue({ url: null, balance: 2200 });
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /credits/i }));
    await userEvent.click(await screen.findByTestId("pack-20"));
    await waitFor(() => expect(createCheckout).toHaveBeenCalledWith({ kind: "credits", usd: 20 }));
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/components/pricing-dialog.test.tsx`
Expected: FAIL — `createCheckout` is not exported from `@/lib/api-client`.

- [ ] **Step 3: Implement**

`api-types.ts` — add:

```ts
/** POST /api/billing/checkout response: a Creem redirect URL, or (dev stub) the new balance. */
export interface CheckoutResponse {
  url: string | null;
  balance?: number;
}
```

`api-client.ts` — replace `grantCredits` and `subscribe` with:

```ts
export type CheckoutIntent =
  | { kind: "credits"; usd: number }
  | { kind: "subscription"; tier: "pro" | "max" | "ultra"; interval: "monthly" | "yearly" };

/**
 * Start a purchase. Real billing returns a Creem checkout URL to redirect to;
 * the BILLING_STUBS dev fallback applies the effects directly and returns the
 * new balance with url:null.
 */
export async function createCheckout(intent: CheckoutIntent): Promise<CheckoutResponse> {
  const out = await jsonFetch<CheckoutResponse>(`${apiBase()}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intent),
  });
  if (!out) throw new ApiError(0, "createCheckout: empty response");
  return out;
}

/** Creem customer portal (manage/cancel the subscription). 404 → no portal. */
export async function createPortalSession(): Promise<{ url: string }> {
  const out = await jsonFetch<{ url: string }>(`${apiBase()}/api/billing/portal`, { method: "POST" });
  if (!out) throw new ApiError(0, "createPortalSession: empty response");
  return out;
}
```

Add `CheckoutResponse` to the api-types import list. Grep for other `grantCredits`/`subscribe` users first: `grep -rn "grantCredits\|from \"@/lib/api-client\"" apps/web/src apps/web/test | grep -i "grant\|subscribe"` — update/remove leftover call sites and their tests.

`pricing-dialog.tsx` — replace `onPurchase`:

```tsx
  async function onPurchase(intent: PurchaseIntent): Promise<void> {
    if (mode === "marketing") {
      router.push("/login");
      return;
    }
    // Free is the baseline tier — nothing to purchase.
    if (intent.kind === "subscription" && intent.tier === "free") {
      onOpenChange(false);
      return;
    }
    try {
      const out = await createCheckout(intent as CheckoutIntent);
      if (out.url) {
        // Real billing: hand the tab to Creem's checkout page.
        window.location.assign(out.url);
        return;
      }
      // Dev stub fallback applied the purchase directly.
      refresh();
      toast.success(`Purchase applied — balance ${(out.balance ?? 0).toLocaleString("en-US")}`);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("You already have an active subscription — use Manage subscription to change plans.");
        return;
      }
      toast.error("Something went wrong. Please try again.");
    }
  }
```

Imports: `import { createCheckout, ApiError, type CheckoutIntent } from "@/lib/api-client";` (drop `grantCredits`, `subscribe`).

- [ ] **Step 4: Run web tests**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/components/pricing-dialog.test.tsx apps/web/test/components/pricing-panel.test.tsx apps/web/test/components/credits-gate.test.tsx`
Expected: PASS (fix any credits-gate fallout from the removed exports).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/ apps/web/src/components/pricing/pricing-dialog.tsx apps/web/test/components/pricing-dialog.test.tsx
git commit -m "feat(web): purchases go through Creem checkout with stub fallback"
```

---

### Task 10: /billing/success page

**Files:**
- Create: `apps/web/src/app/billing/success/page.tsx`
- Test: `apps/web/test/app/billing-success.test.tsx`

**Interfaces:**
- Consumes: `getCredits()` from api-client; query params `kind` (`credits`|`subscription`), `credits` (number), `tier` (set by the server-built success URL, Task 7).
- Behavior: poll `getCredits()` every 2s for up to 60s. Baseline = first fetch. Resolve to "done" when balance > baseline (credits) or subscription tier matches the `tier` param (subscription). On timeout, show a reassuring "payment received, credits on the way" state. Always offer a "Back to home" link.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/app/billing-success.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import BillingSuccessPage from "@/app/billing/success/page";

const { getCredits } = vi.hoisted(() => ({ getCredits: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ getCredits }));

let params = new URLSearchParams("kind=credits&credits=2000");
vi.mock("next/navigation", () => ({
  useSearchParams: () => params,
}));

const credits = (balance: number, tier: string | null = null) => ({
  balance,
  breakdown: { subscription: 0, bonus: 0, purchased: balance },
  subscription: tier
    ? { tier, status: "active", interval: "monthly", currentPeriodEnd: null, cancelAtPeriodEnd: false }
    : null,
  freePublicAvailable: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  getCredits.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("BillingSuccessPage", () => {
  it("shows pending copy, then success once the balance grows", async () => {
    params = new URLSearchParams("kind=credits&credits=2000");
    getCredits
      .mockResolvedValueOnce(credits(200))   // baseline
      .mockResolvedValueOnce(credits(200))   // still waiting
      .mockResolvedValue(credits(2200));     // webhook landed
    render(<BillingSuccessPage />);
    expect(await screen.findByText(/payment received/i)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2100));
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(screen.getByText(/2,000 credits added/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });

  it("resolves a subscription purchase when the tier appears", async () => {
    params = new URLSearchParams("kind=subscription&tier=pro");
    getCredits
      .mockResolvedValueOnce(credits(200))
      .mockResolvedValue(credits(3200, "pro"));
    render(<BillingSuccessPage />);
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText(/pro plan is active/i)).toBeInTheDocument();
  });

  it("times out to a reassuring state instead of spinning forever", async () => {
    params = new URLSearchParams("kind=credits&credits=2000");
    getCredits.mockResolvedValue(credits(200));
    render(<BillingSuccessPage />);
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(screen.getByText(/on their way/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/app/billing-success.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/app/billing/success/page.tsx
"use client";
// Post-checkout landing. Creem redirects here after payment; the credits
// arrive via webhook a moment later, so poll the balance until it moves
// (or reassure + stop after a minute).
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { getPlan, type PlanTier } from "@ultracreator/shared";
import { getCredits } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

const POLL_MS = 2000;
const TIMEOUT_MS = 60_000;

type Phase = "waiting" | "done" | "timeout";

// next build requires a Suspense boundary around useSearchParams consumers.
export default function BillingSuccessPage(): React.ReactElement {
  return (
    <Suspense>
      <SuccessInner />
    </Suspense>
  );
}

function SuccessInner(): React.ReactElement {
  const params = useSearchParams();
  const kind = params.get("kind") === "subscription" ? "subscription" : "credits";
  const expectedCredits = Number(params.get("credits") ?? 0);
  const tier = params.get("tier") as PlanTier | null;

  const [phase, setPhase] = useState<Phase>("waiting");
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    const started = Date.now();

    async function tick(): Promise<void> {
      if (stopped) return;
      try {
        const c = await getCredits();
        if (baseline.current === null) baseline.current = c.balance;
        const landed =
          kind === "subscription"
            ? c.subscription?.tier === tier
            : c.balance > baseline.current;
        if (landed) {
          setPhase("done");
          return;
        }
      } catch {
        // transient — keep polling until the timeout
      }
      if (Date.now() - started >= TIMEOUT_MS) {
        setPhase("timeout");
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
    };
  }, [kind, tier]);

  const fmt = (n: number): string => n.toLocaleString("en-US");
  const doneCopy =
    kind === "subscription" && tier
      ? `Your ${getPlan(tier).name} plan is active.`
      : `${fmt(expectedCredits)} credits added to your balance.`;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      {phase === "waiting" ? (
        <>
          <Loader2 className="size-10 animate-spin text-primary" />
          <h1 className="text-xl font-semibold">Payment received</h1>
          <p className="text-sm text-muted-foreground">
            {kind === "subscription" ? "Activating your plan…" : "Adding your credits…"}
          </p>
        </>
      ) : (
        <>
          <CheckCircle2 className="size-10 text-primary" />
          <h1 className="text-xl font-semibold">
            {phase === "done" ? doneCopy : "Payment received"}
          </h1>
          {phase === "timeout" && (
            <p className="text-sm text-muted-foreground">
              Your credits are on their way — the balance updates within a few minutes.
            </p>
          )}
        </>
      )}
      <Button asChild variant={phase === "waiting" ? "secondary" : "default"} className="mt-2">
        <Link href="/">Back to home</Link>
      </Button>
    </main>
  );
}
```

Check the app dir for an existing route-group/layout convention (`ls apps/web/src/app/`) — if pages live under a group like `(app)`, place the page accordingly and keep the `/billing/success` URL.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/app/billing-success.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/billing/ apps/web/test/app/billing-success.test.tsx
git commit -m "feat(web): /billing/success page polls until the webhook lands"
```

---

### Task 11: Re-enable credits-badge purchase entries + Manage subscription

**Files:**
- Modify: `apps/web/src/components/credits-badge.tsx`
- Test: `apps/web/test/components/credits-badge.test.tsx`

**Interfaces:**
- Consumes: `PricingDialog` (Task 9 behavior), `createPortalSession` (Task 9), `ApiError`.

- [ ] **Step 1: Update the tests** — replace the beta-era test `"dropdown offers no Upgrade/Buy actions during beta"` with:

```tsx
  it("dropdown offers Upgrade plan and Buy credits", async () => {
    renderBadge({ balance: 200 });
    await userEvent.click(screen.getByRole("button", { name: /credits/i }));
    expect(await screen.findByText(/upgrade plan/i)).toBeInTheDocument();
    expect(screen.getByText(/buy credits/i)).toBeInTheDocument();
    // No subscription → no portal entry.
    expect(screen.queryByText(/manage subscription/i)).toBeNull();
  });

  it("shows Manage subscription for an active subscription", async () => {
    renderBadge({
      balance: 3000,
      subscription: { tier: "pro", status: "active", interval: "monthly", currentPeriodEnd: null, cancelAtPeriodEnd: false },
    });
    await userEvent.click(screen.getByRole("button", { name: /credits/i }));
    expect(await screen.findByText(/manage subscription/i)).toBeInTheDocument();
  });
```

Mock `@/lib/api-client` at the top of the file (the badge now imports `createPortalSession`):

```tsx
vi.mock("@/lib/api-client", () => ({
  createPortalSession: vi.fn(async () => ({ url: "https://creem.io/portal/x" })),
  ApiError: class extends Error { constructor(public status: number) { super("api"); } },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/components/credits-badge.test.tsx`
Expected: new tests FAIL (menu items still commented out).

- [ ] **Step 3: Implement** — in `credits-badge.tsx`:

1. Restore the commented imports (delete the beta comment block at the top):

```tsx
import { useState } from "react";
import { Sparkles, Coins, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { createPortalSession, ApiError } from "@/lib/api-client";
import { PricingDialog } from "./pricing/pricing-dialog";
```

2. Restore the state + handler: `const [open, setOpen] = useState(false);` and `const openPricing = () => setOpen(true);`

3. Uncomment the `DropdownMenuSeparator` + "Upgrade plan" + "Buy credits" menu items exactly as preserved in the comment block (keep the gold `upgrade-shine` styling), and delete the wrapping comments.

4. Add the portal item after "Buy credits" (only when a subscription exists):

```tsx
          {data?.subscription && data.subscription.status !== "canceled" && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void createPortalSession()
                  .then(({ url }) => window.location.assign(url))
                  .catch((err: unknown) => {
                    toast.error(
                      err instanceof ApiError && err.status === 404
                        ? "No billing portal for this subscription."
                        : "Could not open the billing portal. Please try again.",
                    );
                  });
              }}
            >
              <Settings2 />
              Manage subscription
            </DropdownMenuItem>
          )}
```

5. Restore the `<PricingDialog open={open} onOpenChange={setOpen} mode="app" currentTier={tier} />` (delete the surrounding comment), and update the component JSDoc (drop the "Beta:" sentence).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts apps/web/test/components/credits-badge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/credits-badge.tsx apps/web/test/components/credits-badge.test.tsx
git commit -m "feat(web): re-enable Upgrade/Buy entries + Manage subscription portal link"
```

---

### Task 12: Full verification + manual E2E checklist

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all suites PASS. Fix any fallout (e.g. tests that imported the removed `grantCredits`/`subscribe` web helpers).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit any straggler fixes**

```bash
git add -A && git commit -m "test: fixups from Creem integration sweep" || echo "nothing to commit"
```

- [ ] **Step 4: Manual test-mode E2E** (needs the user's help for dashboard steps; use the `verify` skill / dev servers):

1. `ngrok http 3001` → register `https://<tunnel>/api/webhooks/creem` in the Creem **test** dashboard (Developers → Webhooks); put the shown secret into `apps/server/.env` `CREEM_WEBHOOK_SECRET`.
2. Start server (`pnpm dev:server`) + web (`pnpm dev:web`), log in, open the credits badge → Buy credits → $20 pack → should land on `creem.io` test checkout.
3. Pay with Creem's test card (4242 4242 4242 4242, any future expiry/CVC).
4. Expect: redirect to `/billing/success?kind=credits&credits=2000`, page flips to "2,000 credits added", badge shows +2,000 in the purchased bucket.
5. Repeat for a Pro monthly subscription → success page shows "Pro plan is active", badge shows 3,000 subscription credits, "Manage subscription" opens the Creem portal.
6. In the portal, cancel the test subscription → after Creem sends the event, the badge's plan flips (subscription bucket zeroes on the final cancel/expire event).
7. Watch `preview_logs`/server logs for `creem webhook:` warnings — none expected on the happy path. Also confirm whether `custom_price` preset the PWYW amount on the checkout page; if Creem rejected it (400 from createCheckout), remove `customPriceCents` from the credits branch in `billing-routes.ts` and rely on the buyer entering the amount (grant math is webhook-side and unaffected), updating the Task 7 test expectations accordingly.

- [ ] **Step 5: Hand off** — report results, then use superpowers:finishing-a-development-branch (merge to local main per the user's workflow; no push unless asked). Remind the user of the two dashboard items they own: (a) test-mode webhook secret into `.env`, (b) production: live key + live product ids + `https://api.ultra-vora.com/api/webhooks/creem` webhook + live `CREEM_WEBHOOK_SECRET` in the GCE VM's server env.
