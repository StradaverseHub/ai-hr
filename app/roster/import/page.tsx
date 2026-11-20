import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { allowedCompanies } from '@/core/read';
import { getScopeIds } from '@/lib/scope';
import { PageHeader, Card } from '@/components/ui';
import { isMonthParam, monthOf } from '@/lib/roster-month';
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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader back={{ href: '/roster', label: t('backLabel') }} title={t('title')} description={t('description')} />
      <RosterImport
        companies={inScope.map((c) => ({ id: c.id, name: c.name }))}
        companyId={company.id}
        month={month}
      />
    </div>
  );
}
