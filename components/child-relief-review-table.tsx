'use client';

/**
 * CHILD RELIEF REVIEW — the table, item 99b2d6c0 (r336).
 *
 * A CLIENT ISLAND holding NOTHING but presentation: it receives already-priced plain numbers and renders
 * them. It is a separate component from the page for one reason — a dev-server render check can only
 * prove the SERVER pass, and the six-locale proof this screen needs has to render the POPULATED table,
 * which the seeded database has no rows for (no seeded employee has children). `test/child-relief-review-locales.dom.test.tsx`
 * renders exactly this component against all six real catalogues.
 *
 * ⚠️ IT SUBMITS NOTHING. There is no form, no action, no checkbox and no "apply". Switching 70 people
 * from flat counting onto the LHDN category grid changes their monthly PCB and their statutory return;
 * this screen exists so that decision is made with the ringgit in front of the person making it, and the
 * only interactive element on it is a link to somebody's record.
 *
 * MONEY FORMATTING: `Intl.NumberFormat('en-MY')` with two fixed decimals, so every figure reads as the
 * amount it is in every locale rather than picking up a locale's own grouping for a Malaysian ringgit
 * figure that the payslip prints one way.
 */
import { useTranslations } from 'next-intl';
import { tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';

/** Ringgit, two fixed decimals, en-MY grouping — the way a payslip prints it, in every locale. */
const money = (n: number) =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/** Signed, so "less relief" reads as less at a glance and never as an unexplained smaller number. */
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));

/**
 * THE AMOUNTS EVERY FIGURE ON THE SCREEN WAS PRICED WITH — and the caveat that must travel with them.
 *
 * ⚠️ EXTRACTED FOR THE SAME REASON THE TABLE IS. This card renders only when somebody is listed, so on
 * the seeded database (which has no employee with children) a dev-server render check never reaches it —
 * and `pricedBy` carries TWO ICU arguments, which is precisely the shape that paints a FORMATTING_ERROR
 * in a browser while passing tsc, the suite and `next build`. It is proved against all six catalogues in
 * test/child-relief-review-locales.dom.test.tsx instead.
 *
 * ⚠️ THE PENDING-SIGN-OFF LINE IS NOT DECORATION. The five `childByCategory` figures are marked
 * RATE-ONLY, NOT YET VERIFIED in localization/my/statutory-tables.ts — transcribed from a published
 * summary because the LHDN spec URL 404s — and this is the screen where somebody reads a ringgit number
 * and decides to act on it. The same sentence is on the PCB configuration screen; it is repeated here
 * rather than linked, because a caveat one click away is a caveat nobody reads.
 */
export function ChildReliefAmountsCard({
  version,
  asOf,
  perChild,
  categories,
}: {
  version: string | null;
  asOf: string;
  perChild: number | null;
  categories: { key: string; amount: number }[];
}) {
  const t = useTranslations('people.childRelief');
  return (
    <>
      <h2 className="text-sm font-semibold">{t('amountsTitle')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('pricedBy', { version: version ?? '—', asOf })}</p>
      <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {perChild != null && (
          <p className="flex justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{t('amountPerChild')}</span>
            <span className="font-mono tabular-nums">{money(perChild)}</span>
          </p>
        )}
        {categories.map((c) => (
          <p key={c.key} className="flex justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{t(`cat_${c.key}`)}</span>
            <span className="font-mono tabular-nums">{money(c.amount)}</span>
          </p>
        ))}
      </div>
      <p className="mt-3 border-t border-border pt-3 text-xs text-amber-700 dark:text-amber-400">
        {t('amountsPendingSignOff')}
      </p>
    </>
  );
}

export type ChildReliefReviewTableRow = {
  personId: string;
  name: string;
  jobs: { employmentId: string; employeeCode: string | null; company: string }[];
  mode: string;
  numChildren: number;
  todayRM: number;
  switchRM: number;
  deltaRM: number;
  gridKeyed: boolean;
  familyRM: number | null;
  familyEligible: number;
  familyCategorised: number;
};

export function ChildReliefReviewTable({ rows }: { rows: ChildReliefReviewTableRow[] }) {
  const t = useTranslations('people.childRelief');
  // The three stored modes, named through a fixed map: an unrecognised value renders as itself rather
  // than as a missing message, which is what a legacy or hand-edited row would otherwise paint.
  const modeLabel: Record<string, string> = {
    manual: t('modeManual'),
    auto: t('modeAuto'),
    auto_table: t('modeAutoTable'),
  };
  return (
    <div className={tableWrapCls}>
      <table className="w-full text-sm">
        <thead className={theadCls}>
          <tr>
            <th className={thCls}>{t('colEmployee')}</th>
            <th className={thCls}>{t('colMode')}</th>
            <th className={`${thCls} text-right`}>{t('colChildren')}</th>
            <th className={`${thCls} text-right`}>{t('colToday')}</th>
            <th className={`${thCls} text-right`}>{t('colSwitch')}</th>
            <th className={`${thCls} text-right`}>{t('colChange')}</th>
            <th className={`${thCls} text-right`}>{t('colFamily')}</th>
          </tr>
        </thead>
        <tbody className={tbodyCls}>
          {rows.map((r) => (
            <tr key={r.personId} className="align-top">
              <td className="px-3 py-2">
                <span className="font-medium text-foreground">{r.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {r.jobs.map((j) => [j.employeeCode, j.company].filter(Boolean).join(' · ')).join(' / ')}
                </span>
                {/* The way IN to the grid — the whole reachability half of this item. One link per job,
                    because the grid lives on the person's statutory row and either record reaches it. */}
                {r.jobs.map((j) => (
                  <a
                    key={j.employmentId}
                    href={`/admin/personnel/${j.employmentId}?tab=bankStatutory`}
                    className="mt-1 mr-2 inline-block text-xs font-medium text-primary underline underline-offset-2"
                  >
                    {t('openRecord')}
                  </a>
                ))}
              </td>
              <td className="px-3 py-2">
                {modeLabel[r.mode] ?? r.mode}
                {r.mode === 'auto_table' && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t('alreadyOnTable')}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{r.numChildren}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.todayRM)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(r.switchRM)}
                {/* ⚠️ THE FOOT-GUN, NAMED IN RINGGIT. An empty grid prices at RM 0, so a switch made
                    without keying one RAISES this person's tax. Shown on the row it applies to, in the
                    column that would be wrong, rather than as a general caveat nobody reads. */}
                {!r.gridKeyed && r.mode !== 'auto_table' && (
                  <span className="mt-0.5 block text-xs font-medium text-amber-700 dark:text-amber-400">
                    {t('gridEmptyWarning')}
                  </span>
                )}
              </td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${
                  r.deltaRM < 0 ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'
                }`}
              >
                {signedMoney(r.deltaRM)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.familyRM == null ? (
                  <span className="text-muted-foreground">{t('familyNone')}</span>
                ) : (
                  <>
                    {money(r.familyRM)}
                    {r.familyCategorised < r.familyEligible && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('familyPartial', { done: r.familyCategorised, total: r.familyEligible })}
                      </span>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
