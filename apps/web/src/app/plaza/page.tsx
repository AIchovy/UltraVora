// apps/web/src/app/plaza/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ProductPlaza } from "@/components/plaza/product-plaza";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/server-session";
import { fetchPublicVideos } from "@/lib/public-videos-server";
import { baseOpenGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Product Plaza — UltraVora",
  description: "Public promo videos from the UltraVora community.",
  alternates: { canonical: "/plaza" },
  openGraph: {
    ...baseOpenGraph,
    title: "Product Plaza — UltraVora",
    description: "Public promo videos from the UltraVora community.",
    url: "/plaza",
  },
};

export default async function PlazaPage(): Promise<React.ReactElement> {
  // Fetch server-side so the HTML ships the real grid — crawlers see (and
  // follow) the /v/… links instead of a skeleton. null → client fetch fallback.
  const [session, videos] = await Promise.all([getServerSession(), fetchPublicVideos()]);
  const initialVideos = videos ?? undefined;
  if (session) {
    return (
      <AppShell>
        <div className="h-full overflow-y-auto">
          <ProductPlaza loggedIn initialVideos={initialVideos} />
        </div>
      </AppShell>
    );
  }
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="flex h-14 items-center gap-2 px-4">
        <Link href="/" aria-label="UltraVora home" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraVora</span>
        </Link>
        <div className="ml-auto">
          <Button asChild size="sm">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </header>
      <ProductPlaza loggedIn={false} initialVideos={initialVideos} />
    </div>
  );
}
