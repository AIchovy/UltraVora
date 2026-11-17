// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { blogPosts, getPost, relatedPosts, formatPostDate } from "@/lib/blog";

function bodyText(slug: string): string {
  const post = getPost(slug)!;
  const { container, unmount } = render(<post.Body />);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

function bodyHtml(slug: string): string {
  const post = getPost(slug)!;
  const { container, unmount } = render(<post.Body />);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("blog registry", () => {
  it("has at least 8 posts with unique kebab-case slugs", () => {
    expect(blogPosts.length).toBeGreaterThanOrEqual(8);
    const slugs = blogPosts.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("keeps titles and descriptions inside search-result limits", () => {
    for (const p of blogPosts) {
      // Titles get " — UltraVora" appended (12 chars); keep the stem short
      // enough that the important words survive the SERP cut.
      expect(p.title.length, p.slug).toBeLessThanOrEqual(70);
      expect(p.description.length, p.slug).toBeGreaterThanOrEqual(70);
      expect(p.description.length, p.slug).toBeLessThanOrEqual(170);
    }
  });

  it("uses valid ISO dates and sorts newest-first", () => {
    for (const p of blogPosts) {
      expect(p.published, p.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(p.published)), p.slug).toBe(false);
      if (p.updated) expect(Date.parse(p.updated)).toBeGreaterThanOrEqual(Date.parse(p.published));
    }
    const dates = blogPosts.map((p) => p.updated ?? p.published);
    const sorted = [...blogPosts].sort(
      (a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug),
    );
    expect(blogPosts.map((p) => p.slug)).toEqual(sorted.map((p) => p.slug));
    expect(dates.length).toBe(blogPosts.length);
  });

  it("every related slug resolves to a real, different post", () => {
    for (const p of blogPosts) {
      expect(p.related.length, p.slug).toBeGreaterThanOrEqual(2);
      for (const r of p.related) {
        expect(r, `${p.slug} → ${r}`).not.toBe(p.slug);
        expect(getPost(r), `${p.slug} → ${r}`).toBeDefined();
      }
      expect(relatedPosts(p.slug).map((x) => x.slug)).toEqual(p.related);
    }
  });

  it("every body is substantive and its reading time is honest", () => {
    const counts = blogPosts.map((p) => ({
      slug: p.slug,
      stated: p.readingMinutes,
      words: bodyText(p.slug).split(/\s+/).filter(Boolean).length,
    }));
    for (const c of counts) {
      expect(c.words, `${c.slug} has ${c.words} words`).toBeGreaterThanOrEqual(700);
      const computed = Math.round(c.words / 200);
      expect(Math.abs(c.stated - computed), `${c.slug}: stated ${c.stated}, ≈${computed}`).toBeLessThanOrEqual(2);
    }
  });

  it("every body links to the product and cross-links other posts", () => {
    for (const p of blogPosts) {
      const html = bodyHtml(p.slug);
      // At least one conversion path…
      expect(html, p.slug).toMatch(/href="\/(login|pricing|plaza)"/);
      // …and at least two internal blog cross-links for crawl depth.
      const blogLinks = [...html.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1]!);
      expect(blogLinks.length, p.slug).toBeGreaterThanOrEqual(2);
      for (const target of blogLinks) {
        expect(getPost(target), `${p.slug} links to missing /blog/${target}`).toBeDefined();
        expect(target).not.toBe(p.slug);
      }
    }
  });

  it("formatPostDate renders a stable US date in UTC", () => {
    expect(formatPostDate("2026-08-17")).toBe("August 17, 2026");
  });
});
