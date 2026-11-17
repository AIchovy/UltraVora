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

describe("HttpCreemClient.moderatePrompt", () => {
  it("POSTs the prompt and returns the decision", async () => {
    const fetchFn = stubFetch(200, {
      id: "mod_1",
      object: "moderation_result",
      prompt: "a sunny product demo",
      decision: "allow",
      usage: { units: 1 },
    });
    const out = await new HttpCreemClient(cfg).moderatePrompt("a sunny product demo", "sess_1");
    expect(out).toEqual({ decision: "allow" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test-api.creem.io/v1/moderation/prompt");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a sunny product demo",
      external_id: "sess_1",
    });
  });

  it("passes deny/flag decisions through and rejects unknown ones", async () => {
    stubFetch(200, { decision: "deny" });
    expect(await new HttpCreemClient(cfg).moderatePrompt("bad")).toEqual({ decision: "deny" });
    stubFetch(200, { decision: "??" });
    await expect(new HttpCreemClient(cfg).moderatePrompt("odd")).rejects.toThrow(/unexpected decision/);
  });

  it("throws on a non-2xx response (callers fail closed)", async () => {
    stubFetch(500, { error: "oops" });
    await expect(new HttpCreemClient(cfg).moderatePrompt("x")).rejects.toThrow(/creem moderation failed: 500/);
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
