import { Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The credits currency mark — a filled sparkle that stands in for the old ✦
 * glyph. Centralized so the credit icon can be swapped in one place; callers
 * set size and color via className (e.g. "size-4 text-primary").
 */
export function CreditMark({ className }: { className?: string }): React.ReactElement {
  return <Sparkle aria-hidden className={cn("shrink-0 fill-current", className)} />;
}
