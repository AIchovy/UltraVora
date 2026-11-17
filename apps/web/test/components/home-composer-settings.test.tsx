// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";

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

describe("<HomeComposer> video-settings persistence", () => {
  it("writes the audio toggles to localStorage when they change", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await user.click(await screen.findByRole("switch", { name: /voiceover/i }));
    expect(localStorage.getItem("uc.voiceover")).toBe("true");
    await user.click(screen.getByRole("switch", { name: /background music/i }));
    expect(localStorage.getItem("uc.bgm")).toBe("true");
  });

  it("restores the audio toggles from localStorage on mount", async () => {
    localStorage.setItem("uc.voiceover", "true");
    localStorage.setItem("uc.bgm", "true");
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: /voiceover/i })).toBeChecked();
    expect(screen.getByRole("switch", { name: /background music/i })).toBeChecked();
  });

  it("persists the chosen voice", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    // Reveal the picker, then pick a voice.
    await user.click(await screen.findByRole("switch", { name: /voiceover/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    await user.click(within(group).getByRole("radio", { name: "Zephyr" }));
    expect(localStorage.getItem("uc.voice")).toBe(JSON.stringify("Zephyr"));
  });
});
