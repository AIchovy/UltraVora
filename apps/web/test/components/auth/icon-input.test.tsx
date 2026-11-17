// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { User } from "lucide-react";
import { IconInput } from "@/components/auth/icon-input";

describe("IconInput", () => {
  it("renders a leading icon and pads the input to clear it", () => {
    const { container } = render(<IconInput icon={User} placeholder="Nickname" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("input")).toHaveClass("pl-9");
  });

  it("forwards input props through (type, placeholder)", () => {
    const { container } = render(<IconInput icon={User} type="password" placeholder="Password" />);
    const input = container.querySelector("input")!;
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("placeholder", "Password");
  });

  it("tints the icon destructive alongside the input when aria-invalid", () => {
    const { container } = render(<IconInput icon={User} aria-invalid />);
    expect(container.querySelector("svg")).toHaveClass("text-destructive");
  });

  it("uses the muted icon color when valid", () => {
    const { container } = render(<IconInput icon={User} />);
    expect(container.querySelector("svg")).toHaveClass("text-muted-foreground");
  });
});
