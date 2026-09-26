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

/** A signed whole count, on the same principle: the '+' is DERIVED from the value, so a negative difference
 *  prints as "-2" rather than as the "+-2" a hardcoded plus sign would produce. */
const signedCount = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * THE AMOUNTS EVERY FIGURE ON THE SCREEN WAS PRICED WITH — and the caveat that must travel with them.
 *
 * ⚠️ EXTRACTED FOR THE SAME REASON THE TABLE IS. This card renders only when somebody is listed, so on
 * the seeded database (which has no employee with children) a dev-server render check never reaches it —
 * and `pricedBy` carries TWO ICU arguments, which is precisely the shape that paints a FORMATTING_ERROR
 * in a browser while passing tsc, the suite and `next build`. It is proved against all six catalogues in
 * test/child-relief-review-locales.dom.test.tsx instead.
 *
 * ⚠️ THE PENDING-SIGN-OFF LINE IS NOT DECORATION, AND IT STILL BELONGS HERE AFTER 04b88724 (r339).
 * That item read the LHDN MTD specification directly and re-footed all five `childByCategory` figures on
 * the PRIMARY publication (printed pages 26–27, Reliefs table item c), correcting two of them along the
 * way — so the old wording, "transcribed from a published summary because the LHDN spec URL 404s", is no
 * longer what localization/my/statutory-tables.ts says. Read the citation block there for the current
 * provenance.
 * The line stays because SOURCED IS NOT SIGNED OFF. The file header and STATUTORY-SOURCES.md require a
 * human — an accountant or payroll officer — to check a statutory figure before a real filing relies on
 * it, and an agent reading a PDF is not that person. This is the screen where somebody reads a ringgit
 * number and decides to act on it, so the sentence that says "a human has not yet signed this" must
 * survive the figures becoming right. Removing it on the strength of a correction would be the same
 * mistake this item exists to fix, in the opposite direction.
 * The same sentence is on the PCB configuration screen; it is repeated here rather than linked, because a
 * caveat one click away is a caveat nobody reads.
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

/**
 * ═══ r343, item 03f89c0f — TYPED CHILD COUNTS THAT DISAGREE WITH THE FAMILY RECORD ═══
 *
 * Measured on production 2026-09-26: 22 employees on 'manual' carry a typed child count ABOVE the children
 * on file, none below, five agree. Between them that is 52 children who appear in no Family record, and at
 * RM2,000 of relief each, RM104,000 of relief the records do not support. Seven of the 22 have been paid.
 * Relief reduces chargeable income, so too much relief means too little PCB deducted every month.
 *
 * ⚠️ A TYPED FIGURE IS NOT A DEFECT, AND THIS TABLE MUST NEVER CALL IT ONE. 'manual' is a legitimate,
 * deliberate setting. Some of those 52 children are probably real and were simply never entered into the
 * Family register — in which case the typed figure is RIGHT and the record is what is incomplete. Nothing
 * here can tell those two cases apart, so every row is worded as a DISAGREEMENT to look at and never as an
 * error to clear.
 *
 * ⚠️ NO BULK ACTION, DELIBERATELY. There is no "fix all", no checkbox, no Apply. 52 children whose reality
 * nobody has established is the worst possible thing to change in one click, and correcting a figure RAISES
 * that employee's PCB from the next run. The only interactive element is a link to one person's record — the
 * same posture the report above it takes, for the same reason.
 *
 * ⚠️ HEAD COUNT AGAINST HEAD COUNT, AND THE CAPTION ON THE PAGE SAYS SO. `num_children` is a head count
 * (Form E, CP8D and the EA statement all read it as one) while the Family register carries per-child s.48
 * categories that weight 1 / 4 / 8. Both columns here count CHILDREN, one per child. Comparing a head count
 * against a weighted count is a different question and would make the difference column meaningless.
 *
 * CLIENT ISLAND for the same reason the table above is one: `pnpm db:seed` creates no employee with
 * children, so a dev-server render check can only ever reach this screen's empty state. The six-locale
 * proof is test/child-relief-disagreement-locales-r343.dom.test.tsx (the r343 fix pass corrected this
 * pointer: it named a `-03f89c0f` file that has never existed). WHICH ROWS reach this table — and the
 * Card's two headline figures above it — is a separate question and is pinned against a real database by
 * test/child-relief-disagreement-subset-r343.test.ts; the copy on that Card resolves through next-intl in
 * all six locales in test/child-relief-disagreement-locales-r343.dom.test.tsx.
 */
