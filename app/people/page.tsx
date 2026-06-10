import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { Avatar, Button, Card, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { hireAction } from './actions';

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const { error } = await searchParams;
  const [employees, companies, departments] = await Promise.all([
    listEmployees(session, scopeIds),
    listCompanies(session),
    listDepartments(session),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="People"
        actions={<span className="text-sm text-muted-foreground">{employees.length} employees</span>}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Hired</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={e.name} />
                    <div className="min-w-0">
                      <Link
                        href={`/people/${e.employmentId}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {e.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{e.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{e.company}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.terminatedOn ? 'terminated' : e.status} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  No employees yet — hire someone below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card>
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
            + Hire an employee
          </summary>
          <form
            action={hireAction}
            className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2"
          >
            <Field label="Full name">
              <input name="fullName" required className={inputCls} placeholder="Aisyah Rahman" />
            </Field>
            <Field label="Email">
              <input name="primaryEmail" type="email" required className={inputCls} placeholder="aisyah@demo.test" />
            </Field>
            <Field label="Company">
              <select name="companyId" required className={inputCls}>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Department">
              <select name="departmentId" required className={inputCls}>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Employment type">
              <select name="employmentType" defaultValue="full_time" className={inputCls}>
                <option value="full_time">Full-time</option>
                <option value="part_time">Part-time</option>
                <option value="contract">Contract</option>
                <option value="intern">Intern</option>
              </select>
            </Field>
            <Field label="Hire date">
              <input name="hiredOn" type="date" required defaultValue="2026-06-05" className={inputCls} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Hire</Button>
            </div>
          </form>
        </details>
      </Card>
    </div>
  );
}
