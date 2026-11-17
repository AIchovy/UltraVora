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

/** Creem prompt-moderation verdict: allow passes; flag and deny must block. */
export type CreemModerationDecision = "allow" | "flag" | "deny";

export interface CreemClient {
  createCheckout(input: CreemCheckoutInput): Promise<{ checkoutUrl: string }>;
  createCustomerPortal(customerId: string): Promise<{ url: string }>;
  moderatePrompt(prompt: string, externalId?: string): Promise<{ decision: CreemModerationDecision }>;
}

export class HttpCreemClient implements CreemClient {
  constructor(private readonly cfg: { apiKey: string; apiBase: string }) {}

  private async post(path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "x-api-key": this.cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      // Bounded wait so a stuck upstream turns into a thrown error (moderation
      // callers fail closed; checkout callers surface a retryable failure).
      signal: AbortSignal.timeout(15_000),
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

  /**
   * Screen a generation prompt (Creem MoR content-safety requirement). Any
   * throw here must be treated as a block by callers — moderation fails CLOSED.
   */
  async moderatePrompt(
    prompt: string,
    externalId?: string,
  ): Promise<{ decision: CreemModerationDecision }> {
    const out = await this.post(
      "/v1/moderation/prompt",
      { prompt, ...(externalId ? { external_id: externalId } : {}) },
      "moderation",
    );
    const decision = out.decision;
    if (decision !== "allow" && decision !== "flag" && decision !== "deny") {
      throw new Error(`creem moderation: unexpected decision ${String(decision)}`);
    }
    return { decision };
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
