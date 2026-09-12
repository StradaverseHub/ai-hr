import { getTranslations } from 'next-intl/server';
import { holidayCalendarRisk, type HolidayCalendarCoverage } from '@/core/holidays';

/**
 * 0e276da0 (r269) — the ONE place the "this calendar would strip your staff of public holidays"
 * sentence is written, so the Locations screen and the calendar's own screen say the same thing.
 *
 * A SERVER component (no state, no handlers) — the page it sits on is a server component and this
 * keeps it that way (test/server-client-boundary.test.ts).
 *
 * WARN, NEVER BLOCK. There is no CHECK constraint and no refusal behind this: a calendar that
 * deliberately holds fewer days is a real thing, and the note says so in every locale. It renders
 * nothing at all for a standard/extended calendar — those still get the gazette, so they can never
 * strip a day — and nothing for a complete custom one unless `showComplete` asks for the reassurance.
 *
 * `year` is passed to the translator as a STRING on purpose: ICU formats a number argument, so
 * `{year}` given 2026 renders "2,026".
 */
export async function HolidayCoverageWarning({
  coverage,
  showComplete = false,
  className = '',
}: {
  coverage: HolidayCalendarCoverage;
  /** Also render the reassuring line when a stand-alone calendar leaves nothing out. */
  showComplete?: boolean;
  className?: string;
}) {
  const t = await getTranslations('admin.holidayCoverage');
  const risk = holidayCalendarRisk(coverage);
  const year = String(coverage.year);

  if (!risk) {
    if (!showComplete || !coverage.standalone) return null;
    return (
      <p className={`text-xs text-muted-foreground ${className}`}>
        {t('okLine', { name: coverage.name, gazette: coverage.gazette, year })}
      </p>
    );
  }

  return (
    <div
      className={`rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 ${className}`}
    >
      <p className="font-medium">
        {risk === 'empty' ? t('warnEmptyTitle') : t('warnMissingTitle', { missing: coverage.missing.length })}
      </p>
      <p className="mt-1">
        {risk === 'empty'
          ? t('warnEmptyBody', { name: coverage.name, gazette: coverage.gazette, year })
          : t('warnMissingBody', {
              name: coverage.name,
              // COVERED, not `held`. `held` counts the days this calendar SUPPLIES, and the tick list can
              // pick any master holiday including another state's, so `held` can exceed `gazette` and the
              // sentence would read "holds 13 of the 12" while naming a missing day. Found by the verify
              // pass on a built case (not reachable from today's production data, but arithmetic nonsense
              // is not something to leave on a screen). Covered is gazetted-minus-missing by construction,
              // so it can never exceed the total.
              held: coverage.gazette - coverage.missing.length,
              gazette: coverage.gazette,
              year,
            })}
      </p>
      {coverage.missing.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {coverage.missing.map((m) => (
            <li key={m.date} className="tabular-nums">
              {t('gapRow', { date: m.date, name: m.name })}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 opacity-80">{t('note')}</p>
    </div>
  );
}
