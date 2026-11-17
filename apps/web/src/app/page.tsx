import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/components/home-page";
import { LandingPage } from "@/components/marketing/landing-page";
import { getServerSession } from "@/lib/server-session";
import { baseOpenGraph, defaultDescription, defaultTitle, siteName, siteOrigin } from "@/lib/seo";

export const metadata: Metadata = {
  title: defaultTitle,
  description: defaultDescription,
  alternates: { canonical: "/" },
  openGraph: { ...baseOpenGraph, url: "/" },
};

// One script, three entities: the app itself, the org behind it (Google's
// entity anchor for the whole domain), and the site. Marketing-only — the
// logged-in app ships no marketing schema.
const homeJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: siteName,
    url: siteOrigin,
    description: defaultDescription,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteName,
    url: siteOrigin,
    logo: `${siteOrigin}/icon.svg`,
    email: "support@ultra-vora.com",
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    url: siteOrigin,
  },
];

export default async function Page(): Promise<React.ReactElement> {
  const session = await getServerSession();
  // Auth-API outage degrades here too (getServerSession → null): logged-in
  // users briefly see the marketing page; CTA → /login self-heals.
  if (!session)
    return (
      <>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(homeJsonLd) }} />
        <LandingPage />
      </>
    );
  return (
    <AppShell>
      <HomePage />
    </AppShell>
  );
}
