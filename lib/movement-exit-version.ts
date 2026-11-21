/** A historical exit boundary is inclusive only for versions closed by that exit.
 * It does not change the half-open date semantics used by active employment readers. */
export type ExitVersion = { id: string; validFrom: string; validTo: string | null };
export type ExitVersionEvent = { aggregateId: string; sequence: number; eventType: string };

export function movementExitVersion<T extends ExitVersion>(
  versions: readonly T[],
  effectiveDate: string,
  exitSequence: number,
  events: readonly ExitVersionEvent[],
): T | null {
  const starts = new Map<string, number>();
  for (const event of events) {
    if (['employment.assignment.changed', 'assignment.transferred', 'reporting-line.set'].includes(event.eventType)) {
      starts.set(event.aggregateId, event.sequence);
    }
  }
  const candidates = versions.filter(version => version.validFrom <= effectiveDate &&
    (version.validTo === null || version.validTo >= effectiveDate) &&
    (starts.get(version.id) ?? -Infinity) <= exitSequence);
  if (!candidates.length) return null;
  const latestFrom = candidates.reduce((latest, version) => version.validFrom > latest ? version.validFrom : latest, '');
  const latest = candidates.filter(version => version.validFrom === latestFrom);
  if (latest.length === 1) return latest[0];
  // A same-day transfer/manager change has a real ledger order. Missing lineage
  // cannot be resolved by random UUID, query row order or today's profile.
  if (latest.filter(version => !starts.has(version.id)).length > 1) return null;
  return latest.reduce((last, version) => (starts.get(version.id) ?? -Infinity) > (starts.get(last.id) ?? -Infinity) ? version : last);
}
