import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies, listEmployees } from '@/core/read';
import {
  listBusinessUnitsForLabels,
  listCostCentersForLabels,
  listDepartmentsForLabels,
  listPositionsForLabels,
} from '@/core/admin';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { SystemLabelsPanel, type LabelRow } from '@/components/system-labels-panel';
import {
  archiveBusinessUnitAction,
  archiveCostCenterAction,
  archiveDepartmentAction,
  archivePositionAction,
  createBusinessUnitAction,
  createCostCenterAction,
  createDepartmentAction,
  createPositionAction,
  deleteCostCenterAction,
  deleteDepartmentAction,
  deletePositionAction,
  updateBusinessUnitAction,
  updateCostCenterAction,
  updateDepartmentAction,
  updatePositionAction,
} from '../actions';

export default async function SystemLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.systemLabels');
  const to = await getTranslations('admin.organization');

  const [companies, departments, positions, costCenters, businessUnits, employees] = await Promise.all([
    listCompanies(s, { includeArchived: true }),
    listDepartmentsForLabels(s),
    listPositionsForLabels(s),
    listCostCentersForLabels(s),
    listBusinessUnitsForLabels(s),
    listEmployees(s),
  ]);

  const scoped = scopeIds.length ? companies.filter((c) => scopeIds.includes(c.id)) : companies;

  // Business Unit options for the Department edit-row + add-form dropdowns: this company's ACTIVE BUs + None.
  const buOptions = (companyId: string) => [
    { value: '', label: to('businessUnitNone') },
    ...businessUnits
      .filter((bu) => bu.companyId === companyId && !bu.archivedAt)
      .map((bu) => ({ value: bu.id, label: `${bu.code} — ${bu.name}` })),
  ];

  // 6fadb036: approver-head options — this company's employees + a "None" clear option. Used to set the
  // department / business-unit head that department_head / business_unit_head approval steps route to.
  const headOptions = (companyId: string) => [
    { value: '', label: to('headNone') },
    ...employees
      .filter((e) => e.companyId === companyId)
      .map((e) => ({ value: e.employmentId, label: e.employeeCode ? `${e.name} (${e.employeeCode})` : e.name })),
  ];

  const deptRows = (companyId: string): LabelRow[] =>
    departments
      .filter((d) => d.companyId === companyId)
      .map((d) => ({
        id: d.id,
        display: d.name,
        sub: d.description,
        fields: [
          { name: 'name', label: to('fieldName'), value: d.name },
          { name: 'businessUnitId', label: to('fieldBusinessUnit'), value: d.businessUnitId ?? '', options: buOptions(companyId) },
          { name: 'headEmploymentId', label: to('fieldHead'), value: d.headEmploymentId ?? '', options: headOptions(companyId) },
          { name: 'description', label: t('fieldDescription'), value: d.description ?? '', wide: true },
        ],
        inUse: d.inUse,
        archived: !!d.archivedAt,
      }));
  const posRows = (companyId: string): LabelRow[] =>
    positions
      .filter((p) => p.companyId === companyId)
      .map((p) => ({
        id: p.id,
        display: p.title,
        sub: p.description ?? p.jobFamily,
        fields: [
          { name: 'title', label: to('fieldTitle'), value: p.title },
          { name: 'jobFamily', label: to('fieldJobFamily'), value: p.jobFamily ?? '' },
          { name: 'description', label: t('fieldDescription'), value: p.description ?? '', wide: true },
        ],
        inUse: p.inUse,
        archived: !!p.archivedAt,
      }));
  const ccRows = (companyId: string): LabelRow[] =>
    costCenters
      .filter((c) => c.companyId === companyId)
      .map((c) => ({
        id: c.id,
        display: c.code,
        sub: c.description ?? c.name,
        fields: [
          { name: 'code', label: to('fieldCode'), value: c.code },
          { name: 'name', label: to('fieldName'), value: c.name },
          { name: 'description', label: t('fieldDescription'), value: c.description ?? '', wide: true },
        ],
        inUse: c.inUse,
        archived: !!c.archivedAt,
      }));
  const buRows = (companyId: string): LabelRow[] =>
    businessUnits
      .filter((bu) => bu.companyId === companyId)
      .map((bu) => ({
        id: bu.id,
        display: bu.code,
        sub: bu.description ?? bu.name,
        fields: [
          { name: 'code', label: to('fieldCode'), value: bu.code },
          { name: 'name', label: to('fieldName'), value: bu.name },
          { name: 'headEmploymentId', label: to('fieldHead'), value: bu.headEmploymentId ?? '', options: headOptions(companyId) },
          { name: 'description', label: t('fieldDescription'), value: bu.description ?? '', wide: true },
        ],
        inUse: bu.inUse,
        archived: !!bu.archivedAt,
      }));

  const actions = {
    createDepartment: createDepartmentAction,
    updateDepartment: updateDepartmentAction,
    archiveDepartment: archiveDepartmentAction,
    deleteDepartment: deleteDepartmentAction,
    createPosition: createPositionAction,
    updatePosition: updatePositionAction,
    archivePosition: archivePositionAction,
    deletePosition: deletePositionAction,
    createCostCenter: createCostCenterAction,
    updateCostCenter: updateCostCenterAction,
    archiveCostCenter: archiveCostCenterAction,
    deleteCostCenter: deleteCostCenterAction,
    createBusinessUnit: createBusinessUnitAction,
    updateBusinessUnit: updateBusinessUnitAction,
    archiveBusinessUnit: archiveBusinessUnitAction,
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      <Card data-tour="system-labels-companies">
        <SectionHeader title={t('companies')} count={scoped.length} />
        <ul className="divide-y divide-border">
          {scoped.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noCompaniesInScope')}</li>
          )}
          {scoped.map((c) => (
            <SystemLabelsPanel
              key={c.id}
              company={{ id: c.id, name: c.name, country: c.country, archivedAt: c.archivedAt }}
              departments={deptRows(c.id)}
              positions={posRows(c.id)}
              costCenters={ccRows(c.id)}
              businessUnits={buRows(c.id)}
              buOptions={buOptions(c.id)}
              actions={actions}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}
