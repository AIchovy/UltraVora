// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession, uploadFiles, postMessage } from "@/lib/api-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async (_sid: string, files: File[]) => ({
    files: files.map((f, i) => ({ path: `uploads/${i}-${f.name}` })),
  })),
  postMessage: vi.fn(async () => {}),
  getCredits: vi.fn(() => new Promise<never>(() => {})),
}));

// Stateful wrapper so typing + mention insertion actually update the textarea.
function Harness() {
  const [text, setText] = useState("Promo for Acme ");
  return (
    <HomeComposer
      text={text}
      onTextChange={setText}
      duration={30}
      onDurationChange={() => {}}
      aspect="16:9"
      onAspectChange={() => {}}
      placeholder="describe…"
    />
  );
}

function pngFile(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> image assets + @ mentions", () => {
  it("attaching an image shows a thumbnail labeled image1", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    expect(await screen.findByText("@image1")).toBeInTheDocument();
  });

  it("typing @ opens the picker; selecting inserts the label", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    // userEvent.type focuses the textarea and appends at the end of the value.
    await user.type(screen.getByRole("textbox"), "@");
    await user.click(await screen.findByRole("option", { name: /@image1/i }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Promo for Acme @image1 "));
  });

  it("includes the logo in the @ picker when a logo is set", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("upload product logo"), pngFile("brand.png"));
    await user.type(screen.getByRole("textbox"), "@");
    expect(await screen.findByRole("option", { name: /@logo/i })).toBeInTheDocument();
  });

  it("sends assets on generate", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(uploadFiles).toHaveBeenCalled();
    const body = vi.mocked(postMessage).mock.calls[0]![1];
    expect(body.assets).toEqual([
      { label: "image1", path: "uploads/0-a.png", role: "image" },
    ]);
  });

  it("selects safely after the match list narrows past the active index", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), [pngFile("a.png"), pngFile("b.png")]);
    const box = screen.getByRole("textbox");
    await user.type(box, "@image"); // picker shows @image1 + @image2
    await user.keyboard("{ArrowDown}"); // highlight @image2 (index 1)
    await user.type(box, "1"); // narrows matches to just @image1 (index 1 now out of range)
    await user.keyboard("{Enter}"); // must select @image1, not crash on undefined
    await waitFor(() => expect(box).toHaveValue("Promo for Acme @image1 "));
  });

  it("renders an inserted mention as a highlighted chip in the overlay", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    await user.type(screen.getByRole("textbox"), "@");
    await user.click(await screen.findByRole("option", { name: /@image1/i }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Promo for Acme @image1 "));
    const chip = container.querySelector('[data-mention="image1"]');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent("@image1");
  });

  it("does not highlight an @word that is not a known asset", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    await user.type(screen.getByRole("textbox"), "@nope ");
    expect(container.querySelector("[data-mention]")).toBeNull();
  });

  it("stops highlighting a mention once its image is removed", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    await user.type(screen.getByRole("textbox"), "@");
    await user.click(await screen.findByRole("option", { name: /@image1/i }));
    await waitFor(() => expect(container.querySelector('[data-mention="image1"]')).not.toBeNull());
    await user.click(screen.getByRole("button", { name: /remove image1/i }));
    await waitFor(() => expect(container.querySelector('[data-mention="image1"]')).toBeNull());
  });

  it("disables Attach once five images are attached", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    const input = screen.getByLabelText("attach images");
    await user.upload(input, [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png")]);
    await waitFor(() => expect(screen.getByLabelText("attach images")).toBeDisabled());
  });
});
