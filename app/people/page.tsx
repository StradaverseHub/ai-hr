import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { listCompanies, listDepartments, listEmployees } from '@/core/read';
import { listProfileChangeRequests } from '@/core/profile';
import { Avatar, Button, Card, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { decideProfileChangeAction, hireAction } from './actions';

const PCB_LABEL: Record<number, string> = {
  1: 'Single',
  2: 'Married · spouse not working',
  3: 'Married · spouse working',
};
/** Render a pay-affecting change bundle as human-readable "field → value" pairs. */
function describeProposed(p: unknown): string {
  const o = (p ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (o.bankName != null) parts.push(`Bank → ${o.bankName}`);
  if (o.bankAccountNo != null) parts.push(`Account → ${o.bankAccountNo}`);
  if (o.taxCategory != null) parts.push(`PCB → ${PCB_LABEL[Number(o.taxCategory)] ?? o.taxCategory}`);
  if (o.numChildren != null) parts.push(`Children → ${o.numChildren}`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const today = new Date().toISOString().slice(0, 10);
  const isAdmin = (session.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  const { error } = await searchParams;
  const [employees, companies, departments, profileChanges] = await Promise.all([
    listEmployees(session, scopeIds),
    listCompanies(session),
    listDepartments(session),
    isAdmin
      ? listProfileChangeRequests(session, { companyIds: scopeIds, status: 'pending' })
      : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="People"
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{employees.length} employees</span>
            {isAdmin && (
              <Link
                href="/people/import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                Import CSV
              </Link>
            )}
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {isAdmin && profileChanges.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">Profile change requests</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {profileChanges.length} pending
            </span>
          </div>
          <ul className="divide-y divide-border">
            {profileChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employee}</div>
                  <div className="text-xs text-muted-foreground">{describeProposed(r.proposed)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <Button type="submit" size="sm">
                      Approve
                    </Button>
                  </form>
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="rejected" />
                    <Button type="submit" size="sm" variant="outline">
                      Reject
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Approving applies the change to the employee&rsquo;s statutory profile (bank / PCB). You
            cannot approve your own request.
          </p>
        </Card>
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
              <input name="hiredOn" type="date" required defaultValue={today} className={inputCls} />
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
