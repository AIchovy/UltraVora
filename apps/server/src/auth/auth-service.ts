export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface AuthSession {
  user: AuthUser;
}

/**
 * Narrow seam over better-auth so routes and tests never import the library
 * directly. Tests inject a fake; production wraps the real instance.
 */
export interface AuthService {
  /** Serves /api/auth/* HTTP traffic (web-standard Request/Response). */
  handler(request: Request): Promise<Response>;
  /** Resolves the logged-in session from request headers (cookie), or null. */
  getSession(headers: Headers): Promise<AuthSession | null>;
}
