"use client";
import Link from "next/link";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import { LogoMark } from "@/components/logo";
import { CreditsBadge } from "./credits-badge";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children: React.ReactNode;
  /** "header" (default): badge in a bar above the content. "floating": no
   *  desktop bar — the badge floats over the content's top-right corner so
   *  full-height layouts (the studio) keep every pixel. The mobile bar always
   *  stays: it carries the sidebar trigger. */
  creditsPlacement?: "header" | "floating";
}

export function AppShell({ children, creditsPlacement = "header" }: AppShellProps): React.ReactElement {
  return (
    <SidebarProvider>
      <div className="flex h-[100dvh] bg-background">
        <AppSidebar />
        <Main floating={creditsPlacement === "floating"}>{children}</Main>
      </div>
    </SidebarProvider>
  );
}

function Main({ children, floating }: { children: React.ReactNode; floating: boolean }): React.ReactElement {
  const { isMobile } = useSidebar();
  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-3", floating && "md:hidden")}>
        {isMobile && (
          <>
            <SidebarTrigger />
            <Link href="/" aria-label="UltraVora home" className="group flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors group-hover:bg-primary/80">
                <LogoMark className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold tracking-tight transition-colors group-hover:text-foreground/70">
                UltraVora
              </span>
            </Link>
          </>
        )}
        <div className="ml-auto">
          <CreditsBadge />
        </div>
      </header>
      {floating && (
        <div data-slot="credits-overlay" className="absolute right-4 top-3.5 z-30 hidden md:block">
          <CreditsBadge />
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </main>
  );
}
