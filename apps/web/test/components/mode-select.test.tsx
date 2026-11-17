// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModeSelect } from "@/components/mode-select";
import { renderWithQuery } from "../helpers/render-with-query";

describe("<ModeSelect>", () => {
  it("shows the current mode label", () => {
    renderWithQuery(<ModeSelect autoApprove onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Auto-pilot");
  });

  it("shows Chat when auto-pilot is off", () => {
    renderWithQuery(<ModeSelect autoApprove={false} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Chat");
  });

  it("selecting Chat calls onChange(false)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ModeSelect autoApprove onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /mode/i }));
    await user.click(await screen.findByRole("menuitem", { name: /chat/i }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
