// apps/web/src/app/llms.txt/route.ts
// llms.txt (https://llmstxt.org): a markdown map of the site for AI crawlers
// and answer engines — the AI-search counterpart of sitemap.xml. Built from
// the blog registry so it never goes stale.
import { blogPosts } from "@/lib/blog";
import { defaultDescription, siteName, siteOrigin } from "@/lib/seo";

export const dynamic = "force-static";

export function GET(): Response {
  const lines = [
    `# ${siteName}`,
    "",
    `> ${defaultDescription}`,
    "",
    "UltraVora is an AI video agent: give it a prompt or a product URL and it researches the product, drafts a creative brief and script for your approval, records an AI voiceover, and renders a finished promo video in widescreen (16:9), vertical (9:16), or square (1:1), from 15 seconds to 3 minutes, captions included.",
    "",
    "## Pages",
    "",
    `- [Home](${siteOrigin}/): what ${siteName} is and how the agent works`,
    `- [Pricing](${siteOrigin}/pricing): usage-based credits — a typical one-minute promo is about 400 credits`,
    `- [Product Plaza](${siteOrigin}/plaza): public gallery of promo videos made with ${siteName}`,
    "",
    "## Blog",
    "",
    ...blogPosts.map((p) => `- [${p.title}](${siteOrigin}/blog/${p.slug}): ${p.description}`),
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
