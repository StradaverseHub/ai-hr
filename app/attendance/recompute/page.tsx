import { getTranslations } from 'next-intl/server';
import { requireAdmin, requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { auditEvents, listCompanies, listDepartments, listEmployees } from '@/core/read';
import { recomputeRunsFromEvents } from '@/core/attendance-recompute';
import { PageHeader } from '@/components/ui';
import { RecomputeClient } from './recompute-client';

/**
 * Attendance > Recompute (feedback 1c1b321a). HR administrators only — reached from a button beside
 * Import Punches on the Records page, deliberately NOT from the Records tab strip: that strip renders for
 * every role (components/attendance-tabs.tsx) and /attendance is a scopedSession screen, while this one is
 * requireAdmin. The approved mockup states the same thing in the reporter's words: "No new tab. The three
 * tabs stay exactly as they are."
 *
 * requireModule('attendance') is the courtesy redirect for a tenant that has not bought the module (the
 * ADR-0077 slice 4 pattern); requireAdmin is the control. The scope lists are read here, on the server,
 * so the client island is a pure form over data it cannot widen.
 */
export default async function AttendanceRecomputePage() {
  const t = await getTranslations('attendance.recompute');
  await requireModule('attendance');
  await requireAdmin();
  const { s, scopeIds } = await scopedSession();
  const [companies, departments, employees, runEvents] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { companyIds: scopeIds }),
    listEmployees(s, scopeIds),
    // The permanent run history. The ledger IS the record — each run event carries its own per-day
    // before/after array — so re-opening a past run reads this payload back rather than recomputing it.
    auditEvents(s, { aggregateType: 'attendance-recompute', limit: 20 }),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/attendance', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
        actions={
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {t('adminOnly')}
          </span>
        }
      />
      <RecomputeClient
        companies={companies
          .filter((c) => scopeIds.includes(c.id))
          .map((c) => ({ id: c.id, name: c.name }))}
        departments={departments.map((d) => ({ id: d.id, name: d.name, companyId: d.companyId, isGlobal: d.isGlobal }))}
        employees={employees.map((e) => ({
          employmentId: e.employmentId,
          name: e.name,
          employeeCode: e.employeeCode,
          companyId: e.companyId,
          departmentId: e.departmentId,
        }))}
        recentRuns={recomputeRunsFromEvents(runEvents)}
      />
    </div>
  );
}
