// apps/web/src/app/blog/page.tsx
import type { Metadata } from "next";
import { LandingFooter } from "@/components/marketing/landing-footer";
import { LandingHeader } from "@/components/marketing/landing-header";
import { PostCard } from "@/components/blog/post-card";
import { blogDescription, blogPosts, blogTitle } from "@/lib/blog";
import { baseOpenGraph, siteName, siteOrigin } from "@/lib/seo";

const title = `Blog — ${siteName}`;

export const metadata: Metadata = {
  title,
  description: blogDescription,
  alternates: { canonical: "/blog" },
  openGraph: { ...baseOpenGraph, title, description: blogDescription, url: "/blog" },
};

// Content ships with the build — render once, serve static HTML.
export const dynamic = "force-static";

const blogJsonLd = {
  "@context": "https://schema.org",
  "@type": "Blog",
  name: blogTitle,
  description: blogDescription,
  url: `${siteOrigin}/blog`,
  publisher: { "@type": "Organization", name: siteName, url: siteOrigin },
  blogPost: blogPosts.map((p) => ({
    "@type": "BlogPosting",
    headline: p.title,
    url: `${siteOrigin}/blog/${p.slug}`,
    datePublished: p.published,
  })),
};

export default function BlogIndexPage(): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd) }} />
      <LandingHeader />
      <main>
        <div className="mx-auto w-full max-w-6xl px-6 py-16 md:py-20">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {blogTitle}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Practical guides to AI video
            </h1>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">{blogDescription}</p>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {blogPosts.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
