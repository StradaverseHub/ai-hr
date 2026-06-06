import { requireAdmin } from '@/lib/authz';
import { listCompanies, listDepartments } from '@/core/read';
import { listCostCenters, listPositions } from '@/core/admin';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import {
  createCompanyAction,
  createCostCenterAction,
  createDepartmentAction,
  createPositionAction,
} from '../actions';

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
  const [companies, departments, positions, costCenters] = await Promise.all([
    listCompanies(s),
    listDepartments(s),
    listPositions(s),
    listCostCenters(s),
  ]);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Organization</h1>
      <ErrorBanner message={error} />

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
        <Rows
          rows={departments.map((d) => ({ key: d.id, main: d.name, sub: companyName.get(d.companyId) }))}
          empty="No departments yet."
        />
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
