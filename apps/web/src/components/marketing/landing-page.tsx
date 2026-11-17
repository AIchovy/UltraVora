import { LandingBlog } from "./landing-blog";
import { LandingFaq } from "./landing-faq";
import { LandingFeatures } from "./landing-features";
import { LandingFooter } from "./landing-footer";
import { LandingHeader } from "./landing-header";
import { LandingHero } from "./landing-hero";
import { LandingPricing } from "./landing-pricing";

/** Marketing homepage shown to logged-out visitors at `/` (spec §6). */
export function LandingPage(): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingHeader />
      <main>
        <LandingHero />
        <LandingFeatures />
        <LandingPricing />
        <LandingFaq />
        <LandingBlog />
      </main>
      <LandingFooter />
    </div>
  );
}
