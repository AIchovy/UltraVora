// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "@/components/auth/sign-in-form";

const signInEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: (a: unknown) => signInEmail(a) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  signInEmail.mockReset();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, href: "http://localhost:3000/login" } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("SignInForm", () => {
  it("signs in and redirects to the callback on success", async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<SignInForm callbackURL="/dashboard" />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "a@b.com");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "Abcdef12345!");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(signInEmail).toHaveBeenCalledWith({ email: "a@b.com", password: "Abcdef12345!" });
    expect(window.location.href).toBe("/dashboard");
  });

  it("shows inline field errors (not browser popups) when submitted empty", async () => {
    render(<SignInForm />);
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(screen.getByText(/email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/you@example.com/i)).toHaveAttribute("aria-invalid", "true");
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("flags a malformed email inline without calling the API", async () => {
    render(<SignInForm />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "notanemail");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "Abcdef12345!");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("shows a single generic error on failure", async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: "whatever" } });
    render(<SignInForm />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "a@b.com");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/email or password is incorrect/i);
  });
});
