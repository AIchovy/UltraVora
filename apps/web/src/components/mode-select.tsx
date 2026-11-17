"use client";
import { MessageSquare, Rocket, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface Props {
  autoApprove: boolean;
  onChange: (value: boolean) => void;
}

export function ModeSelect({ autoApprove, onChange }: Props): React.ReactElement {
  const Icon = autoApprove ? Rocket : MessageSquare;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="mode"
        className="cursor-pointer inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon className="h-4 w-4" />
        <span>{autoApprove ? "Auto-pilot" : "Chat"}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onChange(false)}>
          <MessageSquare className="h-4 w-4" />
          <span>Chat</span>
          <span className="ml-auto text-[11px] text-muted-foreground">Manual</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(true)}>
          <Rocket className="h-4 w-4" />
          <span>Auto-pilot</span>
          <span className="ml-auto text-[11px] text-muted-foreground">Auto</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
