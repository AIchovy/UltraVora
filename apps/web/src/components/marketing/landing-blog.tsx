// apps/web/src/components/marketing/landing-blog.tsx
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PostCard } from "@/components/blog/post-card";
import { blogPosts } from "@/lib/blog";

/** Latest guides on the homepage — internal links that lead crawlers (and people) into the blog. */
export function LandingBlog(): React.ReactElement {
  const latest = blogPosts.slice(0, 3);
  if (latest.length === 0) return <></>;
  return (
    <section id="blog" className="border-t border-border/60">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 md:py-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">From the blog</h2>
            <p className="mt-3 max-w-xl text-muted-foreground">
              Practical guides on scripts, lengths, formats, and voices — everything that makes a
              promo video work.
            </p>
          </div>
          <Link
            href="/blog"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            View all posts
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {latest.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}
