// @vitest-environment jsdom
// apps/web/test/components/chat-stream.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatStream } from "@/components/chat-stream";
import type { ChatItem } from "@/state/session-reducer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("<ChatStream>", () => {
  it("renders nothing useful when empty (has an empty-state hint)", () => {
    render(<ChatStream items={[]} />);
    expect(screen.getByText(/waiting|nothing yet/i)).toBeInTheDocument();
  });

  it("renders a phase-start row with the phase name", () => {
    const items: ChatItem[] = [{ kind: "phase-start", phase: "research", at: "t" }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/research/i)).toBeInTheDocument();
  });

  it("renders progress text and a gate row", () => {
    const items: ChatItem[] = [
      { kind: "progress", phase: "design", message: "drafted palette" },
      { kind: "gate", phase: "design" },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/drafted palette/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
  });

  it("renders an artifact row with kind + version", () => {
    const items: ChatItem[] = [{ kind: "artifact", artifactKind: "brief", version: 1 }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/brief v1/i)).toBeInTheDocument();
  });

  it("renders a phase error row with the message", () => {
    const items: ChatItem[] = [{ kind: "phase-error", phase: "render", error: "ffmpeg died" }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/ffmpeg died/i)).toBeInTheDocument();
  });

  it("shows skeleton placeholders while loading (not the empty-state hint)", () => {
    const { container } = render(<ChatStream items={[]} loading />);
    expect(screen.getByRole("status", { name: /loading conversation/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/waiting|nothing yet/i)).toBeNull();
  });

  it("shows the empty-state hint when not loading and empty", () => {
    render(<ChatStream items={[]} loading={false} />);
    expect(screen.getByText(/waiting|nothing yet/i)).toBeInTheDocument();
  });
});

describe("<ChatStream> — friendly tool copy", () => {
  it("renders a friendly label for a known tool instead of the raw title-case name", () => {
    const items: ChatItem[] = [
      {
        kind: "tool-start",
        phase: "compose",
        toolCallId: "t1",
        toolName: "read_skill_file",
        toolLabel: "Read Skill File",
        argsSummary: "hyperframes",
      },
      {
        kind: "tool-end",
        phase: "compose",
        toolCallId: "t1",
        toolName: "read_skill_file",
        toolLabel: "Read Skill File",
        isError: false,
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText("Reading guidelines")).toBeInTheDocument();
    expect(screen.queryByText("Read Skill File")).toBeNull();
  });

  it("keeps the args-derived subject visible after a tool finishes successfully", () => {
    const items: ChatItem[] = [
      {
        kind: "tool-start",
        phase: "compose",
        toolCallId: "t1",
        toolName: "read_skill_file",
        toolLabel: "Read Skill File",
        argsSummary: "hyperframes",
      },
      {
        kind: "tool-end",
        phase: "compose",
        toolCallId: "t1",
        toolName: "read_skill_file",
        toolLabel: "Read Skill File",
        isError: false,
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText("hyperframes")).toBeInTheDocument();
  });

  it("maps write_composition_file to a friendly build label", () => {
    const items: ChatItem[] = [
      {
        kind: "tool-start",
        phase: "compose",
        toolCallId: "t2",
        toolName: "write_composition_file",
        toolLabel: "Write Composition File",
        argsSummary: "index.html",
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText("Building the video")).toBeInTheDocument();
  });

  it("falls back to the server label for an unknown tool", () => {
    const items: ChatItem[] = [
      {
        kind: "tool-start",
        phase: "compose",
        toolCallId: "t3",
        toolName: "some_future_tool",
        toolLabel: "Some Future Tool",
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText("Some Future Tool")).toBeInTheDocument();
  });

  it("shows a short reason when a tool errors", () => {
    const items: ChatItem[] = [
      {
        kind: "tool-start",
        phase: "research",
        toolCallId: "t4",
        toolName: "web_fetch",
        toolLabel: "Web Fetch",
        argsSummary: "acme.example",
      },
      {
        kind: "tool-end",
        phase: "research",
        toolCallId: "t4",
        toolName: "web_fetch",
        toolLabel: "Web Fetch",
        resultSummary: "404 Not Found",
        isError: true,
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText("Browsing the web")).toBeInTheDocument();
    expect(screen.getByText("404 Not Found")).toBeInTheDocument();
  });

  it("shows the user's message text in a bubble", () => {
    const items: ChatItem[] = [{ kind: "user-message", text: "make me a promo video", at: 1 }];
    render(<ChatStream items={items} />);
    expect(screen.getByText("make me a promo video")).toBeInTheDocument();
  });

  it("shows a timestamp for the user message when one is present", () => {
    const at = new Date("2026-06-22T14:32:00").getTime();
    const items: ChatItem[] = [{ kind: "user-message", text: "hi", at }];
    render(<ChatStream items={items} />);
    const expected = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("copies the bubble text to the clipboard when the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const items: ChatItem[] = [{ kind: "user-message", text: "copy me please", at: 1 }];
    render(<ChatStream items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));
    expect(writeText).toHaveBeenCalledWith("copy me please");
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("shows only the file name for a rendered video, not the absolute path", () => {
    const items: ChatItem[] = [
      {
        kind: "render-done",
        mp4Path:
          "/path/to/UltraVora/apps/server/workspaces/abc/output/5aa14caa-fb19.mp4",
      },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/video rendered/i)).toBeInTheDocument();
    expect(screen.getByText("5aa14caa-fb19.mp4")).toBeInTheDocument();
    expect(screen.queryByText(/\/output\//)).toBeNull();
  });
});
