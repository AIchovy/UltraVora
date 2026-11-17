// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OtpVerifyForm } from "@/components/auth/otp-verify-form";

const verifyEmail = vi.fn();
const sendOtp = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { emailOtp: { verifyEmail: (a: unknown) => verifyEmail(a), sendVerificationOtp: (a: unknown) => sendOtp(a) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  verifyEmail.mockReset();
  sendOtp.mockReset();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, href: "http://localhost:3000/login" } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

// input-otp renders a single controlled <input> behind the visual slots.
const otpInput = (container: HTMLElement) => container.querySelector("input") as HTMLInputElement;

describe("OtpVerifyForm", () => {
  it("verifies the code and redirects to the callback on success", async () => {
    verifyEmail.mockResolvedValue({ data: {}, error: null });
    const { container } = render(<OtpVerifyForm email="a@b.com" callbackURL="/dashboard" />);
    fireEvent.change(otpInput(container), { target: { value: "654321" } });
    await userEvent.click(screen.getByRole("button", { name: /verify & continue/i }));
    expect(verifyEmail).toHaveBeenCalledWith({ email: "a@b.com", otp: "654321" });
    expect(window.location.href).toBe("/dashboard");
  });

  it("shows an error for an invalid code", async () => {
    verifyEmail.mockResolvedValue({ data: null, error: { message: "bad" } });
    const { container } = render(<OtpVerifyForm email="a@b.com" />);
    fireEvent.change(otpInput(container), { target: { value: "000000" } });
    await userEvent.click(screen.getByRole("button", { name: /verify & continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or expired/i);
  });

  it("gates resend behind a 60s countdown that ticks down", () => {
    vi.useFakeTimers();
    try {
      render(<OtpVerifyForm email="a@b.com" />);
      const btn = screen.getByRole("button", { name: /resend/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent(/resend code in 60s/i);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByRole("button", { name: /resend/i })).toHaveTextContent(/59s/);
      act(() => { vi.advanceTimersByTime(59_000); });
      const ready = screen.getByRole("button", { name: /resend code/i });
      expect(ready).toBeEnabled();
      expect(ready).toHaveTextContent(/^resend code$/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resends a code via the email-verification type once the cooldown elapses", async () => {
    vi.useFakeTimers();
    sendOtp.mockResolvedValue({ data: {}, error: null });
    try {
      render(<OtpVerifyForm email="a@b.com" />);
      // Disabled during the cooldown — a click does nothing.
      fireEvent.click(screen.getByRole("button", { name: /resend/i }));
      expect(sendOtp).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(60_000); });
      fireEvent.click(screen.getByRole("button", { name: /resend code/i }));
      expect(sendOtp).toHaveBeenCalledWith({ email: "a@b.com", type: "email-verification" });
      await act(async () => {}); // flush the resend promise + cooldown reset
    } finally {
      vi.useRealTimers();
    }
  });
});
