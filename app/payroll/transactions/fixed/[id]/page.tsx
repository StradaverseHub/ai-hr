import { notFound, redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';

/**
 * cc8bd87f — the old address of ONE recurring fixed item, kept so links and bookmarks still work.
 *
 * f3ae3245 gave View / Edit this separate page; cc8bd87f moved it into a pop-up over the employee's list
 * (../edit-fixed-dialog.tsx). Anything that still links here — a bookmark, the Personnel Payroll tab's
 * pay-items table — now lands on the list with `?edit=<id>`, which opens the pop-up on that item. The list
 * page decides whether `edit` names a live row of that employee and ignores it otherwise, so this page does
 * not read the row.
 *
 * The guard is unchanged: `scopedAdmin()` first (a non-admin gets the same clean redirect as before), then
 * the employment must be in the admin's company scope — RLS isolates tenants, not company scope — or the
 * answer is a 404, exactly as the old page gave. The route keeps its entry in lib/permissions.ts.
 */
export default async function FixedTransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ employmentId?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  const { employmentId } = await searchParams;

  const employees = await listEmployees(s, scopeIds);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  redirect(
    `/payroll/transactions/fixed?employmentId=${encodeURIComponent(emp.employmentId)}&edit=${encodeURIComponent(id)}`,
  );
}
