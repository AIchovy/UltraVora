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
