import { requireAdmin } from '@/lib/authz';
import { companyTree, listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { listCompanyStatutoryMY } from '@/localization/my/company-statutory';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { EditableRow } from '@/components/editable-row';
import {
  archiveDepartmentAction,
  createCompanyAction,
  createCostCenterAction,
  createDepartmentAction,
  createPositionAction,
  deleteDepartmentAction,
  setCompanyParentAction,
  setCompanyStatutoryAction,
  updateDepartmentAction,
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
  const s = await requireAdmin();
  const { error } = await searchParams;
  const [companies, departments, positions, costCenters, tree, statutory] = await Promise.all([
    listCompanies(s),
    listDepartments(s, { includeArchived: true }),
    listPositions(s),
    listCostCenters(s),
    companyTree(s),
    listCompanyStatutoryMY(s),
  ]);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const statBy = new Map(statutory.map((r) => [r.companyId, r]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Organization</h1>
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
        <Rows rows={companies.map((c) => ({ key: c.id, main: c.name }))} empty="No companies yet." />
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
        <Rows
          rows={positions.map((p) => ({ key: p.id, main: p.title, sub: p.jobFamily }))}
          empty="No positions yet."
        />
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
        <Rows
          rows={costCenters.map((c) => ({ key: c.id, main: c.code, sub: c.name }))}
          empty="No cost centers yet."
        />
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
