// apps/web/src/app/robots.ts
import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // /s/ is the private session workspace (logged-out visits redirect to
      // /login); /api/ is the reverse proxy to the Fastify API — no crawlable
      // content behind either.
      { userAgent: "*", allow: "/", disallow: ["/s/", "/api/"] },
    ],
    sitemap: `${siteOrigin}/sitemap.xml`,
  };
}
