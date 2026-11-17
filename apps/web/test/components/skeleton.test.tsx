// @vitest-environment jsdom
// apps/web/test/components/skeleton.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "@/components/ui/skeleton";

describe("<Skeleton>", () => {
  it("renders a pulsing muted block tagged data-slot=skeleton", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).not.toBeNull();
    expect(el).toHaveClass("animate-pulse", "bg-muted", "rounded-md");
  });

  it("merges a custom className over the defaults", () => {
    const { container } = render(<Skeleton className="h-4 w-40" />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass("h-4", "w-40", "animate-pulse");
  });
});
