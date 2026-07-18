import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { isGroupAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import {
  listBusinessUnitsForLabels,
  listCostCentersForLabels,
  listDepartmentsForLabels,
  listPositionsForLabels,
} from '@/core/admin';
import { listLabelAssignments } from '@/core/system-labels';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { SystemLabelsGrid, type GridKind, type GridRecord } from '@/components/system-labels-grid';
import { SystemLabelsTabs } from '@/components/system-labels-tabs';
import {
  assignLabelCompaniesAction,
  copyLabelsToCompaniesAction,
  saveLabelsGridAction,
  setCompanySharedLabelsAction,
  setLabelGlobalAction,
  unassignLabelCompaniesAction,
} from '../actions';

export default async function SystemLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.systemLabels');

  const [companies, departments, positions, costCenters, businessUnits, deptAssign, posAssign, ccAssign, buAssign] =
    await Promise.all([
      listCompanies(s, { includeArchived: true }),
      listDepartmentsForLabels(s),
      listPositionsForLabels(s),
      listCostCentersForLabels(s),
      listBusinessUnitsForLabels(s),
      listLabelAssignments(s, 'department'),
      listLabelAssignments(s, 'position'),
      listLabelAssignments(s, 'cost_center'),
      listLabelAssignments(s, 'business_unit'),
    ]);

  const scopedCompanies = scopeIds.length ? companies.filter((c) => scopeIds.includes(c.id)) : companies;
  const scopedIdSet = new Set(scopedCompanies.map((c) => c.id));

  // Assignment map: labelId → [companyId, …]. The origin company is always included so the Scope cell can
  // pre-check it (the origin is implicitly assigned; the backfill in 0157 wrote a self-assignment too).
  const assignMap = (rows: { labelId: string; companyId: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const list = m.get(r.labelId) ?? [];
      list.push(r.companyId);
      m.set(r.labelId, list);
    }
    return m;
  };
  const deptMap = assignMap(deptAssign);
  const posMap = assignMap(posAssign);
  const ccMap = assignMap(ccAssign);
  const buMap = assignMap(buAssign);

  const norm = (
    r: {
      id: string;
      companyId: string;
      code?: string;
      name?: string;
      title?: string;
      jobFamily?: string | null;
      label?: string | null;
      businessUnitId?: string | null;
      headEmploymentId?: string | null;
      description?: string | null;
      isGlobal: boolean;
      archivedAt: Date | null;
      inUse: boolean;
      createdAt: Date | null;
      lastUpdatedAt: string | null;
      lastUpdatedBy: string | null;
    },
    map: Map<string, string[]>,
  ): GridRecord => ({
    id: r.id,
    companyId: r.companyId,
    code: r.code ?? '',
    name: r.name ?? '',
    title: r.title ?? '',
    jobFamily: r.jobFamily ?? '',
    label: r.label ?? '',
    businessUnitId: r.businessUnitId ?? null,
    headEmploymentId: r.headEmploymentId ?? null,
    description: r.description ?? '',
    isGlobal: r.isGlobal,
    archived: !!r.archivedAt,
    inUse: r.inUse,
    assignedCompanyIds: Array.from(new Set([r.companyId, ...(map.get(r.id) ?? [])])),
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    lastUpdatedAt: r.lastUpdatedAt,
    lastUpdatedBy: r.lastUpdatedBy,
  });

  const inScope = <T extends { companyId: string }>(rows: T[]) => rows.filter((r) => scopedIdSet.has(r.companyId));

  const data: Record<GridKind, GridRecord[]> = {
    department: inScope(departments).map((r) => norm(r, deptMap)),
    position: inScope(positions).map((r) => norm(r, posMap)),
    cost_center: inScope(costCenters).map((r) => norm(r, ccMap)),
    business_unit: inScope(businessUnits).map((r) => norm(r, buMap)),
  };

  // 71bacb95: the Business Unit select was removed from the Department config grid (the BU link is now
  // maintained via the employee's organisation assignment), so the per-company BU option list it fed is no
  // longer built or passed here. department.businessUnitId + its hire-form / payroll cascade are unchanged.
  // 797e3523: the Head column was removed from the System Labels surface, so employee/head options are no
  // longer loaded here. Dept/BU heads (approval routing) are maintained via the organisation admin surface.

  const gridCompanies = scopedCompanies.map((c) => ({ id: c.id, name: c.name, sharedSystemLabels: c.sharedSystemLabels }));

  const actions = {
    save: saveLabelsGridAction,
    setGlobal: setLabelGlobalAction,
    assign: assignLabelCompaniesAction,
    unassign: unassignLabelCompaniesAction,
    copyToCompanies: copyLabelsToCompaniesAction,
    setCompanyShared: setCompanySharedLabelsAction,
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <SystemLabelsTabs active="organisation" />
      <ErrorBanner message={error} />

      {gridCompanies.length === 0 ? (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompaniesInScope')}</p>
        </Card>
      ) : (
        <SystemLabelsGrid data={data} companies={gridCompanies} isGroupAdmin={isGroupAdmin(s)} actions={actions} />
      )}
    </div>
  );
}
