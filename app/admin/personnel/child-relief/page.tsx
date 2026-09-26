import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { childReliefReview } from '@/core/child-relief-review';
import { Card, PageHeader, pageWideCls } from '@/components/ui';
import {
  ChildReliefAmountsCard,
  ChildReliefDisagreementTable,
  ChildReliefCategoryGapTable,
  ChildReliefReviewTable,
} from '@/components/child-relief-review-table';

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
 * ═══ ⚠️ THE FIVE CATEGORY AMOUNTS ARE SOURCED FROM THE SPEC, AND STILL NOT SIGNED OFF ═══
 *
 * UPDATED BY 04b88724 (r339). This block used to say the amounts were RATE-ONLY, NOT YET VERIFIED —
 * transcribed from a secondary summary. That is no longer true: all five now carry a per-value citation to
 * the LHDN 2026 MTD computerised-calculation specification, printed pages 26–27, Reliefs table item c, read
 * directly. Two of them were WRONG and were corrected in that round (`disabled` RM6,000 → RM8,000,
 * `disabled_study` RM14,000 → RM16,000 — we had been quoting the annual-assessment schedule).
 *
 * The amounts card below still says "awaiting sign-off", and that is correct, not a leftover: a figure
 * being transcribed from the primary publication is not the same as an accountant having signed it off for
 * a real filing, which is what the file header and docs/architecture/STATUTORY-SOURCES.md require. A
 * report that prints ringgit without that caveat invites somebody to act on a number no human has checked.
 *
 * ═══ ⚠️ THIS SCREEN IS NO LONGER LINKED FROM ANYWHERE ═══
 *
 * 04b88724 removed the entry point on the Personnel Management main page at the reporter's request ("the
 * function is not required"). The ROUTE was kept deliberately — the approved plan promised them this list
 * before any migration of the other 74 employees off flat child counting, and deleting the instrument in
 * the same round would break that promise. The full reasoning is at the link's old site in
 * app/admin/personnel/page.tsx. It keeps its `SCREENS` column in lib/permissions.ts, so it remains a
 * grantable function that a role can be given; it is reachable by URL and by nothing else.
 *
 * SERVER COMPONENT. The table is a client island receiving plain numbers only — no function crosses the
 * boundary (test/server-client-boundary.test.ts exists because that failure is invisible to tsc,
 * the suite and `next build` alike).
 *
 * ACCESS. `requireAdmin()` is the page gate and `core/child-relief-review.ts` refuses a non-admin caller
 * in its own right; RLS decides which employments exist at all, so a company-scoped administrator sees
 * their companies and the totals are the totals of what they can see.
 */
/**
 * The SAME ringgit formatting the table uses — two fixed decimals, en-MY grouping, in every locale.
 * Declared here rather than imported from the client island: a non-component export of a 'use client'
 * module becomes a client reference, which a server component cannot call.
 */
