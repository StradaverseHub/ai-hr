import Link from 'next/link';
import { getSession } from '@/lib/session';
import { listCompanies, listDepartments, listEmployees, listLeaveTypes } from '@/core/read';
import { Card, Field, StatusBadge, btnPrimary, inputCls } from '@/components/ui';
import { hireAction } from './actions';

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getSession();
  const { error } = await searchParams;
  const [employees, companies, departments, leaveTypes] = await Promise.all([
    listEmployees(session),
    listCompanies(session),
    listDepartments(session),
    listLeaveTypes(session),
  ]);
  const annual = leaveTypes.find((t) => t.code === 'ANNUAL');

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">People</h1>
        <span className="text-sm text-zinc-500">{employees.length} employees</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Hired</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                <td className="px-4 py-3">
                  <Link
                    href={`/people/${e.employmentId}`}
                    className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                  >
                    {e.name}
                  </Link>
                  <div className="text-xs text-zinc-500">{e.email}</div>
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">{e.company}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.terminatedOn ? 'terminated' : e.status} />
                </td>
                <td className="px-4 py-3 text-zinc-500">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
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
            className="grid grid-cols-1 gap-4 border-t border-zinc-200 p-4 sm:grid-cols-2 dark:border-zinc-800"
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
            {annual && <input type="hidden" name="annualLeaveTypeId" value={annual.id} />}
            <div className="sm:col-span-2">
              <button type="submit" className={btnPrimary}>
                Hire
              </button>
            </div>
          </form>
        </details>
      </Card>
    </div>
  );
}
