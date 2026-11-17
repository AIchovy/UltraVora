"use client";
import * as React from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarContextValue {
  open: boolean;
  isMobile: boolean;
  setOpen: (o: boolean) => void;
  toggle: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within <SidebarProvider>");
  return ctx;
}

const STORAGE_KEY = "uc.sidebar.open";

function persist(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function SidebarProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpenState] = React.useState(true);
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 767px)") : null;
    const mobile = mq ? mq.matches : false;
    setIsMobile(mobile);
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setOpenState(stored !== null ? stored === "1" : !mobile);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const setOpen = React.useCallback((o: boolean) => {
    setOpenState(o);
    persist(o);
  }, []);
  const toggle = React.useCallback(
    () =>
      setOpenState((p) => {
        persist(!p);
        return !p;
      }),
    [],
  );

  return (
    <SidebarContext.Provider value={{ open, isMobile, setOpen, toggle }}>{children}</SidebarContext.Provider>
  );
}

export function Sidebar({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  const { open, isMobile, setOpen } = useSidebar();
  return (
    <>
      {isMobile && open && (
        <div className="fixed inset-0 z-40 bg-foreground/20 md:hidden" onClick={() => setOpen(false)} aria-hidden />
      )}
      <aside
        data-state={open ? "open" : "closed"}
        className={cn(
          "z-50 flex h-[100dvh] shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200 ease-in-out",
          "fixed inset-y-0 left-0 w-64",
          open ? "translate-x-0" : "-translate-x-full",
          "md:static md:translate-x-0",
          open ? "md:w-64" : "md:w-16",
          className,
        )}
      >
        {children}
      </aside>
    </>
  );
}

export function SidebarTrigger({ className }: { className?: string }): React.ReactElement {
  const { toggle } = useSidebar();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle sidebar"
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground",
        className,
      )}
    >
      <PanelLeft className="h-[18px] w-[18px]" />
    </button>
  );
}
