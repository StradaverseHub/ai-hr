/**
 * Global Delegation (Phase 1) — pure presentation helpers for the /delegations screen. Kept in a
 * NON-'use client' module so the server component (app/delegations/page.tsx) can import and CALL them at
 * render time without tripping the RSC boundary guard (test/rsc-boundary-guard.test.ts).
 */

export type DelegationStatus = 'active' | 'scheduled' | 'ended';

/**
 * Derive the display status of a delegation window as of `asOf` (YYYY-MM-DD):
 *   • ended     — superseded, or the end date has passed (validTo <= asOf)
 *   • scheduled — starts in the future (validFrom > asOf)
 *   • active    — currently in force
 * `ended` is precomputed by the read (supersededAt OR closed window); the dates decide active vs scheduled.
 */
export function delegationStatus(
  row: { validFrom: string; validTo: string | null; ended: boolean },
  asOf: string,
): DelegationStatus {
  if (row.ended) return 'ended';
  if (row.validFrom > asOf) return 'scheduled';
  return 'active';
}

/** A delegation is REVOCABLE only while it is still active or scheduled (never once ended). */
export function isRevocable(row: { validFrom: string; validTo: string | null; ended: boolean }, asOf: string): boolean {
  return delegationStatus(row, asOf) !== 'ended';
}
