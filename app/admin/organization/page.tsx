import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { listCompanyStatutoryMY } from '@/localization/my/company-statutory';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { CompanyPanel, type ChildRow } from '@/components/company-panel';
import {
  archiveCompanyAction,
  archiveCostCenterAction,
  archiveDepartmentAction,
  archivePositionAction,
  createCompanyAction,
  createCostCenterAction,
  createDepartmentAction,
  createPositionAction,
  deleteCompanyAction,
  deleteCostCenterAction,
  deleteDepartmentAction,
  deletePositionAction,
  setCompanyParentAction,
  setCompanyStatutoryAction,
  updateCompanyAction,
  updateCostCenterAction,
  updateDepartmentAction,
  updatePositionAction,
} from '../actions';

type TreeNode = { id: string; name: string; country: string; parentId: string | null };

function CompanyTree({
  nodes,
  parentId = null,
  depth = 0,
}: {
  nodes: TreeNode[];
  parentId?: string | null;
  depth?: number;
}) {
  const children = nodes.filter((n) => n.parentId === parentId);
  if (children.length === 0) return null;
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5 border-l border-border pl-3'}>
      {children.map((n) => (
        <li key={n.id}>
          <span className="text-sm font-medium text-foreground">{n.name}</span>{' '}
          <span className="text-xs text-muted-foreground">{n.country}</span>
          <CompanyTree nodes={nodes} parentId={n.id} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { error } = await searchParams;
  // The tree stays unscoped (it needs every node to draw the group); the company panels follow
  // the active company context, since they are now the per-company management surface.
  const [companies, departments, positions, costCenters, tree, statutory] = await Promise.all([
    listCompanies(s, { includeArchived: true }),
    listDepartments(s, { includeArchived: true }),
    listPositions(s, { includeArchived: true }),
    listCostCenters(s, { includeArchived: true }),
    companyTree(s),
    listCompanyStatutoryMY(s),
  ]);
  const statBy = new Map(statutory.map((r) => [r.companyId, r]));
  const parentBy = new Map(tree.map((n) => [n.id, n.parentId]));
  const scoped = scopeIds.length ? companies.filter((c) => scopeIds.includes(c.id)) : companies;

  const deptRows = (companyId: string): ChildRow[] =>
    departments
      .filter((d) => d.companyId === companyId)
      .map((d) => ({
        id: d.id,
        display: d.name,
        fields: [{ name: 'name', label: 'Name', value: d.name }],
        inUse: d.inUse,
        archived: !!d.archivedAt,
      }));
  const posRows = (companyId: string): ChildRow[] =>
    positions
      .filter((p) => p.companyId === companyId)
      .map((p) => ({
        id: p.id,
        display: p.title,
        sub: p.jobFamily,
        fields: [
          { name: 'title', label: 'Title', value: p.title },
          { name: 'jobFamily', label: 'Job family', value: p.jobFamily ?? '' },
        ],
        inUse: p.inUse,
        archived: !!p.archivedAt,
      }));
  const ccRows = (companyId: string): ChildRow[] =>
    costCenters
      .filter((c) => c.companyId === companyId)
      .map((c) => ({
        id: c.id,
        display: c.code,
        sub: c.name,
        fields: [
          { name: 'code', label: 'Code', value: c.code },
          { name: 'name', label: 'Name', value: c.name },
        ],
        inUse: c.inUse,
        archived: !!c.archivedAt,
      }));

  const actions = {
    updateCompany: updateCompanyAction,
    archiveCompany: archiveCompanyAction,
    deleteCompany: deleteCompanyAction,
    setParent: setCompanyParentAction,
    setStatutory: setCompanyStatutoryAction,
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
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Organization"
        description="Each company manages its details, statutory identity, departments, positions and cost centres"
      />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Group structure" count={companies.length} />
        <div className="px-4 py-3">
          {tree.length > 0 ? (
            <CompanyTree nodes={tree} />
          ) : (
            <p className="text-sm text-muted-foreground">No companies yet.</p>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Companies" count={scoped.length} />
        <ul className="divide-y divide-border">
          {scoped.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No companies in scope.</li>
          )}
          {scoped.map((c) => (
            <CompanyPanel
              key={c.id}
              company={{
                id: c.id,
                name: c.name,
                country: c.country,
                currency: c.currency,
                registrationNo: c.registrationNo,
                archivedAt: c.archivedAt,
                inUse: c.inUse,
                parentId: parentBy.get(c.id) ?? null,
              }}
              companies={companies}
              statutory={statBy.get(c.id) ?? null}
              departments={deptRows(c.id)}
              positions={posRows(c.id)}
              costCenters={ccRows(c.id)}
              actions={actions}
            />
          ))}
        </ul>
        <form
          action={createCompanyAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <input name="legalName" required placeholder="Legal name" className={`${inputCls} sm:col-span-2`} />
          <input name="country" defaultValue="MY" placeholder="Country" className={inputCls} />
          <input name="currency" defaultValue="MYR" placeholder="Currency" className={inputCls} />
          <div className="sm:col-span-4">
            <button className={btnPrimary}>Add company</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
