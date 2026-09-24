import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { childReliefReview } from '@/core/child-relief-review';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import { ChildReliefAmountsCard, ChildReliefReviewTable } from '@/components/child-relief-review-table';

/**
 * 99b2d6c0 (r336) — CHILD RELIEF REVIEW (PCB).
 *
 * ═══ WHY THIS SCREEN EXISTS ═══
 *
 * The five LHDN s.48 child-relief categories have been priced and applied since item d64d0df4 (ruleset
 * 2026.7). What was missing was any way to SEE them: the category grid renders only after an admin picks
 * a third option out of a dropdown on one employee's Bank & Statutory tab, one employee at a time. So
 * two things were true at once — the capability existed, and nobody could find it or judge it.
 *
 * This screen is both halves of the fix. It is the WAY IN (every employee with children, one link each
 * straight to their grid) and it is the REPORT that must come first: for every one of them, what PCB
 * deducts for their children today, what it would deduct on the category table, and the difference in
 * ringgit.
 *
 * ═══ ⚠️ IT CHANGES NOTHING, AND THAT IS THE DESIGN ═══
 *
 * There is no "switch everyone", no bulk action, no checkbox and no migration behind this page. Moving
 * people from flat counting onto the category grid moves their monthly PCB — money on a statutory
 * return, on real payslips. The reporter asked to see the impact before it happens, and a report with an
 * Apply button on it is not that. The only interactive element on this page is a link to a record.
 *
 * ═══ ⚠️ THE FINDING THIS SCREEN PUTS IN FRONT OF THE READER ═══
 *
 * An employee switched to the category table with NO grid keyed claims RM 0 of child relief — their
 * chargeable income rises and their tax goes UP. The `colSwitch` figure is computed from the grid
 * actually stored, so that row reports the drop to zero in ringgit, with a warning on the row itself.
 *
 * ═══ ⚠️ THE FIVE CATEGORY AMOUNTS ARE NOT SIGNED OFF ═══
 *
 * `childByCategory` is marked RATE-ONLY, NOT YET VERIFIED in localization/my/statutory-tables.ts — the
 * same footing as the two OKU reliefs, and listed as such in docs/architecture/STATUTORY-SOURCES.md §1.
 * The amounts card below says so in the reader's own words, because a report that prints ringgit without
 * that caveat invites somebody to act on a figure this repo cannot yet stand behind.
 *
 * SERVER COMPONENT. The table is a client island receiving plain numbers only — no function crosses the
 * boundary (test/server-client-boundary.test.ts exists because that failure is invisible to tsc,
 * the suite and `next build` alike).
 *
 * ACCESS. `requireAdmin()` is the page gate and `core/child-relief-review.ts` refuses a non-admin caller
 * in its own right; RLS decides which employments exist at all, so a company-scoped administrator sees
 * their companies and the totals are the totals of what they can see.
 */
export default async function ChildReliefReviewPage() {
  const s = await requireAdmin();
  const t = await getTranslations('people.childRelief');
  const view = await childReliefReview(s);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('description')}
        back={{ href: '/admin/personnel', label: t('backToPersonnel') }}
      />

      {/* THE CAPTION IS LOAD-BEARING. Four columns of ringgit under the word "relief" read as a
          recommendation; these four lines are what make them a measurement. */}
      <Card className="p-5">
        <p className="text-sm font-medium">{t('howToReadTitle')}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>{t('howToReadToday')}</li>
          <li>{t('howToReadSwitch')}</li>
          <li>{t('howToReadFamily')}</li>
          <li>{t('howToReadNothingChanges')}</li>
        </ul>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-8">
          <div>
            <p className="text-3xl font-semibold tabular-nums">{view.totals.people}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statPeople')}</p>
          </div>
          <div>
            <p className="text-3xl font-semibold tabular-nums">{view.totals.children}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statChildren')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{view.totals.todayRM.toFixed(2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statTodayRM')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{view.totals.switchRM.toFixed(2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statSwitchRM')}</p>
          </div>
          <div>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                view.totals.deltaRM < 0 ? 'text-amber-700 dark:text-amber-400' : ''
              }`}
            >
              {view.totals.deltaRM > 0 ? `+${view.totals.deltaRM.toFixed(2)}` : view.totals.deltaRM.toFixed(2)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statDeltaRM')}</p>
          </div>
        </div>
        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{t('activeOnlyNote')}</p>
      </Card>

      {/* The amounts every figure above was priced with — the SAME resolved ruleset the payroll run uses,
          quoted rather than restated. `statutoryVersion` is the stamp core/payroll.ts already writes onto
          a payslip, so this page names the version that priced it instead of introducing a second year
          marker of its own. Rendered only when somebody is listed: with nobody to report on there is no
          ringgit figure to caveat, and an amounts card on an empty screen invites a sign-off decision
          about a population that does not exist. */}
      {view.categoryAmounts.length > 0 && (
        <Card className="p-5">
          <ChildReliefAmountsCard
            version={view.statutoryVersion}
            asOf={view.asOf}
            perChild={view.perChild}
            categories={view.categoryAmounts}
          />
        </Card>
      )}

      {view.people.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm">{t('emptyTitle')}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('emptyBody')}</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ChildReliefReviewTable rows={view.people} />
          <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">{t('shareNote')}</p>
        </Card>
      )}
    </div>
  );
}
