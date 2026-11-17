"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv, Loader2, LayoutGrid } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Sidebar, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { LogoMark } from "@/components/logo";
import { SidebarUser } from "@/components/sidebar-user";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteSession } from "@/lib/api-client";
import { useSessions } from "@/state/use-sessions";
import type { SessionSummary } from "@/lib/api-types";

const TASK_ICONS: LucideIcon[] = [Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv];

export function taskIcon(id: string): LucideIcon {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TASK_ICONS[h % TASK_ICONS.length]!;
}

// Zone boundary — a hairline that fades at both ends, per the theme's
// "depth over strokes" rule (no hard full-width borders). The peak is a
// foreground alpha, not --color-border: the border token (L 0.915) is nearly
// the same lightness as the sidebar rail (L 0.92) and vanishes on it.
function SidebarDivider({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      role="separator"
      className={cn(
        "mx-4 h-px shrink-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent",
        className,
      )}
    />
  );
}

export function AppSidebar(): React.ReactElement {
  const { open, isMobile, setOpen } = useSidebar();
  const router = useRouter();
  const pathname = usePathname();
  const activeSid = pathname.startsWith("/s/") ? pathname.slice(3) : null;
  const qc = useQueryClient();
  const { data: sessions = [] } = useSessions();

  const closeIfMobile = () => {
    if (isMobile) setOpen(false);
  };

  async function handleDelete(s: SessionSummary) {
    try {
      await deleteSession(s.id);
    } catch {
      /* may already be gone */
    }
    await qc.invalidateQueries({ queryKey: ["sessions"] });
    if (s.id === activeSid) router.push("/");
  }

  return (
    <Sidebar>
      {/* Brand + collapse toggle */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        {open ? (
          <>
            <Link
              href="/"
              onClick={closeIfMobile}
              aria-label="UltraVora home"
              className="group flex min-w-0 items-center gap-2"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs transition-colors group-hover:bg-primary/80">
                <LogoMark className="h-5 w-5" />
              </span>
              <span className="truncate text-[15px] font-semibold tracking-tight transition-colors group-hover:text-foreground/70">
                UltraVora
              </span>
            </Link>
            <SidebarTrigger className="ml-auto" />
          </>
        ) : (
          <SidebarTrigger className="mx-auto" />
        )}
      </div>

      {/* New task — entry point is Home */}
      <div className="px-3">
        <Button
          onClick={() => {
            router.push("/");
            closeIfMobile();
          }}
          className={cn("rounded-xl shadow-xs", open ? "w-full justify-center" : "mx-auto h-9 w-9 p-0")}
          aria-label="New task"
        >
          <Plus className="h-4 w-4" />
          {open && "New task"}
        </Button>
      </div>

      <SidebarDivider className="mt-4 mb-2" />

      {/* Product Plaza — public gallery of everyone's public videos */}
      <nav className="px-2">
        <Link
          href="/plaza"
          onClick={closeIfMobile}
          aria-current={pathname === "/plaza" ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
            pathname === "/plaza"
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
            !open && "justify-center px-0",
          )}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          {open && <span className="flex-1 truncate">Product Plaza</span>}
        </Link>
      </nav>

      <SidebarDivider className="mt-4 mb-3" />

      {/* Tasks */}
      <div className="flex min-h-0 flex-1 flex-col">
        {open && (
          <div className="flex items-center gap-2 px-4 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tasks
            {sessions.length > 0 && (
              <span
                data-testid="task-count"
                className="rounded-full bg-foreground/[0.06] px-1.5 py-px font-mono text-[11px] font-medium normal-case tabular-nums"
              >
                {sessions.length}
              </span>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            open && <p className="px-2 py-2 text-xs text-muted-foreground">No tasks yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((s) => {
                const active = s.id === activeSid;
                const Icon = taskIcon(s.id);
                // "running" = the video is still being generated. Swap the task
                // icon for a spinner so the rail shows which task is working
                // (works the same in the collapsed icon-only rail).
                const generating = s.status === "running";
                return (
                  <li key={s.id} className="group/item">
                    <Link
                      href={`/s/${s.id}`}
                      onClick={closeIfMobile}
                      title={s.title ?? "Untitled"}
                      aria-busy={generating}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                        !open && "justify-center px-0",
                      )}
                    >
                      {generating ? (
                        <Loader2 data-testid="session-spinner" aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <Icon className="h-4 w-4 shrink-0" />
                      )}
                      {open && <span className="flex-1 truncate">{s.title ?? "Untitled"}</span>}
                      {open && (
                        <button
                          type="button"
                          aria-label={`delete ${s.title ?? "Untitled"}`}
                          onClick={(e) => {
                            e.preventDefault();
                            void handleDelete(s);
                          }}
                          className="opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <SidebarUser />
    </Sidebar>
  );
}
