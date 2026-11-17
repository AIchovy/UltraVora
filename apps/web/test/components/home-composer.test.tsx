// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer, isValidProductUrl } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import { takePendingMessage } from "@/lib/pending-message";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, refresh: () => {} }),
  usePathname: () => "/",
}));

function fixture() {
  return (
    <HomeComposer
      text="make a moody teaser"
      onTextChange={() => {}}
      duration={15}
      onDurationChange={() => {}}
      aspect="9:16"
      onAspectChange={() => {}}
      placeholder="Describe a scene…"
    />
  );
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  localStorage.clear();
  sessionStorage.clear();
  pushMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("<HomeComposer>", () => {
  it("creates a session, posts the first message with constraints, then navigates", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ sessionId: "new-sid" }), { status: 201 });
      }
      if (url.endsWith("/messages")) {
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(fixture());

    await user.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/s/new-sid"));
    const created = spy.mock.calls.find(([u]) => String(u).endsWith("/api/sessions"));
    expect(created?.[1]?.method).toBe("POST");
    const msg = spy.mock.calls.find(([u]) => String(u).endsWith("/messages"))!;
    const body = JSON.parse(msg[1]!.body as string);
    expect(body.text).toBe("make a moody teaser");
    expect(body.constraints).toMatchObject({ durationSec: 15, aspectRatio: "9:16" });
    expect(body.constraints.voice).toBe("Kore"); // default voice rides along
  });

  it("stashes the message for the session page", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify({ sessionId: "new-sid" }), { status: 201 });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(fixture());
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(takePendingMessage("new-sid")?.text).toBe("make a moody teaser");
  });

  const creditsBody = (balance: number) =>
    JSON.stringify({ balance, breakdown: { subscription: 0, bonus: 0, purchased: balance }, subscription: null });

  it("opens the upgrade dialog and creates nothing when out of credits (<= 0)", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(creditsBody(0), { status: 200 });
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify({ sessionId: "x" }), { status: 201 });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    const { qc } = renderWithQuery(fixture());
    qc.setQueryData(["credits"], JSON.parse(creditsBody(0)));

    await user.click(screen.getByRole("button", { name: /generate/i }));

    expect(await screen.findByText(/out of credits/i)).toBeInTheDocument();
    expect(spy.mock.calls.some(([u]) => String(u).endsWith("/api/sessions"))).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("creates the session when the balance is positive", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(creditsBody(5), { status: 200 });
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify({ sessionId: "new-sid" }), { status: 201 });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    const { qc } = renderWithQuery(fixture());
    qc.setQueryData(["credits"], JSON.parse(creditsBody(5)));

    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/s/new-sid"));
  });

  describe("isValidProductUrl", () => {
    it("accepts real http(s) URLs and bare domains", () => {
      for (const ok of ["yourproduct.com", "https://acme.com", "http://foo.io/path?q=1", "sub.domain.co.uk", " https://x.com "]) {
        expect(isValidProductUrl(ok)).toBe(true);
      }
    });
    it("rejects junk, schemeless words, and non-http schemes", () => {
      for (const bad of ["", "   ", "asdf", "not a url", "ftp://foo.com", "javascript:alert(1)", "http://nodot"]) {
        expect(isValidProductUrl(bad)).toBe(false);
      }
    });
  });

  it("blocks generation and shows an error when the URL is invalid", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ sessionId: "x" }), { status: 201 }));
    const user = userEvent.setup();
    renderWithQuery(fixture()); // fixture has prompt text, so only the bad URL should block
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText(/product url/i), "asdf");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid url/i);
    expect(spy.mock.calls.some(([u]) => String(u).endsWith("/api/sessions"))).toBe(false);
  });

  it("accepts a bare domain and sends it as the product page", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify({ sessionId: "new-sid" }), { status: 201 });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(fixture());
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText(/product url/i), "yourproduct.com");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/s/new-sid"));
    const msg = spy.mock.calls.find(([u]) => String(u).endsWith("/messages"))!;
    expect(JSON.parse(msg[1]!.body as string).text).toContain("Product page: yourproduct.com");
  });

  it("does not create a session when the prompt is empty", async () => {
    const spy = mockFetch(async () => new Response("", { status: 201 }));
    const user = userEvent.setup();
    renderWithQuery(
      <HomeComposer
        text="   "
        onTextChange={() => {}}
        duration={15}
        onDurationChange={() => {}}
        aspect="16:9"
        onAspectChange={() => {}}
        placeholder="Describe a scene…"
      />,
    );
    // Button is disabled for empty prompt; force-invoke to prove the guard too.
    const btn = screen.getByRole("button", { name: /generate/i });
    expect(btn).toBeDisabled();
    await user.click(btn);
    // The composer polls /api/credits on mount; only session creation matters here.
    const sessionCalls = spy.mock.calls.filter(([u]) => String(u).endsWith("/api/sessions"));
    expect(sessionCalls).toHaveLength(0);
  });
});
