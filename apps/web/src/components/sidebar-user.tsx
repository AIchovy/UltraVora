"use client";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { authClient, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function SidebarUser(): React.ReactElement | null {
  const { open } = useSidebar();
  const router = useRouter();
  const { data: session } = useSession();
  if (!session) return null;
  const { name, email, image } = session.user;
  const initials = (name || email || "?").slice(0, 2).toUpperCase();

  async function handleSignOut(): Promise<void> {
    try {
      const { error } = await authClient.signOut();
      if (error) {
        toast.error("Sign out failed. Please try again.");
        return;
      }
    } catch {
      toast.error("Could not reach the server to sign out.");
      return;
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="px-2 pb-2">
      <div
        role="separator"
        className="mx-2 mb-2 h-px shrink-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-card/60",
              !open && "justify-center px-0",
            )}
          >
            <Avatar className="h-7 w-7">
              {image ? <AvatarImage src={image} alt={name} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            {open && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">{email}</span>
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            {email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSignOut()}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