const money = (n: number) =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

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
            <p className="text-2xl font-semibold tabular-nums">{money(view.totals.todayRM)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statTodayRM')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{money(view.totals.switchRM)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('statSwitchRM')}</p>
          </div>
          <div>
            <p
              className={`text-2xl font-semibold tabular-nums ${
                view.totals.deltaRM < 0 ? 'text-amber-700 dark:text-amber-400' : ''
              }`}
            >
              {view.totals.deltaRM > 0 ? `+${money(view.totals.deltaRM)}` : money(view.totals.deltaRM)}
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

      {/* ══ r343 03f89c0f — TYPED CHILD COUNTS ABOVE THE FAMILY RECORD ═══════════════════════════════
          Measured on production 2026-09-26: 22 employees on 'manual' type a child count ABOVE the children
          on file, 0 below, 5 agree — 52 children carrying RM104,000 of relief that no Family record
          supports, and 7 of the 22 have already been paid. Nobody had reported it; the r341 round that made
          this figure say whether it was worked out or entered is what made it visible at all.

          ⚠️ IT IS A DECISION, NOT A DEFECT, AND THE CAPTION HAS TO CARRY THAT. A typed figure is legitimate;
          some of those 52 children are probably real and simply never entered, in which case the typed
          number is right and the RECORD is incomplete. Nothing in this system can tell which. So this
          section changes nobody, offers no bulk action, and is worded throughout as a disagreement to look
          at rather than an error to clear.

          ⚠️ IT SAYS WHICH COUNT THE COLUMNS ARE. num_children is a HEAD COUNT (Form E, CP8D and EA read it
          as one); the Family register carries per-child s.48 categories weighting 1 / 4 / 8. Head against
          head is the right comparison for THIS question, and the caption says so, because a reader who
          assumed the weighted count would read the difference column as meaning something it does not.

          ⚠️ IT DOES NOT RECOMMEND AUTO YET. Auto derives the head count from the record, which fixes the
          drift — but item 04b88724's weighting has NOT reached the payroll calculation (core/dependents.ts
          `eligibleChildReliefUnits` records exactly what is still missing), so Auto today still relieves a
          higher-education or disabled child as one child. The note says that plainly instead of sending
          somebody to a setting that is only right for under-18 and pre-university children. */}
      {view.recordDisagreement.people.length > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('disagreeTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('disagreeDescription')}</p>
          <div className="mt-4 flex flex-wrap items-end gap-8">
            <div>
              <p className="text-3xl font-semibold tabular-nums">{view.recordDisagreement.people.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('disagreeStatPeople')}</p>
            </div>
            <div>
              <p className="text-3xl font-semibold tabular-nums">{view.recordDisagreement.excessChildren}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('disagreeStatChildren')}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {money(view.recordDisagreement.excessReliefRM)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('disagreeStatReliefRM')}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm text-muted-foreground">
            <li>{t('disagreeHeadCountNote')}</li>
            <li>{t('disagreeNotAnErrorNote')}</li>
            <li>{t('disagreeNoBulkNote')}</li>
            <li>{t('disagreeAutoCaveatNote')}</li>
          </ul>
        </Card>
      )}
      {view.recordDisagreement.people.length > 0 && (
        <Card className="overflow-hidden">
          <ChildReliefDisagreementTable rows={view.recordDisagreement.people} />
        </Card>
      )}

      {/* ── THE CATEGORIES THAT ARE NOT THERE — item 9653472a (r345) ─────────────────────────────────
          r344 made an 'auto' employee's relief price from the Family register's s.48 categories, but
          gated the derived grid on every eligible child carrying one: `childReliefGridFromFamily` SKIPS a
          child it cannot classify, so pricing a partial grid would relieve FEWER children than the
          employee has. The gate is right and stays. Its consequence is that the weighting reaches NOBODY
          until the categories are filled in, and until now nothing said so anywhere.

          ⚠️ NO "YOU COULD BE RELIEVING RM X" FIGURE. The weight of an uncategorised child is unknown by
          definition — 1 unit or 8 — so that number cannot be stood behind (§8). The card states the gap
          and what relief is given today, and stops there. */}
      {view.categoryGap.people.length > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('gapTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('gapDescription')}</p>
          <div className="mt-4 flex flex-wrap items-end gap-8">
            <div>
              <p className="text-3xl font-semibold tabular-nums">{view.categoryGap.people.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('gapStatPeople')}</p>
            </div>
            <div>
              <p className="text-3xl font-semibold tabular-nums">
                {view.categoryGap.uncategorisedChildren}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('gapStatChildren')}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm text-muted-foreground">
            <li>{t('gapWhyNote')}</li>
            <li>{t('gapNotAnErrorNote')}</li>
            <li>{t('gapNoBulkNote')}</li>
            <li>{t('gapManualNote')}</li>
          </ul>
        </Card>
      )}
      {view.categoryGap.people.length > 0 && (
        <Card className="overflow-hidden">
          <ChildReliefCategoryGapTable rows={view.categoryGap.people} />
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
