// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginCard } from "@/components/login-card";

// The card composes the auth sub-components; mock the client so they're inert.
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: vi.fn(), email: vi.fn() },
    signUp: { email: vi.fn() },
    emailOtp: { verifyEmail: vi.fn(), sendVerificationOtp: vi.fn() },
  },
}));

describe("LoginCard", () => {
  it("defaults to sign-in mode with Google + email-password fields", () => {
    render(<LoginCard />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  it("toggles to sign-up mode and shows the create-account form", async () => {
    render(<LoginCard />);
    await userEvent.click(screen.getByRole("button", { name: /need an account\? create one/i }));
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
    // Google stays available in sign-up mode.
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("shows the terms + privacy agreement line in sign-in mode", () => {
    render(<LoginCard />);
    expect(screen.getByText(/by continuing, you agree to/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /terms of service/i })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
  });

  it("keeps the agreement line in sign-up mode", async () => {
    render(<LoginCard />);
    await userEvent.click(screen.getByRole("button", { name: /need an account\? create one/i }));
    expect(screen.getByRole("link", { name: /terms of service/i })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
  });
});
