// apps/web/src/app/v/[sid]/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "@/components/logo";
import { PublicVideoView } from "@/components/plaza/public-video-view";
import { fetchPublicVideo } from "@/lib/public-videos-server";
import { baseOpenGraph, siteName, siteOrigin } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sid: string }>;
}): Promise<Metadata> {
  const { sid } = await params;
  // Same fetcher (URL + options) as the page body, so Next dedupes the two
  // calls into one request. Share crawlers (WhatsApp, Twitter, Slack…) only
  // read these tags.
  const lookup = await fetchPublicVideo(sid);
  if (lookup.status !== "found") {
    // Unknown/unpublished sid or API hiccup: keep the shell out of the index.
    return { title: "Video — UltraVora", robots: { index: false } };
  }
  const video = lookup.video;
  const title = `${video.title ?? "Untitled video"} — UltraVora`;
  const description = `Watch this AI-generated promo video by ${video.author.name} on UltraVora.`;
  return {
    title,
    description,
    alternates: { canonical: `/v/${sid}` },
    openGraph: {
      ...baseOpenGraph,
      type: "video.other",
      title,
      description,
      url: `/v/${sid}`,
      // Relative on purpose: resolves against metadataBase to the web
      // origin, whose /api/* rewrite proxies the stream to Fastify.
      videos: [{ url: `/api/public/videos/${sid}/video` }],
    },
  };
}

const FOOTER_LINKS = [
  { label: "Home", href: "/" },
  { label: "Product Plaza", href: "/plaza" },
  { label: "Blog", href: "/blog" },
  { label: "Pricing", href: "/pricing" },
] as const;

export default async function PublicVideoPage({
  params,
}: {
  params: Promise<{ sid: string }>;
}): Promise<React.ReactElement> {
  const { sid } = await params;
  const lookup = await fetchPublicVideo(sid);
  // A confirmed-missing video is a real 404, not a 200 shell that says
  // "Video not found" (crawlers treat those as soft 404s). API outages keep
  // the old behavior: render the shell, let the client fetch retry.
  if (lookup.status === "missing") notFound();
  const video = lookup.status === "found" ? lookup.video : undefined;

  const videoJsonLd = video && {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.title ?? "Untitled video",
    description: `AI-generated promo video by ${video.author.name} on ${siteName}.`,
    uploadDate: video.createdAt,
    contentUrl: `${siteOrigin}/api/public/videos/${sid}/video`,
    thumbnailUrl: `${siteOrigin}/opengraph-image`,
    publisher: { "@type": "Organization", name: siteName, url: siteOrigin },
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      {videoJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(videoJsonLd) }}
        />
      )}
      <header className="flex h-14 items-center gap-2 px-4">
        <Link href="/plaza" aria-label="Product Plaza" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraVora</span>
        </Link>
      </header>
      <main className="flex-1">
        <PublicVideoView sid={sid} initialVideo={video} />
      </main>
      <footer className="border-t border-border/60 bg-muted/40">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 px-4 py-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <p className="text-sm text-muted-foreground">
            Made with {siteName} —{" "}
            <Link href="/login" className="font-medium text-foreground hover:underline">
              turn a prompt into a promo video
            </Link>
          </p>
          <nav aria-label="Site" className="flex flex-wrap items-center justify-center gap-4 text-sm text-muted-foreground">
            {FOOTER_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="transition-colors hover:text-foreground">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
