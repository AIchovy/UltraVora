// apps/web/src/app/blog/[slug]/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandingFooter } from "@/components/marketing/landing-footer";
import { LandingHeader } from "@/components/marketing/landing-header";
import { PostCard } from "@/components/blog/post-card";
import { PostCta } from "@/components/blog/post-cta";
import { blogPosts, formatPostDate, getPost, relatedPosts } from "@/lib/blog";
import { baseOpenGraph, siteName, siteOrigin } from "@/lib/seo";

// Every post is known at build time; anything else is a real 404.
export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return blogPosts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  const title = `${post.title} — ${siteName}`;
  return {
    title,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      ...baseOpenGraph,
      type: "article",
      title,
      description: post.description,
      url: `/blog/${post.slug}`,
      publishedTime: post.published,
      modifiedTime: post.updated ?? post.published,
      authors: [siteName],
      tags: post.tags,
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const related = relatedPosts(post.slug);

  const postJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.published,
    dateModified: post.updated ?? post.published,
    author: { "@type": "Organization", name: siteName, url: siteOrigin },
    publisher: { "@type": "Organization", name: siteName, url: siteOrigin },
    image: `${siteOrigin}/opengraph-image`,
    mainEntityOfPage: `${siteOrigin}/blog/${post.slug}`,
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: siteOrigin },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${siteOrigin}/blog` },
      { "@type": "ListItem", position: 3, name: post.title, item: `${siteOrigin}/blog/${post.slug}` },
    ],
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(postJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <LandingHeader />
      <main>
        <article className="mx-auto w-full max-w-3xl px-6 py-16 md:py-20">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-1.5">
              <li>
                <Link href="/" className="transition-colors hover:text-foreground">
                  Home
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li>
                <Link href="/blog" className="transition-colors hover:text-foreground">
                  Blog
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li aria-current="page" className="truncate text-foreground/80">
                {post.title}
              </li>
            </ol>
          </nav>
          <header className="mt-6">
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{post.title}</h1>
            <p className="mt-4 text-sm text-muted-foreground">
              By {siteName} Team
              <span aria-hidden="true"> · </span>
              <time dateTime={post.published}>{formatPostDate(post.published)}</time>
              <span aria-hidden="true"> · </span>
              {post.readingMinutes} min read
            </p>
          </header>
          <div className="prose prose-neutral mt-8 max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-muted-foreground prose-a:font-medium prose-a:text-foreground prose-th:text-foreground prose-td:text-muted-foreground">
            <post.Body />
          </div>
          <PostCta />
          {related.length > 0 && (
            <section aria-label="Related articles" className="mt-14">
              <h2 className="text-xl font-semibold tracking-tight">Keep reading</h2>
              <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {related.map((p) => (
                  <PostCard key={p.slug} post={p} />
                ))}
              </div>
            </section>
          )}
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
