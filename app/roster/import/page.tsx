import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { rosterMonthView } from '@/core/roster';
import { PageHeader, Card } from '@/components/ui';
import { isMonthParam, monthOf, shiftCodeOf } from '@/lib/roster-month';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { RosterImport } from './roster-import';

/**
 * Upload Shift Roster (item 23390097). ADMINISTRATORS ONLY — `requireAdmin`, which is what the reporter
 * asked for and the reason Roster itself can still sit beside Attendance for supervisors.
 *
 * The screen follows app/attendance/import: pick the file, see a preview of what WOULD happen, then
 * commit. Nothing is written until the second button. The template handed out here is the same month
 * grid the roster screen exports, pre-filled with what is rostered now.
 *
 * REGISTRATION NOTE for whoever integrates this: `/roster/import` is a guarded page and must be added to
 * the requireAdmin screen that already carries `/attendance/import` (lib/permissions.ts, screenKey
 * `attendancePolicy`). It cannot ride the `roster` column — that column's guard is scopedSession, and
 * test/function-access.test.ts checks guard-derived access in both directions.
 */
export default async function RosterImportPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; month?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('roster.import');
  const tr = await getTranslations('roster');
  const sp = await searchParams;

  const allowed = await allowedCompanies(s);
  const scopeIds = await getScopeIds(allowed.map((c) => c.id));
  const inScope = allowed.filter((c) => scopeIds.length === 0 || scopeIds.includes(c.id));
  if (inScope.length === 0) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader back={{ href: '/roster', label: t('backLabel') }} title={t('title')} description={t('description')} />
        <Card className="p-4 text-sm text-muted-foreground">{tr('noCompanies')}</Card>
      </div>
    );
  }
  const company = inScope.find((c) => c.id === sp.companyId) ?? inScope[0];
  const month = isMonthParam(sp.month) ? sp.month : monthOf(todayInKualaLumpur());

  // The template is the month as it stands, pre-filled with the ROSTERED days only. Blank means "leave
  // this date exactly as it is", so a partly-filled month can be topped up without disturbing the rest.
  const view = await rosterMonthView(s, { companyId: company.id, month });
  const codeById = new Map(view.shifts.map((sh) => [sh.id, shiftCodeOf(sh)]));
  const templateHeader = [tr('colEmployeeNo'), tr('colEmployeeName'), tr('colDepartment'), tr('colOccupation'), ...view.dates];
  const templateRows = view.employees.map((e) => [
    e.code ?? '',
    e.name,
    e.department ?? '',
    e.occupation ?? '',
    ...view.dates.map((iso) => {
      const c = view.cells[`${e.employmentId}|${iso}`] ?? null;
      return c == null ? '' : c.kind === 'rest' ? 'RD' : (codeById.get(c.shiftId) ?? '');
    }),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader back={{ href: '/roster', label: t('backLabel') }} title={t('title')} description={t('description')} />
      <RosterImport
        companies={inScope.map((c) => ({ id: c.id, name: c.name }))}
        companyId={company.id}
        month={month}
        shiftCodes={view.shifts.map((sh) => ({ code: shiftCodeOf(sh), name: sh.name }))}
        template={{
          header: templateHeader,
          rows: templateRows,
          codes: view.shifts.map((sh) => shiftCodeOf(sh)),
        }}
      />
    </div>
  );
}
