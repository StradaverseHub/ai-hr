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
  constructor(message = 'The service is unavailable right now.') {
    super(message);
    this.name = 'UnavailableError';
  }
}

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
