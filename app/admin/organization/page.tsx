import { scopedAdmin } from '@/lib/scope';
import { companyTree, listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { listCompanyStatutoryMY } from '@/localization/my/company-statutory';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { EditableRow } from '@/components/editable-row';
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

type Company = { id: string; name: string };

function CompanySelect({ companies }: { companies: Company[] }) {
  return (
    <Field label="Company">
      <select name="companyId" required className={inputCls}>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Rows({ rows, empty }: { rows: { key: string; main: string; sub?: string | null }[]; empty: string }) {
  if (rows.length === 0) return <div className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between px-4 py-2.5 text-sm">
          <span className="text-foreground">{r.main}</span>
          {r.sub && <span className="text-xs text-muted-foreground">{r.sub}</span>}
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
  // Companies + tree + statutory stay unscoped — that's the group-structure management surface and
  // the tree needs every node. The per-company lists below follow the active company context.
  const [companies, departments, positions, costCenters, tree, statutory] = await Promise.all([
    listCompanies(s, { includeArchived: true }),
    listDepartments(s, { includeArchived: true, companyIds: scopeIds }),
    listPositions(s, { includeArchived: true, companyIds: scopeIds }),
    listCostCenters(s, { includeArchived: true, companyIds: scopeIds }),
    companyTree(s),
    listCompanyStatutoryMY(s),
  ]);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const statBy = new Map(statutory.map((r) => [r.companyId, r]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Organization" description="Companies, departments, positions and cost centres" />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Company structure" count={companies.length} />
        <div className="px-4 py-3">
          {tree.length > 0 ? (
            <CompanyTree nodes={tree} />
          ) : (
            <p className="text-sm text-muted-foreground">No companies yet.</p>
          )}
        </div>
        <form
          action={setCompanyParentAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-3"
        >
          <Field label="Company">
            <select name="companyId" required className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Parent">
            <select name="parentCompanyId" className={inputCls} defaultValue="">
              <option value="">— none (group root) —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button className={btnPrimary}>Set parent</button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Statutory identity (per company)" count={statutory.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">EPF no.</th>
                <th className="px-4 py-2 font-medium">SOCSO</th>
                <th className="px-4 py-2 font-medium">LHDN E</th>
                <th className="px-4 py-2 font-medium">MyInvois TIN</th>
                <th className="px-4 py-2 font-medium">SSM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {companies.map((c) => {
                const st = statBy.get(c.id);
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-2 font-medium">{c.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{st?.epfEmployerNo ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{st?.socsoEmployerCode ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{st?.lhdnEmployerNo ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{st?.myinvoisTin ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{st?.ssmRegistrationNo ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <form
          action={setCompanyStatutoryAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-3"
        >
          {/* MY-first: all seeded companies are MY. A multi-country form would derive this per company. */}
          <input type="hidden" name="country" value="MY" />
          <Field label="Company">
            <select name="companyId" required className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="EPF employer no.">
            <input name="epfEmployerNo" className={inputCls} />
          </Field>
          <Field label="SOCSO employer code">
            <input name="socsoEmployerCode" className={inputCls} />
          </Field>
          <Field label="LHDN E-number">
            <input name="lhdnEmployerNo" className={inputCls} />
          </Field>
          <Field label="MyInvois TIN">
            <input name="myinvoisTin" className={inputCls} />
          </Field>
          <Field label="SSM registration no.">
            <input name="ssmRegistrationNo" className={inputCls} />
          </Field>
          <div className="sm:col-span-3">
            <button className={btnPrimary}>Save statutory identity</button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Companies" count={companies.length} />
        <ul className="divide-y divide-border">
          {companies.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No companies yet.</li>
          )}
          {companies.map((c) => (
            <EditableRow
              key={c.id}
              id={c.id}
              display={c.name}
              sub={c.registrationNo}
              fields={[
                { name: 'legalName', label: 'Legal name', value: c.name },
                { name: 'registrationNo', label: 'Reg. no.', value: c.registrationNo ?? '' },
                { name: 'country', label: 'Country', value: c.country },
                { name: 'currency', label: 'Currency', value: c.currency },
              ]}
              inUse={c.inUse}
              archived={!!c.archivedAt}
              updateAction={updateCompanyAction}
              archiveAction={archiveCompanyAction}
              deleteAction={deleteCompanyAction}
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

      <Card>
        <SectionHeader title="Departments" count={departments.length} />
        <ul className="divide-y divide-border">
          {departments.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No departments yet.</li>
          )}
          {departments.map((d) => (
            <EditableRow
              key={d.id}
              id={d.id}
              display={d.name}
              sub={companyName.get(d.companyId)}
              fields={[{ name: 'name', label: 'Name', value: d.name }]}
              inUse={d.inUse}
              archived={!!d.archivedAt}
              updateAction={updateDepartmentAction}
              archiveAction={archiveDepartmentAction}
              deleteAction={deleteDepartmentAction}
            />
          ))}
        </ul>
        <form
          action={createDepartmentAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-3"
        >
          <CompanySelect companies={companies} />
          <Field label="Name">
            <input name="name" required placeholder="e.g. Marketing" className={`${inputCls} sm:col-span-1`} />
          </Field>
          <div className="flex items-end">
            <button className={btnPrimary}>Add department</button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Positions" count={positions.length} />
        <ul className="divide-y divide-border">
          {positions.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No positions yet.</li>
          )}
          {positions.map((p) => (
            <EditableRow
              key={p.id}
              id={p.id}
              display={p.title}
              sub={p.jobFamily}
              fields={[
                { name: 'title', label: 'Title', value: p.title },
                { name: 'jobFamily', label: 'Job family', value: p.jobFamily ?? '' },
              ]}
              inUse={p.inUse}
              archived={!!p.archivedAt}
              updateAction={updatePositionAction}
              archiveAction={archivePositionAction}
              deleteAction={deletePositionAction}
            />
          ))}
        </ul>
        <form
          action={createPositionAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-3"
        >
          <CompanySelect companies={companies} />
          <Field label="Title">
            <input name="title" required placeholder="e.g. Senior Engineer" className={inputCls} />
          </Field>
          <div className="flex items-end">
            <button className={btnPrimary}>Add position</button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Cost centers" count={costCenters.length} />
        <ul className="divide-y divide-border">
          {costCenters.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No cost centers yet.</li>
          )}
          {costCenters.map((c) => (
            <EditableRow
              key={c.id}
              id={c.id}
              display={c.code}
              sub={c.name}
              fields={[
                { name: 'code', label: 'Code', value: c.code },
                { name: 'name', label: 'Name', value: c.name },
              ]}
              inUse={c.inUse}
              archived={!!c.archivedAt}
              updateAction={updateCostCenterAction}
              archiveAction={archiveCostCenterAction}
              deleteAction={deleteCostCenterAction}
            />
          ))}
        </ul>
        <form
          action={createCostCenterAction}
          className="grid grid-cols-1 gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <CompanySelect companies={companies} />
          <Field label="Code">
            <input name="code" required placeholder="HQ" className={inputCls} />
          </Field>
          <Field label="Name">
            <input name="name" required placeholder="Headquarters" className={inputCls} />
          </Field>
          <div className="flex items-end">
            <button className={btnPrimary}>Add cost center</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
