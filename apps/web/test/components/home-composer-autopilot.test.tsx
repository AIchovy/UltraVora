// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession } from "@/lib/api-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
  postMessage: vi.fn(async () => {}),
  getCredits: vi.fn(() => new Promise<never>(() => {})),
}));

function renderComposer() {
  return renderWithQuery(
    <HomeComposer
      text="A promo for Acme"
      onTextChange={() => {}}
      duration={30}
      onDurationChange={() => {}}
      aspect="16:9"
      onAspectChange={() => {}}
      placeholder="describe…"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> auto-pilot", () => {
  it("defaults to Auto-pilot and sends autoApprove:true on generate", async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Auto-pilot");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: true }));
  });

  it("picking Chat persists OFF and sends autoApprove:false", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /mode/i }));
    await user.click(await screen.findByRole("menuitem", { name: /chat/i }));
    expect(localStorage.getItem("uc.autoApprove")).toBe("false");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: false }));
  });

  it("starts as Chat when localStorage says so", async () => {
    localStorage.setItem("uc.autoApprove", "false");
    renderComposer();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Chat"),
    );
  });
});
