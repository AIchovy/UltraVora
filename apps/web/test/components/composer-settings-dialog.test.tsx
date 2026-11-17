// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerSettingsDialog } from "@/components/composer-settings-dialog";
import { renderWithQuery } from "../helpers/render-with-query";

function setup(overrides: Partial<React.ComponentProps<typeof ComposerSettingsDialog>> = {}) {
  const props = {
    duration: 30 as const,
    onDurationChange: vi.fn(),
    aspect: "16:9" as const,
    onAspectChange: vi.fn(),
    voiceover: false,
    onVoiceoverChange: vi.fn(),
    subtitles: false,
    onSubtitlesChange: vi.fn(),
    bgm: false,
    onBgmChange: vi.fn(),
    voice: "Kore" as const,
    onVoiceChange: vi.fn(),
    isPublic: false,
    onIsPublicChange: vi.fn(),
    freePublic: false,
    ...overrides,
  };
  renderWithQuery(<ComposerSettingsDialog {...props} />);
  return props;
}

describe("<ComposerSettingsDialog>", () => {
  it("opens the modal and shows all six durations", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("group", { name: "duration" });
    for (const label of ["15s", "30s", "45s", "60s", "2m", "3m"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("picking 2m reports 120 seconds", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await user.click(within(await screen.findByRole("group", { name: "duration" })).getByRole("button", { name: "2m" }));
    expect(props.onDurationChange).toHaveBeenCalledWith(120);
  });

  it("disables subtitles until voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: false });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: "subtitles" })).toBeDisabled();
  });

  it("subtitles is enabled when voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: true });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: "subtitles" })).not.toBeDisabled();
  });

  it("hides the voice picker until voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: false });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(screen.queryByRole("radiogroup", { name: "voice" })).toBeNull();
  });

  it("shows the voice picker with the selected voice checked when voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: true, voice: "Puck" });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    expect(within(group).getByRole("radio", { name: "Puck" })).toBeChecked();
  });

  it("picking a voice reports it", async () => {
    const user = userEvent.setup();
    const props = setup({ voiceover: true });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    await user.click(within(group).getByRole("radio", { name: "Zephyr" }));
    expect(props.onVoiceChange).toHaveBeenCalledWith("Zephyr");
  });

  it("auditioning a voice plays its sample clip", async () => {
    const playSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const user = userEvent.setup();
    setup({ voiceover: true });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await user.click(await screen.findByRole("button", { name: "preview Puck" }));
    expect(playSpy).toHaveBeenCalled();
    const audio = document.querySelector("audio");
    expect(audio?.src).toContain("/Puck.wav");
  });
});
