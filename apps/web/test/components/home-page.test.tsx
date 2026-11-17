// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "@/components/home-page";
import { renderWithQuery } from "../helpers/render-with-query";
import { SEED_STYLES } from "@/lib/seed-styles";

// Stub out motion/react so AnimatePresence removes children immediately (no exit delay in JSDOM).
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  const React = await import("react");
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

// HomePage embeds HomeComposer, which calls useRouter() + useQueryClient().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));

beforeEach(() => {
  // HomeComposer's api-client reads this; set defensively (we never submit here).
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  // Composer prefs now persist to localStorage — isolate each test.
  localStorage.clear();
});

describe("<HomePage>", () => {
  it("offers the four B2B promo modes", () => {
    renderWithQuery(<HomePage />);
    for (const label of ["Product demo", "Brand story", "Social feed", "Freeform"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("shows the plaza promo banner", () => {
    renderWithQuery(<HomePage />);
    expect(screen.getByText(/limited-time offer/i)).toBeInTheDocument();
  });

  it("drops the old generic-creative mode names", () => {
    renderWithQuery(<HomePage />);
    expect(screen.queryByRole("button", { name: "Cinematic short" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commercial ad" })).toBeNull();
  });

  it("seeds the composer to 60s / 16:9 when Brand story is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Brand story" }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "60s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "16:9", pressed: true })).toBeInTheDocument();
  });

  it("seeds the composer to 45s / 1:1 when Freeform is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Freeform" }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "45s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "1:1", pressed: true })).toBeInTheDocument();
  });

  it("expanding a style and clicking a preset fills the composer", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    const style = SEED_STYLES[0]!; // Minimalist Tech
    await user.click(screen.getByRole("button", { name: new RegExp(style.title, "i") }));
    const preset = style.prompts[0]!;
    await user.click(await screen.findByRole("button", { name: preset }));
    expect(screen.getByRole("textbox")).toHaveValue(preset);
  });

  it("restores the saved mode, duration and aspect from localStorage", async () => {
    localStorage.setItem("uc.modeId", JSON.stringify("freeform"));
    localStorage.setItem("uc.duration", JSON.stringify(120));
    localStorage.setItem("uc.aspect", JSON.stringify("1:1"));
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Freeform" })).toHaveAttribute("aria-pressed", "true"),
    );
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "2m", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "1:1", pressed: true })).toBeInTheDocument();
  });

  it("ignores a stale stored duration that is no longer allowed", async () => {
    localStorage.setItem("uc.duration", JSON.stringify(999));
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    // Falls back to the Product demo default (30s) rather than wedging on 999.
    expect(within(duration).getByRole("button", { name: "30s", pressed: true })).toBeInTheDocument();
  });

  it("persists the mode, duration and aspect when a mode is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Social feed" }));
    expect(localStorage.getItem("uc.modeId")).toBe(JSON.stringify("social"));
    expect(localStorage.getItem("uc.duration")).toBe(JSON.stringify(15));
    expect(localStorage.getItem("uc.aspect")).toBe(JSON.stringify("9:16"));
  });

  it("persists a duration change made in the settings dialog", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    await user.click(within(duration).getByRole("button", { name: "3m" }));
    expect(localStorage.getItem("uc.duration")).toBe(JSON.stringify(180));
  });

  it("only one style expands at a time", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: /minimalist tech/i }));
    expect(await screen.findByRole("button", { name: SEED_STYLES[0]!.prompts[0]! })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dynamic promo/i }));
    expect(screen.queryByRole("button", { name: SEED_STYLES[0]!.prompts[0]! })).toBeNull();
    expect(await screen.findByRole("button", { name: SEED_STYLES[2]!.prompts[0]! })).toBeInTheDocument();
  });
});
