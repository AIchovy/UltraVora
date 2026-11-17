"use client";
import { useRouter } from "next/navigation";
import { PricingPanel } from "@/components/pricing/pricing-panel";

/** Pricing section on the marketing homepage. Any CTA routes to sign-in. */
export function LandingPricing(): React.ReactElement {
  const router = useRouter();
  return (
    <section id="pricing" className="border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight">Simple, usage-based pricing</h2>
          <p className="mt-3 text-muted-foreground">
            Every plan includes credits that turn into finished videos. A typical 1-minute promo is
            about 400 credits. Start free — top up or subscribe whenever you need more.
          </p>
        </div>
        <PricingPanel mode="marketing" onPurchase={() => router.push("/login")} />
      </div>
    </section>
  );
}
