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
