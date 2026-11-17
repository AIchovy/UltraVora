// apps/web/src/lib/seo.ts
import type { Metadata } from "next";

/** Canonical public origin of the web app (no trailing slash). */
export const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://ultra-vora.com").replace(/\/$/, "");

export const siteName = "UltraVora";
export const defaultTitle = "UltraVora — Promo videos for your product";
export const defaultDescription =
  "Turn a single prompt into a finished promo video. UltraVora researches your product, writes the script, records the voiceover, and renders the final cut.";

// Next merges child metadata over parent SHALLOWLY per top-level key — a page
// that sets `openGraph` replaces the whole object. Pages spread this base so
// siteName/type survive their overrides.
export const baseOpenGraph = {
  siteName,
  type: "website",
  locale: "en_US",
  title: defaultTitle,
  description: defaultDescription,
} as const;

// Root-layout defaults inherited by every page. Deliberately NO `alternates`
// here: a root canonical would be inherited by pages that don't override it
// and canonicalize the whole site onto the homepage. Pages own their canonicals.
export const rootMetadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: defaultTitle,
  description: defaultDescription,
  applicationName: siteName,
  openGraph: { ...baseOpenGraph },
  twitter: { card: "summary_large_image" },
};
