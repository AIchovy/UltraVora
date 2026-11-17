// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarUser } from "@/components/sidebar-user";

const signOutMock = vi.fn();
let sessionData: { user: { id: string; email: string; name: string; image: string | null } } | null = null;

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: () => signOutMock() },
  useSession: () => ({ data: sessionData, isPending: false }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

beforeEach(() => {
  signOutMock.mockReset().mockResolvedValue({ error: null });
  pushMock.mockClear();
  toastErrorMock.mockClear();
  sessionData = { user: { id: "u1", email: "a@x.com", name: "Alice", image: null } };
});

function renderUser() {
  return render(
    <SidebarProvider>
      <SidebarUser />
    </SidebarProvider>,
  );
}

describe("SidebarUser", () => {
  it("renders nothing while logged out", () => {
    sessionData = null;
    const { container } = renderUser();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows name and email", () => {
    renderUser();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("a@x.com")).toBeInTheDocument();
  });

  it("draws the shared hairline divider above the account row", () => {
    renderUser();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("signs out and navigates to /login", async () => {
    renderUser();
    await userEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await userEvent.click(await screen.findByText(/sign out/i));
    expect(signOutMock).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/login");
    // Navigation must happen only after sign-out succeeds — otherwise the
    // /login server guard still sees a live cookie and bounces back.
    expect(signOutMock.mock.invocationCallOrder[0]!).toBeLessThan(pushMock.mock.invocationCallOrder[0]!);
  });

  it("does not navigate and shows an error when sign-out returns an error", async () => {
    signOutMock.mockResolvedValue({ error: { status: 500 } });
    renderUser();
    await userEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await userEvent.click(await screen.findByText(/sign out/i));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not navigate and shows an error when sign-out rejects", async () => {
    signOutMock.mockRejectedValue(new Error("network down"));
    renderUser();
    await userEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await userEvent.click(await screen.findByText(/sign out/i));
    expect(toastErrorMock).toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
