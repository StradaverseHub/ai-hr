/**
 * The guard on bulk "Mark as expected". PURE: it decides, from what the database says NOW about each requested
 * exception, which of them may be closed as expected, and refuses the rest with a reason.
 *
 * WHAT IS NEVER BULK-CLOSED:
 *  - any group that blocks a run, or that is not a set-up pattern (groups.ts `mayBulkExpect`);
 *  - any exception whose verdict blocks a run, or that has a blocking finding;
 *  - any exception with a finding of another check: closing a verdict closes all of its findings, so one that was also
 *    flagged for something else is decided on its own, where that other finding is in front of the person;
 *  - anything already decided, superseded or not in the requested group.
 * Only exceptions that were on the person's screen are ever closed: the request names them, never a filter.
 *
 * The closing itself goes, one exception at a time, through the anomaly owner's existing resolve (attributed, audited
 * and permission-checked for each one): app/control-tower/exceptions/bulk.ts.
 */
import { variantOf } from './catalogue';
import { isBlocking } from './classify';
import { mayBulkExpect, type GroupIdentity } from './groups';

/** The most exceptions one press may close. Each is its own audited transaction through the owner's resolve. */
export const BULK_EXPECT_MAX = 25;

export type BulkCandidate = Readonly<{
  verdictId: string;
  disposition: string;
  resolved: boolean;
  superseded: boolean;
  findings: readonly Readonly<{ checkId: string; severity: string; facts: Readonly<Record<string, unknown>> | null }>[];
}>;

export type BulkSkipReason = 'not_found' | 'closed' | 'blocking' | 'other_checks' | 'not_in_group';

export type BulkPlan = Readonly<{ resolve: readonly string[]; skipped: readonly Readonly<{ verdictId: string; reason: BulkSkipReason }>[] }>;

export class BulkExpectRefused extends Error {
  constructor(readonly reason: 'not_administrator' | 'invalid' | 'blocking' | 'too_many' | 'nothing') {
    super('Bulk mark as expected refused: ' + reason);
    this.name = 'BulkExpectRefused';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The requested ids, validated: 1..BULK_EXPECT_MAX distinct UUIDs, or a refusal. */
export function requestedIds(values: readonly unknown[]): string[] {
  if (values.some(value => typeof value !== 'string' || !UUID.test(value))) throw new BulkExpectRefused('invalid');
  const ids = [...new Set((values as string[]).map(value => value.toLowerCase()))];
  if (ids.length === 0) throw new BulkExpectRefused('nothing');
  if (ids.length > BULK_EXPECT_MAX) throw new BulkExpectRefused('too_many');
  return ids;
}

/** Why one exception may not be closed with its group, or null when it may. */
export function skipReason(group: GroupIdentity, candidate: BulkCandidate | undefined): BulkSkipReason | null {
  if (!candidate) return 'not_found';
  if (candidate.resolved || candidate.superseded) return 'closed';
  if (candidate.disposition === 'block' || candidate.findings.some(f => isBlocking(f.severity))) return 'blocking';
  if (candidate.findings.length === 0) return 'not_in_group';
  if (candidate.findings.some(f => f.checkId !== group.checkId)) return 'other_checks';
  if (!candidate.findings.some(f => f.severity === group.severity && variantOf(f.checkId, f.facts) === group.variant)) return 'not_in_group';
  return null;
}

export function planBulkExpect(group: GroupIdentity, ids: readonly string[], candidates: readonly BulkCandidate[]): BulkPlan {
  if (!mayBulkExpect(group)) throw new BulkExpectRefused('blocking');
  const byId = new Map(candidates.map(c => [c.verdictId.toLowerCase(), c]));
  const resolve: string[] = [];
  const skipped: { verdictId: string; reason: BulkSkipReason }[] = [];
  for (const id of ids) {
    const reason = skipReason(group, byId.get(id));
    if (reason) skipped.push({ verdictId: id, reason });
    else resolve.push(byId.get(id)!.verdictId);
  }
  return Object.freeze({ resolve: Object.freeze(resolve), skipped: Object.freeze(skipped) });
}

/** Whether one listed exception can go in its group's bulk form (the same rule, on what the page read). */
export const bulkEligible = (group: GroupIdentity, candidate: BulkCandidate) => mayBulkExpect(group) && skipReason(group, candidate) === null;
