/** Shared class identity for canonical Auth services and explicit-transaction readers. */
export class InternalAuthError extends Error {
  constructor(public code: 'invalidLogin' | 'invalidChallenge' | 'invalidCode' | 'passwordPolicy' | 'rateLimited' | 'unavailable' | 'conflict') { super(code); }
}
