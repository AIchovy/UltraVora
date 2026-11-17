// apps/web/src/app/sitemap.ts
import type { MetadataRoute } from "next";
import type { PublicVideoSummary } from "@ultracreator/shared";
import { blogPosts } from "@/lib/blog";
import { siteOrigin } from "@/lib/seo";

// ISR: refresh hourly so newly published plaza videos get picked up.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // No /login here on purpose: sitemaps are for pages worth ranking, and a
  // sign-in form isn't one (it stays crawlable, just not advertised).
  const pages: MetadataRoute.Sitemap = [
    { url: `${siteOrigin}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${siteOrigin}/plaza`, changeFrequency: "daily", priority: 0.9 },
    { url: `${siteOrigin}/pricing`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${siteOrigin}/blog`, changeFrequency: "weekly", priority: 0.8 },
    ...blogPosts.map((p) => ({
      url: `${siteOrigin}/blog/${p.slug}`,
      lastModified: new Date(`${p.updated ?? p.published}T00:00:00Z`),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${siteOrigin}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteOrigin}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
  // Server side talks to Fastify directly, same as getServerSession. At Docker
  // build time the API is unreachable — the catch ships just the static pages
  // and the revalidate above fills the videos in at runtime.
  const apiOrigin = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";
  try {
    const res = await fetch(`${apiOrigin}/api/public/videos?sort=recent`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return pages;
    const videos = (await res.json()) as PublicVideoSummary[];
    return [
      ...pages,
      ...videos.map((v) => ({
        url: `${siteOrigin}/v/${v.sid}`,
        lastModified: new Date(v.createdAt),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      })),
    ];
  } catch {
    return pages;
  }
}
