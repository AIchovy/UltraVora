import { describe, it, expect } from "vitest";
import { groupConversation } from "@/lib/group-conversation";
import type { ChatItem } from "@/state/session-reducer";

describe("groupConversation", () => {
  it("returns no blocks for an empty log", () => {
    expect(groupConversation([])).toEqual([]);
  });

  it("coalesces a phase's start + progress + artifact into one running group", () => {
    const items: ChatItem[] = [
      { kind: "phase-start", phase: "design", at: "t" },
      { kind: "progress", phase: "design", message: "drafted palette" },
      { kind: "progress", phase: "design", message: "picked fonts" },
      { kind: "artifact", artifactKind: "design", version: 1 },
    ];
    const [block] = groupConversation(items);
    expect(block).toMatchObject({
      kind: "phase",
      phase: "design",
      steps: ["drafted palette", "picked fonts"],
      artifacts: [{ artifactKind: "design", version: 1 }],
      status: "running",
    });
  });

  it("marks a superseded running group as done when a new phase starts", () => {
    const items: ChatItem[] = [
      { kind: "phase-start", phase: "research", at: "t" },
      { kind: "progress", phase: "research", message: "read site" },
      { kind: "phase-start", phase: "design", at: "t" },
    ];
    const blocks = groupConversation(items);
    expect(blocks[0]).toMatchObject({ phase: "research", status: "done" });
    expect(blocks[1]).toMatchObject({ phase: "design", status: "running" });
  });

  it("records a gate as awaiting on its phase group", () => {
    const items: ChatItem[] = [
      { kind: "progress", phase: "design", message: "drafted palette" },
      { kind: "gate", phase: "design" },
    ];
    const [block] = groupConversation(items);
    expect(block).toMatchObject({ kind: "phase", status: "awaiting" });
  });

  it("records a phase error with its message", () => {
    const blocks = groupConversation([{ kind: "phase-error", phase: "render", error: "ffmpeg died" }]);
    expect(blocks[0]).toMatchObject({ kind: "phase", status: "error", error: "ffmpeg died" });
  });

  it("emits a standalone artifact chip when no phase group is open", () => {
    const blocks = groupConversation([{ kind: "artifact", artifactKind: "brief", version: 1 }]);
    expect(blocks[0]).toEqual({ kind: "artifact", artifactKind: "brief", version: 1 });
  });

  it("renders user messages as their own blocks and closes the prior group", () => {
    const items: ChatItem[] = [
      { kind: "phase-start", phase: "research", at: "t" },
      { kind: "user-message", text: "make it punchier" },
    ];
    const blocks = groupConversation(items);
    expect(blocks[0]).toMatchObject({ kind: "phase", status: "done" });
    expect(blocks[1]).toEqual({ kind: "user", text: "make it punchier" });
  });

  it("emits a render-done block", () => {
    const blocks = groupConversation([{ kind: "render-done", mp4Path: "output/x.mp4" }]);
    expect(blocks[0]).toEqual({ kind: "render-done", mp4Path: "output/x.mp4" });
  });
});

describe("groupConversation: notice", () => {
  it("passes notice items through as standalone blocks and closes an open phase", () => {
    const items: ChatItem[] = [
      { kind: "phase-start", phase: "research", at: "2026-06-01T00:00:00.000Z" },
      { kind: "notice", message: "I can't act on that message yet." },
    ];
    const blocks = groupConversation(items);
    expect(blocks).toEqual([
      { kind: "phase", phase: "research", steps: [], artifacts: [], status: "done" },
      { kind: "notice", message: "I can't act on that message yet." },
    ]);
  });
});
