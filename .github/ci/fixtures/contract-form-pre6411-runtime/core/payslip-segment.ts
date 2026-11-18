/**
 * 3c88d593 — the entity SEGMENT a payslip covers, read from the payslip's own snapshot.
 *
 * PURE AND DB-FREE, deliberately: the screen, the PDF, the completeness control and any report that
 * prints a segmented month must all apply ONE rule about what the record means, and none of them should be
 * able to re-derive a closed payslip's period from today's assignment history — which a later correction
 * could change underneath an already-issued document.
 *
 * ABSENT ⇒ NULL ⇒ the whole pay period, which is every payslip this system has ever produced except the
 * ones written for a month containing an entity transfer. A caller that gets null prints exactly what it
 * printed before this item existed.
 */

/** The inclusive range of the pay period this slip's employer actually employed the person for. */
export type PayslipSegment = { companyId: string; from: string; to: string };

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The segment stamped by core/payroll.ts, or null when the month was not split.
 *
 * Defensive about the blob's shape rather than trusting it: `payslip.statutory` is plain jsonb spanning
 * every payslip ever written, so a reader that assumes a field's type is one bad row away from throwing
 * on a screen. A malformed stamp reads as "no segment", which degrades to the pre-item rendering.
 */
export function payslipSegment(statutory: unknown): PayslipSegment | null {
  if (!statutory || typeof statutory !== 'object') return null;
  const seg = (statutory as Record<string, unknown>).segment;
  if (!seg || typeof seg !== 'object') return null;
  const { companyId, from, to } = seg as Record<string, unknown>;
  if (typeof companyId !== 'string' || !isDate(from) || !isDate(to)) return null;
  if (from > to) return null;
  return { companyId, from, to };
}

/** The inclusive window of a pay period a payslip claims. Every payslip has one; most claim all of it. */
export type PayslipCoverage = { from: string; to: string };

/**
 * 1b0943d5 — WHICH DAYS OF THE PERIOD THIS SLIP CLAIMS, resolved once, for every payslip ever written.
 *
 * THE ONE RULE, and the reason it is in one function: a payslip's coverage has three possible homes
 * depending on WHEN it was written, and a completeness check that disagreed with the screen about which
 * home to read would be a control that passes while the document says otherwise.
 *
 *   1. THE COLUMNS (`coverage_from` / `coverage_to`, migration 0446) — every slip written from stage two
 *      onward, split month or not. Authoritative when present.
 *   2. THE STAGE-ONE STAMP (`statutory.segment`) — a slip written by r194 for a split month, before the
 *      columns existed. Its range is the same fact, recorded in the only place there was to record it.
 *   3. NEITHER ⇒ THE WHOLE PAY PERIOD. Every payslip this system issued before r194, and every
 *      unsegmented slip r194 wrote. This is not a guess: a run that did not split the month paid the
 *      whole of it.
 *
 * `period` is the pay period's own bounds ('YYYY-MM-01' … last day), supplied by the caller because a
 * payslip row does not carry them — the batch does. PURE, so the tiling arithmetic that decides whether a
 * transferred month is complete is testable without a payroll run.
 */
export function payslipCoverage(
  slip: { coverageFrom?: string | null; coverageTo?: string | null; statutory?: unknown },
  period: PayslipCoverage,
): PayslipCoverage {
  const { coverageFrom, coverageTo } = slip;
  // Both-or-neither is a DB constraint (payslip_coverage_ordered), but this reader spans jsonb-era rows
  // and any future writer, so it re-checks rather than trusting: a half-set pair falls through to the
  // stamp, then to the whole period, and can never produce a one-ended range the tiling cannot compare.
  if (isDate(coverageFrom) && isDate(coverageTo) && coverageFrom <= coverageTo) {
    return { from: coverageFrom, to: coverageTo };
  }
  const seg = payslipSegment(slip.statutory);
  if (seg) return { from: seg.from, to: seg.to };
  return { from: period.from, to: period.to };
}

/**
 * The inclusive bounds of a 'YYYY-MM' pay period. Returns null for anything that is not one.
 *
 * NOT SHARED WITH core/payroll.ts's `daysInMonth`, deliberately, and the reason is this module's whole
 * premise: it is DEPENDENCY-FREE so a screen and two PDF routes can read a payslip's coverage without
 * pulling in the 7,000-line payroll kernel. The calendar fact is the same one; the input shape is not
 * (a period string here, a year/month pair there), and importing the kernel into a PDF route to avoid
 * four lines of date arithmetic would be the worse trade.
 */
export function payPeriodBounds(payPeriod: string): PayslipCoverage | null {
  if (!/^\d{4}-\d{2}$/.test(payPeriod)) return null;
  const [y, m] = payPeriod.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  // Day 0 of the NEXT month is the last day of this one, and UTC throughout so a negative-offset render
  // can never shift the month by one.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${payPeriod}-01`, to: `${payPeriod}-${String(last).padStart(2, '0')}` };
}

/**
 * THE ONE QUESTION EVERY SCREEN AND DOCUMENT ASKS: does this payslip cover less than its whole month —
 * and if so, which days? Null means "the whole period", which is what every payslip in this system means
 * unless an entity transfer split the month underneath it.
 *
 * IT IS DERIVED, NOT STORED, and that is what stops the document and the completeness control drifting.
 * Before stage two "is this slip segmented" was "does `statutory.segment` exist", a separate fact that a
 * writer could set while the coverage columns said otherwise. Now there is one fact — the coverage window
 * (columns, then the r194 stamp, then the whole period) — and being segmented simply means that window is
 * narrower than the period. A slip covering all of August renders exactly what it rendered before this
 * item existed, because it is not narrower than anything.
 */
export function payslipSegmentOf(
  slip: { coverageFrom?: string | null; coverageTo?: string | null; statutory?: unknown },
  payPeriod: string,
): PayslipCoverage | null {
  const period = payPeriodBounds(payPeriod);
  if (!period) return null;
  const cov = payslipCoverage(slip, period);
  return cov.from > period.from || cov.to < period.to ? cov : null;
}
