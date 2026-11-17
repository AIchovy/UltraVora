// apps/web/src/app/not-found.tsx
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

/** Root 404 — served with a real 404 status wherever notFound() fires. */
export default function NotFound(): React.ReactElement {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-6 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
        <LogoMark className="h-6 w-6" />
      </span>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
        The page you&rsquo;re looking for doesn&rsquo;t exist or is no longer public.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link href="/">Go home</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/plaza">Browse the Plaza</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/blog">Read the blog</Link>
        </Button>
      </div>
    </div>
  );
}
