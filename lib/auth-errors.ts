/**
 * Auth error types (ADR-0072). Kept in a DB-free module so both the server-only session resolver
 * (lib/session.ts) and the app layout / route guards can import them without pulling in the DB client.
 */

/**
 * Thrown by getSession() when there is no valid WorkOS session, OR when a still-valid WorkOS cookie's
 * subject resolves to no app_user (an offboarded/deleted user). The app layout catches this and
 * redirects to /login — never a 500, never a stale resolve.
 */
export class AuthRequiredError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Thrown when an invitation token is unknown, already consumed, revoked, or expired. Surfaced on the
 * /invite/[token] page as a generic "this link is no longer valid" message (never leaks which case).
 */
export class InvalidInvitationError extends Error {
  constructor(message = 'This invitation link is no longer valid') {
    super(message);
    this.name = 'InvalidInvitationError';
  }
}
