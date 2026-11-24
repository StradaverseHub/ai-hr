/** Board 8f959c7a — the period one Direct Superior applied, as HR reads it: From and an INCLUSIVE To.
 *
 * The single owner of a dated superior is the administrative reporting_line timeline, whose valid_to is
 * EXCLUSIVE (the next superior's start day). People read "01-Jul-2026 → 01-Jul-2026" as two periods that
 * overlap, so every screen shows valid_to − 1 day; the stored value stays exclusive. Pure: callers pass
 * the non-superseded administrative lines they already read. */
import {addCalendarDays} from './hr-date-calendar';

export type DirectSuperiorLine = { validFrom: string; validTo: string | null };
/** `to` is the last day the superior applied, or null while it is still the current one. */
export type DirectSuperiorPeriod = { from: string; to: string | null };

/** The last day an exclusive valid_to covers; null stays open (current). */
export function inclusiveSuperiorEnd(validTo: string | null): string | null {
  return validTo ? addCalendarDays(validTo, -1) : null;
}

/** The period that started with the Direct Superior change effective on `effectiveDate`.
 * A change to a named superior owns the line starting that day. A change to "No Direct Superior" owns
 * no line, so its period runs until the next line starts (or stays open). */
export function directSuperiorPeriodOf(lines: readonly DirectSuperiorLine[], effectiveDate: string): DirectSuperiorPeriod {
  const live = lines.filter(line => line.validTo === null || line.validTo > line.validFrom);
  const own = live.find(line => line.validFrom === effectiveDate);
  if (own) return { from: effectiveDate, to: inclusiveSuperiorEnd(own.validTo) };
  const next = live.map(line => line.validFrom).filter(day => day > effectiveDate).sort()[0];
  return { from: effectiveDate, to: next ? addCalendarDays(next, -1) : null };
}

/** Board 8f959c7a r2 — one live administrative line as the Direct Superior card lists it. */
export type DirectSuperiorLineRow = DirectSuperiorLine & { id: string; managerEmploymentId: string };

/** The token a card correction carries back: the exact live lines the user looked at. Any other writer in
 * between changes it, and the correction is refused instead of acting on periods the user never saw. */
export function directSuperiorRevision(lines: readonly DirectSuperiorLineRow[]): string {
  return [...lines].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.id < b.id ? -1 : 1))
    .map(line => `${line.id}@${line.validFrom}@${line.validTo ?? ''}@${line.managerEmploymentId}`).join(';');
}

/** Lines whose period runs straight into a later one with the same superior (the split HR asked to join). */
export function joinableSuperiorLineIds(lines: readonly DirectSuperiorLineRow[]): Set<string> {
  const ordered = [...lines].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  const ids = new Set<string>();
  for (let i = 0; i + 1 < ordered.length; i++) {
    const line = ordered[i], next = ordered[i + 1];
    if (line.validTo === next.validFrom && line.managerEmploymentId === next.managerEmploymentId) ids.add(line.id);
  }
  return ids;
}
