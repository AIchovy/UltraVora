// apps/web/src/lib/blog.ts
import type { ComponentType } from "react";
import { post as aiVideoAdsForSmallBusiness } from "@/content/blog/ai-video-ads-for-small-business";
import { post as aiVoiceoverForProductVideos } from "@/content/blog/ai-voiceover-for-product-videos";
import { post as howLongShouldAPromoVideoBe } from "@/content/blog/how-long-should-a-promo-video-be";
import { post as howToMakeAPromoVideoWithAi } from "@/content/blog/how-to-make-a-promo-video-with-ai";
import { post as productDemoVideoWithoutAFilmCrew } from "@/content/blog/product-demo-video-without-a-film-crew";
import { post as promoVideoScriptTemplates } from "@/content/blog/promo-video-script-templates";
import { post as turnYourWebsiteIntoAVideo } from "@/content/blog/turn-your-website-into-a-video";
import { post as videoAspectRatiosForSocialMedia } from "@/content/blog/video-aspect-ratios-for-social-media";

export interface BlogPost {
  /** URL segment under /blog/. */
  slug: string;
  /** H1 and <title> stem — keep under ~60 chars so search results don't truncate it. */
  title: string;
  /** Meta description; aim for 70–160 chars. */
  description: string;
  /** ISO yyyy-mm-dd publish date; doubles as the sitemap lastmod unless `updated` is set. */
  published: string;
  /** ISO yyyy-mm-dd of the last substantive edit. */
  updated?: string;
  tags: string[];
  /** Hand-set estimate; the test suite cross-checks it against the rendered word count. */
  readingMinutes: number;
  /** Slugs of hand-picked related posts, rendered under the article. */
  related: string[];
  /** Article body — a server-renderable component (no hooks, no state). */
  Body: ComponentType;
}

export const blogTitle = "UltraVora Blog";
export const blogDescription =
  "Practical guides on AI video: making promo videos from a prompt, writing scripts that sell, choosing lengths, formats, and voices that fit your brand.";

/** All posts, newest first (ties broken by slug for a stable order). */
export const blogPosts: BlogPost[] = [
  howToMakeAPromoVideoWithAi,
  promoVideoScriptTemplates,
  howLongShouldAPromoVideoBe,
  turnYourWebsiteIntoAVideo,
  aiVideoAdsForSmallBusiness,
  videoAspectRatiosForSocialMedia,
  aiVoiceoverForProductVideos,
  productDemoVideoWithoutAFilmCrew,
].sort((a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug));

export function getPost(slug: string): BlogPost | undefined {
  return blogPosts.find((p) => p.slug === slug);
}

/** Resolve a post's hand-picked related slugs to posts, skipping any that vanish. */
export function relatedPosts(slug: string): BlogPost[] {
  const post = getPost(slug);
  if (!post) return [];
  return post.related
    .map((s) => getPost(s))
    .filter((p): p is BlogPost => p !== undefined && p.slug !== slug);
}

/** Display date like "August 17, 2026" — rendered server-side so it never hydrates differently. */
export function formatPostDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
