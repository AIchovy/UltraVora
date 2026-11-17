import type { AuthService, AuthUser } from "../../src/auth/auth-service.js";

export const TEST_USER: AuthUser = {
  id: "u-test",
  email: "test@example.com",
  name: "Test User",
  image: null,
};

/** AuthService fake: pass a user (default TEST_USER) or null for logged-out. */
export function fakeAuthService(user: AuthUser | null = TEST_USER): AuthService {
  return {
    handler: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    getSession: async () => (user ? { user } : null),
  };
}