export type ChildReliefDisagreementRow = {
  personId: string;
  name: string;
  jobs: { employmentId: string; employeeCode: string | null; company: string }[];
  /** `num_children` as typed — a HEAD COUNT. */
  numChildren: number;
  /** Eligible child rows on the Family register — also a HEAD COUNT, one per child. */
  familyEligible: number;
  /** How many of those carry a recorded s.48 relief category. Shown so the reader knows how complete the
   *  record they are being asked to judge actually is. */
  familyCategorised: number;
  /** `numChildren − familyEligible`. Positive on every row this table lists. */
  typedExcess: number | null;
  /** Relief the typed figure claims today (RM). */
  todayRM: number;
  /** Relief the children on file support, on the same head-count basis (RM). */
  recordRM: number;
  /** Relief carried by the difference (RM) — priced by the pack, never by a constant in this island. */
  excessRM: number;
};

export function ChildReliefDisagreementTable({ rows }: { rows: ChildReliefDisagreementRow[] }) {
  const t = useTranslations('people.childRelief');
  return (
    <div className={tableWrapCls}>
      <table className="w-full text-sm">
        <thead className={theadCls}>
          <tr>
            <th className={thCls}>{t('colEmployee')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColTyped')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColOnFile')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColDifference')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColTypedRM')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColRecordRM')}</th>
            <th className={`${thCls} text-right`}>{t('disagreeColUnsupportedRM')}</th>
          </tr>
        </thead>
        <tbody className={tbodyCls}>
          {rows.map((r) => (
            <tr key={r.personId} className="align-top" data-disagreement-row>
              <td className="px-3 py-2">
                <span className="font-medium text-foreground">{r.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {r.jobs.map((j) => [j.employeeCode, j.company].filter(Boolean).join(' · ')).join(' / ')}
                </span>
                {/* The way in to ONE record at a time — which is the whole point: the corrections are the
                    reader's to make one person at a time, with the reasons in front of them. */}
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
              <td className="px-3 py-2 text-right tabular-nums">{r.numChildren}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.familyEligible}
                {/* How complete the record is. A reader deciding whether the typed figure or the record is
                    right needs to know the record may be half-keyed. */}
                {r.familyCategorised < r.familyEligible && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t('disagreeCategorised', { done: r.familyCategorised, total: r.familyEligible })}
                  </span>
                )}
              </td>
              {/* THE SIGN COMES FROM THE NUMBER, not from what this table expects to be handed. Every row
                  the screen passes is a figure typed ABOVE the record (core/child-relief-review.ts filters
                  on `typedExcess > 0`, pinned by test/child-relief-disagreement-subset-r343.test.ts), so in
                  practice this always prints '+'. It used to print a literal '+' in front of the value,
                  which would have rendered a widened filter as "+-2" — a wrong number, on a money screen,
                  from a caller-side change with nothing to stop it. */}
              <td className="px-3 py-2 text-right font-medium tabular-nums">
                {signedCount(r.typedExcess ?? 0)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.todayRM)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.recordRM)}</td>
              {/* NOT coloured as an error. It is the size of a disagreement, and the caption above says the
                  record is as likely to be the incomplete half as the figure. */}
              <td className="px-3 py-2 text-right tabular-nums">{money(r.excessRM)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
