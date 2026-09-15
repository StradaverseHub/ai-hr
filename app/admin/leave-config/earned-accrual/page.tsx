import { getTranslations } from 'next-intl/server';

import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
import { entitlementYearOptions } from '@/core/leave';
import { listCompanies, listJobGrades, listLeaveTypes } from '@/core/read';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { EarnedAccrualDialog } from '@/components/leave/earned-accrual-dialog';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';

/**
 * r281 (09386e29) — RUN EARNED ACCRUAL (`/admin/leave-config/earned-accrual`).
 *
 * ⚠️ WHY IT IS NOT A SECTION OF GENERATE ENTITLEMENT ANY MORE, which is the whole item. The two
 * operations are opposites that read as siblings: Generate Entitlement CREATES a leave year's
 * entitlement for a scope of employees, and this one must never do that — it posts what has already been
 * EARNED and is not yet on the ledger. Filing the second underneath the first put an operator one scroll
 * away from the one button they must not press by mistake. It is also not a once-a-year screen: fifteen
 * `leave.earned-accrual.run` events stand in the domain-event ledger, the most recent the day before this
 * round. So it takes a fly-out row of its own, DIRECTLY AFTER Generate Entitlement — neighbours, rather
 * than one filed inside the other.
 *
 * ⚠️ A MOUNT POINT AND A MENU ROW — NOTHING ELSE. The engine, the preview, the scope pickers and the CSV
 * export are the SAME `EarnedAccrualDialog` / `EarnedAccrualCard` the Generate screen drew, fed from the
 * same four reads and the same computed year range. No figure, no grouping and no idempotency property
 * changes: the preview still writes nothing, and a second run still posts only what is outstanding. Only
 * the address moved.
 *
 * ⚠️ THE SCOPE LISTS ARE THE ONES THE CARD WAS ALREADY FED, character for character, and the company
 * list is the narrow one ON PURPOSE. A group admin gets every company; anybody else gets only the
 * companies they hold an `hr_admin` grant for, because those are the only ones the accrual write can
 * reach. Widening it here would offer a scope whose rows the service then refuses, with nothing on screen
 * to say so. Grades are the ACTIVE ones (an archived grade cannot be a live scope) and the leave-type
 * list excludes archived types for the same reason.
 *
 * THE YEAR LIST IS COMPUTED, NOT READ (`entitlementYearOptions`, currentYear − 3 … currentYear + 6).
 * `leave_year_config` was emptied by migration 0385 and every writer to it deleted, so reading it would
 * render the selector permanently empty. Reaching BACK three years is load-bearing: running earned
 * accrual for a past year is a real operation and a forward-only range would silently remove it.
 * `status` is informational — the card renders the year and nothing else — so every computed year
 * arrives as 'draft', exactly what the old empty-config fallback produced.
 *
 * SERVER COMPONENT, and the card it mounts is the client island. Only SERIALISABLE props cross the
 * boundary — option arrays of plain `{ id, name }` and two numbers. No `t` and no closure: r123/r124 took
 * production screens down doing exactly that, and test/server-client-boundary.test.ts pins the class.
 */
export default async function LeaveConfigEarnedAccrualPage() {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const header = await leaveConfigPageHeader('earnedAccrual');

  const companies = await listCompanies(s);
  const [grades, types] = await Promise.all([
    listJobGrades(s),
    listLeaveTypes(s, { includeArchived: false }),
  ]);

  // The grant-aware company list: group-wide admins see every company, everybody else sees the ones they
  // administer. This is the scope the card was handed on its previous screen, unchanged.
  const effectiveGrants = withEffectiveGrants(s);
  const canGroupWide = isGroupAdmin(effectiveGrants);
  const accrualCompanies = (canGroupWide
    ? companies
    : companies.filter((c) => hasGrantFor(effectiveGrants, 'hr_admin', c.id))
  ).map((c) => ({ id: c.id, name: c.name }));
  const accrualGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));
  const accrualTypes = types.map((lt) => ({ id: lt.id, name: lt.name }));
  const currentYear = new Date().getUTCFullYear();
  const earnedLeaveYears = entitlementYearOptions(currentYear).map((y) => ({ year: y, status: 'draft' }));

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* One page under this row, so the tab row renders nothing; the mount stays so the module's
          "every page renders the map" guard keeps one shape, and so the strip appears by itself on the
          day this row gains a second screen. `current="earnedAccrual"` because this IS that screen. */}
      <LeaveConfigMap current="earnedAccrual" />

      <Card>
        <SectionHeader title={t('runEarnedAccrual')} />
        <div className="space-y-3 px-4 pb-4 pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">{t('entitlementStep.accrualHint')}</p>
          <EarnedAccrualDialog
            companies={accrualCompanies}
            grades={accrualGrades}
            leaveTypes={accrualTypes}
            leaveYears={earnedLeaveYears}
            defaultYear={currentYear}
          />
        </div>
      </Card>
    </div>
  );
}
