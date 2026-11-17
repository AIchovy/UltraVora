import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/** Text input with a leading icon; forwards every <input> prop through.
 *  The icon turns red alongside the input when aria-invalid is set. */
export function IconInput({
  icon: Icon,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { icon: LucideIcon }): React.ReactElement {
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true";
  return (
    <div className="relative">
      <Icon
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2",
          invalid ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <Input className={cn("pl-9", className)} {...props} />
    </div>
  );
}
