// @vitest-environment jsdom
// apps/web/test/components/composer.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
});
afterEach(() => vi.restoreAllMocks());

describe("<Composer>", () => {
  it("renders text + duration + aspect + voiceover controls", () => {
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    expect(screen.getByPlaceholderText(/describe your product/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "15s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "16:9" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /voiceover/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /subtitles/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /background music/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("sends bgm:true when background music is enabled (independent of voiceover)", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "promo");
    await user.click(screen.getByRole("switch", { name: /background music/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    const body = JSON.parse((call[1]!.body as string));
    expect(body.constraints).toMatchObject({ withVoiceover: false, bgm: true });
  });

  it("disables the subtitles switch until voiceover is enabled", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    expect(screen.getByRole("switch", { name: /subtitles/i })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: /voiceover/i }));
    expect(screen.getByRole("switch", { name: /subtitles/i })).toBeEnabled();
  });

  it("sends subtitles:true when voiceover and subtitles are both enabled", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "promo");
    await user.click(screen.getByRole("switch", { name: /voiceover/i }));
    await user.click(screen.getByRole("switch", { name: /subtitles/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    const body = JSON.parse((call[1]!.body as string));
    expect(body.constraints).toEqual({ durationSec: 30, aspectRatio: "16:9", withVoiceover: true, subtitles: true, bgm: false });
  });

  it("submitting with constraints sends a UserMessage to /messages", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "make a promo for example.com");
    await user.click(screen.getByRole("button", { name: "30s" }));
    await user.click(screen.getByRole("button", { name: "9:16" }));
    await user.click(screen.getByRole("switch", { name: /voiceover/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    const body = JSON.parse((call[1]!.body as string));
    expect(body.text).toBe("make a promo for example.com");
    expect(body.constraints).toEqual({ durationSec: 30, aspectRatio: "9:16", withVoiceover: true, subtitles: false, bgm: false });
  });

  it("uploads files before sending the message, attaching uploadedFiles paths", async () => {
    let uploadDone = false;
    const spy = mockFetch(async (url, init) => {
      if (url.endsWith("/uploads")) {
        expect(init?.body).toBeInstanceOf(FormData);
        uploadDone = true;
        return new Response(
          JSON.stringify({ files: [{ name: "logo.png", path: "uploads/logo.png" }] }),
          { status: 201 },
        );
      }
      if (url.endsWith("/messages")) {
        expect(uploadDone).toBe(true);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("", { status: 404 });
    });

    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    const file = new File(["x"], "logo.png", { type: "image/png" });
    const input = screen.getByLabelText(/attach files/i) as HTMLInputElement;
    await user.upload(input, file);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "hello");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const messageCall = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    expect(JSON.parse((messageCall[1]!.body as string)).uploadedFiles).toEqual(["uploads/logo.png"]);
  });

  it("in follow-up mode (no requireConstraints) sends just text + a correlation id", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" />);
    await user.type(screen.getByPlaceholderText(/refine/i), "make it punchier");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = JSON.parse((spy.mock.calls[0]![1]!.body as string));
    expect(body.text).toBe("make it punchier");
    // Every message now carries a clientId so the optimistic echo can dedupe
    // against the server's replayed user.message event.
    expect(typeof body.clientId).toBe("string");
    expect(body.clientId.length).toBeGreaterThan(0);
    // Follow-up mode still omits constraints + uploads.
    expect(body.constraints).toBeUndefined();
    expect(body.uploadedFiles).toBeUndefined();
  });

  it("does not submit when text is empty", async () => {
    const spy = mockFetch(async () => new Response("", { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(spy).not.toHaveBeenCalled();
  });
});
