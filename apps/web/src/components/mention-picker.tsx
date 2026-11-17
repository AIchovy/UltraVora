"use client";
import { cn } from "@/lib/utils";

export interface MentionItem {
  label: string;
  previewUrl: string | null;
}

interface Props {
  items: MentionItem[];
  activeIndex: number;
  onSelect: (label: string) => void;
}

export function MentionPicker({ items, activeIndex, onSelect }: Props): React.ReactElement {
  return (
    <ul
      role="listbox"
      aria-label="reference an image"
      className="absolute bottom-full left-0 z-50 mb-2 max-h-56 w-56 overflow-y-auto rounded-xl border bg-popover p-1 shadow-pop"
    >
      {items.map((item, i) => (
        <li key={item.label} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            // Prevent the textarea from losing focus before onSelect runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(item.label)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
            )}
          >
            {item.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
            ) : (
              <span className="h-6 w-6 rounded bg-muted" />
            )}
            <span className="font-medium">@{item.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
