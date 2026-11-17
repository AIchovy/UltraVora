import Link from "next/link";
import { LogoMark } from "@/components/logo";

export function LandingFooter(): React.ReactElement {
  return (
    <footer className="border-t border-border/60 bg-muted/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <LogoMark className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">UltraVora</div>
            <div className="text-xs text-muted-foreground">Promo videos for your product.</div>
          </div>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
          <a href="/#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <Link href="/pricing" className="transition-colors hover:text-foreground">
            Pricing
          </Link>
          <Link href="/blog" className="transition-colors hover:text-foreground">
            Blog
          </Link>
          <Link href="/plaza" className="transition-colors hover:text-foreground">
            Product Plaza
          </Link>
          <a href="/#faq" className="transition-colors hover:text-foreground">
            FAQ
          </a>
          <Link href="/privacy" className="transition-colors hover:text-foreground">
            Privacy Policy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-foreground">
            Terms of Service
          </Link>
          <Link href="/login" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground/70">© 2026 UltraVora. All rights reserved.</p>
      </div>
    </footer>
  );
}
