// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Page, { metadata } from "@/app/page";
import { getServerSession } from "@/lib/server-session";

vi.mock("@/lib/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));
vi.mock("@/components/home-page", () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock("@/components/marketing/landing-page", () => ({
  LandingPage: () => <div data-testid="landing-page" />,
}));

const getSessionMock = vi.mocked(getServerSession);

describe("root page", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it("renders the marketing landing page when logged out", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await Page());
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("renders the app shell with the home page when logged in", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "u1", email: "u@example.com", name: "U" } });
    render(await Page());
    expect(screen.getByTestId("home-page")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("landing-page")).toBeNull();
  });

  it("exports marketing metadata for the route", () => {
    expect(metadata.title).toBe("UltraVora — Promo videos for your product");
    expect(metadata.description).toMatch(/promo video/i);
  });
});
