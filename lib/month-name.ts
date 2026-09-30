/**
 * r371 — ONE PAYROLL MONTH, NAMED THE SAME WAY ON EVERY SURFACE THAT NAMES IT.
 *
 * The PCB / MTD Calculation Detail screen has printed `June 2026` since 45df860a and the DOWNLOADED
 * calculation slip printed the stored `2026-06`, in its masthead and in its section 1, for the same
 * payslip. The reporter's criterion 20 is that the screen and the document show the same values; two
 * different spellings of one month is exactly the kind of difference that makes a reader holding both
 * documents stop trusting either. So the formatter is ONE function and both call it.
 *
 * ⚠️ `timeZone: 'UTC'` IS NOT DECORATION. `payPeriod` is a `YYYY-MM` label, not an instant. Constructing
 * the first of the month in local time and then formatting it in another zone can name the month before it
 * (Kuala Lumpur is UTC+8, so `new Date(2026, 5, 1)` is 2026-05-31T16:00Z). Both ends are pinned to UTC, so
 * the label is the label.
 *
 * ⚠️ AND IT NEVER THROWS ON A BAD LABEL. An unparseable or out-of-range period is returned AS STORED
 * rather than turned into "Invalid Date" or into a guessed month: the honest answer for a row whose own
 * period is unreadable is the row's own value. Same decision as `app/payroll/pcb-detail/page.tsx` made
 * when this lived there.
 */
export function monthYearLabel(payPeriod: string | null | undefined, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}
