import { getSession } from '@/lib/session';
import { listLeaveTypes } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { createLeavePolicyAction, createLeaveTypeAction } from '../actions';

export default async function LeaveConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await getSession();
  const { error } = await searchParams;
  const [types, policies] = await Promise.all([listLeaveTypes(s), listLeavePolicies(s)]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Leave configuration</h1>
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Leave types" count={types.length} />
        <ul className="divide-y divide-border">
          {types.map((t) => (
            <li key={t.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-foreground">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.code}</span>
            </li>
          ))}
          {types.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No leave types.</li>}
        </ul>
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <Field label="Code">
            <input name="code" required placeholder="SICK" className={inputCls} />
          </Field>
          <Field label="Name">
            <input name="name" required placeholder="Sick Leave" className={`${inputCls} sm:col-span-1`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="paid" defaultChecked className="size-4 rounded" />
            Paid
          </label>
          <button className={btnPrimary}>Add type</button>
        </form>
      </Card>

      <Card>
        <SectionHeader title="Policies" count={policies.length} />
        <ul className="divide-y divide-border">
          {policies.map((p) => {
            const accrual = p.accrual as { annualDays?: number } | null;
            return (
              <li key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span className="text-foreground">{p.leaveType}</span>
                <span className="text-xs text-muted-foreground">
                  {accrual?.annualDays ?? '—'} days/yr · from {p.validFrom}
                </span>
              </li>
            );
          })}
          {policies.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No policies.</li>}
        </ul>
        <form
          action={createLeavePolicyAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <Field label="Leave type">
            <select name="leaveTypeId" required className={inputCls}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Days / year">
            <input name="annualDays" type="number" min="0" step="0.5" required defaultValue="14" className={inputCls} />
          </Field>
          <Field label="Effective from">
            <input name="validFrom" type="date" required defaultValue="2026-01-01" className={inputCls} />
          </Field>
          <button className={btnPrimary}>Add policy</button>
        </form>
      </Card>
    </div>
  );
}
