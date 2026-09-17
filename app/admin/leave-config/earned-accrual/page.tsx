import { getTranslations } from 'next-intl/server';

import { requireAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '@/lib/authz';
// r299 (3de1453a) — THE PREDICATE THE SWEEP IS ACTUALLY DECIDED ON, read from the engine that decides it.
// `accrueEarnedLeave` keeps only the types `isEarnedAccrualType` accepts — Annual Leave, by role first and
// by the code ANNUAL for an unclassified row — BEFORE it reads a single employment. (r293 imported
// `STANDING_LEAVE_CODES` here; the reporter's rule retired that constant from this sweep.) Imported on the
// SERVER and handed across as plain booleans: the card is a client island and this module opens the
// database connection. A second statement of the rule written on this screen would be free to drift from
// the filter it describes, which is the failure mode r288 and r293 each paid for.
import { entitlementYearOptions, isEarnedAccrualType } from '@/core/leave';
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
 * ⚠️ r293 → r299 — EACH LEAVE TYPE CARRIES WHETHER THE SWEEP CAN REACH IT AT ALL. The list itself is
 * unchanged (every active type). r293 MARKED the unreachable ones and kept them selectable; r299
 * (3de1453a) narrowed the engine to Annual Leave on the reporter's instruction ("Only Annual Leave is
 * subject to the Earned Accrual concept") and the picker now DISABLES every other type, tagged
 * Entitlement-based, while Annual Leave carries Earned accrual. The engine is still the control: a crafted
 * scope naming a non-Annual id returns `type_not_swept` and writes nothing. Festive types stay outside the
 * sweep exactly as ADR-0066 §89 wants, because they are not Annual Leave; keying accrual on
 * `accrual_method` alone is still NOT what this does.
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
  /**
   * r293 → r299 — THE PICKER SAYS WHICH TYPES THIS SCREEN CAN ACTUALLY ACCRUE, BEFORE A RUN IS SPENT.
   *
   * `types` is every ACTIVE leave type (`includeArchived: false` above) — Annual Leave or not — and the
   * list stays that way: dropping the rows would hide the very type an operator went looking for, and the
   * engine's typed empty reason (`type_not_swept`) is still the authority on why a run found nothing. Each
   * option carries ONE BOOLEAN, decided here by the engine's own predicate; the card disables and tags on
   * it and re-derives nothing. `role` rides on `listLeaveTypes`' rows — without it every row would read as
   * unclassified and fall back to its code, which is the r293 behaviour this round replaces.
   *
   * DERIVED FROM THE READ THIS PAGE ALREADY MAKES, so the marking costs no query.
   */
  const accrualTypes = types.map((lt) => ({
    id: lt.id,
    name: lt.name,
    swept: isEarnedAccrualType(lt),
  }));
  /**
   * ⚠️ THE TENANT'S OWN ANNUAL LEAVE NAME(S), NOT HARDCODED — and that is the load-bearing part. The
   * reporter's sentence reads "Earned Accrual applies only to Annual Leave (*Annual Leave)": the part in
   * brackets is whatever the tenant typed, and on the account that raised this it carries an asterisk no
   * default would. Character for character the filter and the A–Z order the engine's own `type_not_swept`
   * exit reads (core/leave.ts), and the same list the leave type editor's switch names — three places, one
   * sentence. `types` is already the non-archived read, the second half of that filter. EMPTY until a type
   * is switched on (or carries the seeded code), which is true and has a sentence of its own.
   */
  const sweptLeaveTypeNames = accrualTypes
    .filter((lt) => lt.swept)
    .map((lt) => lt.name)
    .sort((a, b) => a.localeCompare(b));
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
            sweptLeaveTypeNames={sweptLeaveTypeNames}
            leaveYears={earnedLeaveYears}
            defaultYear={currentYear}
          />
        </div>
      </Card>
    </div>
  );
}
