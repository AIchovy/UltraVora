// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignUpForm } from "@/components/auth/sign-up-form";

const signUpEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signUp: { email: (args: unknown) => signUpEmail(args) } },
}));

beforeEach(() => signUpEmail.mockReset());

async function fillAll(user: ReturnType<typeof userEvent.setup>, { nickname = "alice_99", email = "alice@b.com", password = "Abcdef12345!" } = {}) {
  if (nickname) await user.type(screen.getByPlaceholderText(/nickname/i), nickname);
  if (email) await user.type(screen.getByPlaceholderText(/you@example.com/i), email);
  if (password) await user.type(screen.getByPlaceholderText(/create a password/i), password);
}

describe("SignUpForm", () => {
  it("keeps submit disabled until nickname, email, and password are filled", async () => {
    const user = userEvent.setup();
    render(<SignUpForm onSent={vi.fn()} />);
    const submit = screen.getByRole("button", { name: /create account/i });
    expect(submit).toBeDisabled();
    await fillAll(user);
    expect(submit).toBeEnabled();
  });

  it("flags an invalid nickname inline without calling the API", async () => {
    const user = userEvent.setup();
    render(<SignUpForm onSent={vi.fn()} />);
    await fillAll(user, { nickname: "ab" }); // too short
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(screen.getByText(/letters, numbers, or underscores/i)).toBeInTheDocument();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("flags an invalid email inline without calling the API", async () => {
    const user = userEvent.setup();
    render(<SignUpForm onSent={vi.fn()} />);
    await fillAll(user, { email: "notanemail" });
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("validates the password only on submit, showing the policy and not calling the API", async () => {
    const user = userEvent.setup();
    render(<SignUpForm onSent={vi.fn()} />);
    await fillAll(user, { password: "short1!" });
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("signs up with the chosen nickname as the name and calls onSent", async () => {
    signUpEmail.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    const onSent = vi.fn();
    render(<SignUpForm onSent={onSent} />);
    await fillAll(user, { nickname: "alice_99", email: "alice@b.com" });
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(signUpEmail).toHaveBeenCalledWith({ email: "alice@b.com", password: "Abcdef12345!", name: "alice_99" });
    expect(onSent).toHaveBeenCalledWith("alice@b.com");
  });

  it("shows an already-registered message and does not advance", async () => {
    signUpEmail.mockResolvedValue({ data: null, error: { code: "USER_ALREADY_EXISTS", message: "exists" } });
    const user = userEvent.setup();
    const onSent = vi.fn();
    render(<SignUpForm onSent={onSent} />);
    await fillAll(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already registered/i);
    expect(onSent).not.toHaveBeenCalled();
  });
});
