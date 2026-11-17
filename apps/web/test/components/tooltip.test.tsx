// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

describe("Tooltip", () => {
  it("renders without an explicit TooltipProvider ancestor", () => {
    // The audio player (and any future consumer) uses <Tooltip> standalone;
    // the component must bring its own provider.
    render(
      <Tooltip>
        <TooltipTrigger>hover me</TooltipTrigger>
        <TooltipContent>hint</TooltipContent>
      </Tooltip>,
    );
    expect(screen.getByText("hover me")).toBeInTheDocument();
  });
});
