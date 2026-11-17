import type { Metadata } from "next";
import { LandingHeader } from "@/components/marketing/landing-header";
import { LandingFooter } from "@/components/marketing/landing-footer";
import { LandingPricing } from "@/components/marketing/landing-pricing";
import { baseOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Pricing — UltraVora",
  description:
    "Simple, usage-based pricing for AI-generated promo videos. Start free, then top up credits or subscribe whenever you need more.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    ...baseOpenGraph,
    title: "Pricing — UltraVora",
    description:
      "Simple, usage-based pricing for AI-generated promo videos. Start free, then top up credits or subscribe whenever you need more.",
    url: "/pricing",
  },
};

/** Standalone marketing pricing page — same header/footer as the homepage. */
export default function PricingPage(): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingHeader />
      <main>
        <LandingPricing />
      </main>
      <LandingFooter />
    </div>
  );
}
