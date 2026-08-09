/**
 * e6a144d4 — "Download Excel on the Movement tab": the pure builder behind the Employment History file.
 *
 * THE FILE DELIBERATELY DOES NOT MIRROR THE SCREEN. 95d17761 took the rolled-back, cancelled, corrected
 * and superseded entries OFF the default profile view (lib/movement-visibility.ts — a VIEW filter; the
 * projection still returns every row). The download IGNORES that: the reporter asked for the complete
 * career record, so `partitionMovementRows` is never called on this path and every row carries an Event
 * Status column spelling out which of the six it is. A later reader will otherwise "fix" the file to agree
 * with the table — that would be a regression against an approved plan, not a tidy-up.
 *
 * Mirrors lib/movement-visibility.ts in shape: pure, translator-injected, no fixture ceremony, so the
 * column set and the status rule are unit-tested directly instead of pattern-matched out of a route.
 */
import type { MovementHistoryRow } from '../core/movement';

/** A `people.detail` namespace translator (the same one the Movement tab uses). */
export type MovementExportTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The status decision needs exactly these two fields — a whole history row satisfies it. */
export type MovementExportStatusRow = Pick<MovementHistoryRow, 'status' | 'reversed'>;

/** Everything one line of the file reads. A `MovementHistoryRow` satisfies it as-is. */
export type MovementExportRow = MovementExportStatusRow &
  Pick<
    MovementHistoryRow,
    | 'kind'
    | 'effectiveDate'
    | 'entryDate'
    | 'endDate'
    | 'remarks'
    | 'company'
    | 'division'
    | 'department'
    | 'section'
    | 'jobTitle'
    | 'currency'
    | 'basicAmount'
  >;

/**
 * The Event Status caption — Applied, Pending, Reversed, Cancelled, Corrected or Superseded, spelled out
 * so the column can be sorted and filtered inside Excel.
 *
 * Order matters and matches the badge the row wears on screen (page.tsx): a reversal wins over the derived
 * status, and WITHIN a reversal `corrected` (the reverse half of an edit) is checked before `cancelled`
 * (bd89ccd8 — undone while still pending, so it never applied), because an edited pending movement carries
 * both and "Corrected" is the honest word for it.
 */
export function movementStatusLabel(row: MovementExportStatusRow, t: MovementExportTranslator): string {
  const r = row.reversed;
  if (r?.corrected) return t('movement.correctedBadge');
  if (r?.cancelled) return t('movement.cancelledBadge');
  if (r) return t('movement.reversedBadge');
  switch (row.status) {
    case 'pending': return t('movement.status.pending');
    case 'superseded': return t('movement.status.superseded');
    // `reversed` with no reversal record is unreachable today (core/movement.ts derives the one from the
    // other), but a status this column exists to name must never come out blank.
    case 'reversed': return t('movement.reversedBadge');
    default: return t('movement.status.applied');
  }
}

/**
 * The fourteen column captions, left to right, as the approved mockup draws them.
 *
 * Only three of these keys are new (`columns.eventStatus`, `columns.correctionReason`, and the button's
 * own `exportExcel` which lives on the page). The rest are the captions the screen and the detail view
 * already use, reused ON PURPOSE so a caption can never say one thing on the tab and another in the file.
 */
export function movementExportColumns(t: MovementExportTranslator): string[] {
  return [
    t('movement.columns.eventType'),
    t('movement.columns.eventStatus'),
    t('movement.columns.effectiveDate'),
    // 941c9dac — when it was KEYED, as against when it takes effect. Not on the tab at all.
    t('movement.detail.recordedAt'),
    // r78c moved End Date and Remarks off the on-screen table for width. A spreadsheet has the room.
    t('movement.columns.endDate'),
    t('movement.columns.company'),
    t('movement.columns.division'),
    t('movement.columns.department'),
    t('movement.field.orgSection'),
    t('movement.columns.jobTitle'),
    t('movement.field.currency'),
    t('movement.field.basicSalary'),
    t('movement.columns.remarks'),
    t('movement.columns.correctionReason'),
  ];
}

/** Blank cells are EMPTY, never the on-screen em-dash — a dash is a value to a spreadsheet, and it
 *  poisons sorting and filtering on the column it sits in. */
const blank = (v: string | null | undefined): string => v ?? '';

export type MovementExportOptions = {
  t: MovementExportTranslator;
  /** Resolves the Event Type caption — the page's own resolver (lib/movement-kind-label.ts), already
   *  bound to the tenant's Movement Settings catalogue, so a renamed type reads the same in both places. */
  kindLabel: (kind: string) => string;
};

/** One line per event, index-aligned to `movementExportColumns`. */
export function movementExportRows(
  rows: readonly MovementExportRow[],
  { t, kindLabel }: MovementExportOptions,
): string[][] {
  return rows.map((r) => [
    kindLabel(r.kind),
    movementStatusLabel(r, t),
    r.effectiveDate,
    // Null only for the synthesized Hired row, which projects from no event at all.
    blank(r.entryDate),
    blank(r.endDate),
    blank(r.company),
    blank(r.division),
    blank(r.department),
    blank(r.section),
    blank(r.jobTitle),
    blank(r.currency),
    // BARE, never the joined `basic` string: toXlsxReport marks a cell numeric only when it parses as a
    // plain number, and a figure that arrives as text is one an operator cannot sum or chart.
    blank(r.basicAmount),
    blank(r.remarks),
    // The reason typed in when the event was rolled back or cancelled; blank on events that were neither.
    blank(r.reversed?.reason),
  ]);
}

/** Columns + rows built together, so the header list and the row shape cannot drift apart. */
export function buildMovementExport(
  rows: readonly MovementExportRow[],
  opts: MovementExportOptions,
): { columns: string[]; rows: string[][] } {
  return { columns: movementExportColumns(opts.t), rows: movementExportRows(rows, opts) };
}

/**
 * The download's filename base — the employee's own ID and name, then EmploymentHistory, so a folder of
 * them sorts itself. `employeeCode` is nullable (draft/imported employments), so it degrades to name-only
 * rather than printing an "undefined_" prefix. Whitespace collapses to underscores; the RFC 5987 header
 * helper in the route is what makes a CJK/Tamil name safe to put in a Content-Disposition.
 */
export function movementExportFilename(employeeCode: string | null | undefined, name: string): string {
  const tidy = (v: string) => v.trim().replace(/\s+/g, '_');
  const parts = [employeeCode ? tidy(employeeCode) : null, tidy(name) || null, 'EmploymentHistory'];
  return parts.filter(Boolean).join('_');
}
