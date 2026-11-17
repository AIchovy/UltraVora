// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoogleButton } from "@/components/auth/google-button";

const socialMock = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: (args: unknown) => socialMock(args) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  socialMock.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href: "http://localhost:3000/login", origin: "http://localhost:3000" },
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("GoogleButton", () => {
  it("starts Google sign-in with the callback resolved against the web origin", async () => {
    // Cross-origin prod: better-auth resolves a RELATIVE callbackURL against
    // its own baseURL (api.<domain>) and the user lands on the API's 404 page.
    // The button must send an absolute web-origin URL.
    socialMock.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }, error: null });
    render(<GoogleButton callbackURL="/dashboard" />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(socialMock).toHaveBeenCalledWith({ provider: "google", callbackURL: "http://localhost:3000/dashboard" });
    expect(window.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  it("resolves the default callback to the web origin root", async () => {
    socialMock.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }, error: null });
    render(<GoogleButton />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(socialMock).toHaveBeenCalledWith({ provider: "google", callbackURL: "http://localhost:3000/" });
  });

  it("shows an inline error when sign-in returns no URL", async () => {
    socialMock.mockResolvedValue({ data: null, error: null });
    render(<GoogleButton />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/google sign-in failed/i);
  });
});
