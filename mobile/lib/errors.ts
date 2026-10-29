/**
 * The two failures the app must never confuse (ADR-0088 §2, and the benchmark's top login complaint):
 *   • SignInRequiredError — the server or WorkOS rejected the credentials: sign in again.
 *   • UnavailableError — the network, WorkOS or our server is down: KEEP the session and offer a retry.
 * An outage that looks like a logout is exactly what makes employees hate HR apps.
 */
export class SignInRequiredError extends Error {
  constructor(message = 'Please sign in again.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

export class UnavailableError extends Error {
  constructor(message = 'The service is unavailable right now.',public readonly retryAfter?:number,public readonly supportId?:string) {
    super(message);
    this.name = 'UnavailableError';
  }
}

/** The offline-clocking connectivity test (owner decision 1, 2026-10-28): the request produced NO HTTP response at all
 * (the fetch rejected, or our own timeout fired before any status arrived). A 5xx, 429, malformed body or caller abort
 * is a plain UnavailableError. Still an UnavailableError, so every existing online caller behaves exactly as before.
 * A hung server that never answers within the timeout is indistinguishable from no network here. */
export class NetworkUnavailableError extends UnavailableError {
  constructor() { super(); this.name = 'NetworkUnavailableError'; }
}
export const isNoConnectivity = (error: unknown): boolean => error instanceof NetworkUnavailableError;

/** An obsolete operation, not an authentication refusal for the current account. */
export class SessionChangedError extends Error {
  constructor() {
    super('The session changed while this operation was running.');
    this.name = 'SessionChangedError';
  }
}

/** A definitive validation/permission refusal, before the handler commits a command. */
export class RequestRejectedError extends Error {
  constructor(public readonly status: number) { super(`HTTP ${status}`); this.name='RequestRejectedError'; }
}
export type LocationCaptureIssue='permission_denied'|'permission_blocked'|'approximate_permission'|'services_disabled'|'stale_fix'|'future_fix'|'invalid_fix'|'mock_location'|'unavailable';
export class LocationCaptureError extends Error{
  constructor(readonly issue:LocationCaptureIssue,message:string){super(message);this.name='LocationCaptureError';}
}
