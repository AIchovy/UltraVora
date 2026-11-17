// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar, taskIcon } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null, isPending: false }),
}));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, refresh: () => {} }),
  usePathname: () => "/",
}));

function renderSidebar() {
  return renderWithQuery(
    <SidebarProvider><AppSidebar /></SidebarProvider>,
  );
}
const summary = (id: string, title: string) => ({ id, title, status: "idle", currentPhase: null, createdAt: "t", updatedAt: "t" });

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  pushMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("<AppSidebar>", () => {
  it("shows an empty hint when the API returns no sessions", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("lists sessions from the API", async () => {
    mockFetch(async (url) => {
      if (String(url).endsWith("/api/sessions")) return new Response(JSON.stringify([summary("a", "Alpha"), summary("b", "Beta")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    renderSidebar();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("marks a still-generating (running) session with an animated indicator", async () => {
    mockFetch(async (url) => {
      if (String(url).endsWith("/api/sessions"))
        return new Response(
          JSON.stringify([{ ...summary("a", "Alpha"), status: "running" }, summary("b", "Beta")]),
          { status: 200 },
        );
      return new Response("", { status: 404 });
    });
    renderSidebar();
    const running = (await screen.findByText("Alpha")).closest("a")!;
    const idle = screen.getByText("Beta").closest("a")!;
    // Running row flags itself busy and swaps its task icon for a spinner.
    expect(running).toHaveAttribute("aria-busy", "true");
    expect(within(running).getByTestId("session-spinner")).toBeInTheDocument();
    // An idle row keeps its static icon and is not busy.
    expect(idle).toHaveAttribute("aria-busy", "false");
    expect(within(idle).queryByTestId("session-spinner")).toBeNull();
  });

  it("'New task' routes to Home", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: /new task/i }));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("picks a stable, varied icon per session id", () => {
    expect(taskIcon("abc")).toBe(taskIcon("abc"));
    const distinct = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(taskIcon));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("brand logo links to the signed-in home", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    const brand = await screen.findByRole("link", { name: /ultravora home/i });
    expect(brand).toHaveAttribute("href", "/");
    expect(brand.querySelector('[data-slot="logo-mark"]')).not.toBeNull();
  });

  it("shows a Product Plaza link to /plaza", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    const link = await screen.findByRole("link", { name: /product plaza/i });
    expect(link).toHaveAttribute("href", "/plaza");
  });

  it("separates the zones with two hairline dividers", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    await screen.findByText(/no tasks yet/i);
    // One divider between New task and Plaza, one between Plaza and Tasks.
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("shows a task-count badge next to the Tasks label", async () => {
    mockFetch(async (url) => {
      if (String(url).endsWith("/api/sessions"))
        return new Response(JSON.stringify([summary("a", "Alpha"), summary("b", "Beta")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    renderSidebar();
    await screen.findByText("Alpha");
    expect(screen.getByTestId("task-count")).toHaveTextContent("2");
  });

  it("hides the task-count badge when there are no tasks", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    await screen.findByText(/no tasks yet/i);
    expect(screen.queryByTestId("task-count")).toBeNull();
  });

  it("deleting a task DELETEs and refetches the list", async () => {
    let deleted = false;
    const spy = mockFetch(async (url, init) => {
      if (String(url).endsWith("/api/sessions/a") && (init as RequestInit | undefined)?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      if (String(url).endsWith("/api/sessions")) return new Response(JSON.stringify(deleted ? [] : [summary("a", "Alpha")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderSidebar();
    await user.click(await screen.findByRole("button", { name: /delete alpha/i }));
    await waitFor(() => expect(spy.mock.calls.some(([u, i]) => String(u).endsWith("/api/sessions/a") && (i as RequestInit)?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
  });
});
