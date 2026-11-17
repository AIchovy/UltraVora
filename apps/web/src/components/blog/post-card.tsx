// apps/web/src/components/blog/post-card.tsx
import Link from "next/link";
import type { BlogPost } from "@/lib/blog";
import { formatPostDate } from "@/lib/blog";

/** Server-rendered card used on the blog index, related-posts rails, and the landing teaser. */
export function PostCard({ post }: { post: BlogPost }): React.ReactElement {
  return (
    <article className="group relative flex h-full flex-col rounded-2xl border border-border/70 bg-card p-6 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-raised">
      <p className="text-xs text-muted-foreground">
        <time dateTime={post.published}>{formatPostDate(post.published)}</time>
        <span aria-hidden="true"> · </span>
        {post.readingMinutes} min read
      </p>
      <h3 className="mt-2 text-base font-semibold leading-snug tracking-tight">
        <Link
          href={`/blog/${post.slug}`}
          className="after:absolute after:inset-0 after:rounded-2xl group-hover:underline"
        >
          {post.title}
        </Link>
      </h3>
      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {post.description}
      </p>
      <p className="mt-auto pt-4 text-xs font-medium text-muted-foreground">
        {post.tags.join(" · ")}
      </p>
    </article>
  );
}
