import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/logo";

// Absolute hrefs so the nav works from any marketing page (the homepage and the
// standalone /pricing page share this header). "/#features" scrolls on the
// homepage and navigates-then-scrolls from elsewhere.
const NAV = [
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Blog", href: "/blog" },
  { label: "FAQ", href: "/#faq" },
] as const;

export function LandingHeader(): React.ReactElement {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraVora</span>
        </Link>
        <nav aria-label="Landing sections" className="hidden items-center gap-6 sm:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login">Get started</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
