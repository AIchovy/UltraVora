// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import BlogIndexPage, { metadata as blogIndexMetadata } from "@/app/blog/page";
import BlogPostPage, {
  generateMetadata as postGenerateMetadata,
  generateStaticParams,
  dynamicParams,
} from "@/app/blog/[slug]/page";
import { blogPosts } from "@/lib/blog";

const first = blogPosts[0]!;
const params = (slug: string): { params: Promise<{ slug: string }> } => ({
  params: Promise.resolve({ slug }),
});

function jsonLdTypes(): string[] {
  return [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
    const parsed = JSON.parse(s.textContent ?? "{}") as
      | Record<string, unknown>
      | Record<string, unknown>[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((e) => String(e["@type"]));
  });
}

describe("/blog index", () => {
  it("has canonical /blog metadata", () => {
    expect(blogIndexMetadata.alternates?.canonical).toBe("/blog");
    expect(blogIndexMetadata.title).toMatch(/blog/i);
    expect(blogIndexMetadata.description).toBeTruthy();
    expect(blogIndexMetadata.openGraph?.url).toBe("/blog");
  });

  it("renders one h1 and a crawlable link to every post", () => {
    render(<BlogIndexPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const post of blogPosts) {
      expect(screen.getByRole("link", { name: post.title })).toHaveAttribute(
        "href",
        `/blog/${post.slug}`,
      );
    }
  });

  it("embeds Blog JSON-LD listing every post", () => {
    render(<BlogIndexPage />);
    const script = document.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script?.textContent ?? "{}") as {
      "@type": string;
      blogPost: { url: string }[];
    };
    expect(data["@type"]).toBe("Blog");
    expect(data.blogPost).toHaveLength(blogPosts.length);
  });
});

describe("/blog/[slug]", () => {
  it("statically generates exactly the registry slugs and rejects the rest", () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams().map((p) => p.slug).sort()).toEqual(
      blogPosts.map((p) => p.slug).sort(),
    );
  });

  it("builds article metadata with canonical + published time", async () => {
    const meta = await postGenerateMetadata(params(first.slug));
    expect(meta.title).toBe(`${first.title} — UltraVora`);
    expect(meta.description).toBe(first.description);
    expect(meta.alternates?.canonical).toBe(`/blog/${first.slug}`);
    const og = meta.openGraph as { type?: string; publishedTime?: string; url?: string };
    expect(og.type).toBe("article");
    expect(og.publishedTime).toBe(first.published);
    expect(og.url).toBe(`/blog/${first.slug}`);
  });

  it("returns empty metadata for unknown slugs (page 404s separately)", async () => {
    expect(await postGenerateMetadata(params("no-such-post"))).toEqual({});
  });

  it("renders the article with BlogPosting + BreadcrumbList JSON-LD, related posts, and a CTA", async () => {
    render(await BlogPostPage(params(first.slug)));
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(first.title);

    const types = jsonLdTypes();
    expect(types).toContain("BlogPosting");
    expect(types).toContain("BreadcrumbList");

    // Related rail links to the hand-picked posts.
    const related = screen.getByRole("region", { name: /related articles/i });
    for (const slug of first.related) {
      expect(
        within(related).getByRole("link", { name: blogPosts.find((p) => p.slug === slug)!.title }),
      ).toHaveAttribute("href", `/blog/${slug}`);
    }

    // Conversion CTA present.
    expect(screen.getByRole("link", { name: /make a free video/i })).toHaveAttribute(
      "href",
      "/login",
    );

    // Breadcrumb navigation is real, visible markup.
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
  });

  it("throws notFound for an unknown slug", async () => {
    await expect(BlogPostPage(params("no-such-post"))).rejects.toThrow();
  });
});
