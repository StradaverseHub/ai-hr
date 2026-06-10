import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import { entitlement } from '@/localization/my/leave';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { LeaveTypePanel, type EntitlementPolicy } from '@/components/leave-type-panel';
import {
  archiveLeaveTypeAction,
  createLeavePolicyAction,
  createLeaveTypeAction,
  deleteLeavePolicyAction,
  deleteLeaveTypeAction,
  openLeaveYearAction,
  updateLeavePolicyAction,
  updateLeaveTypeAction,
} from '../actions';

export default async function LeaveConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const { error } = await searchParams;
  const [types, policies] = await Promise.all([
    listLeaveTypes(s, { includeArchived: true }),
    listLeavePolicies(s),
  ]);

  // Statutory floor display (MY pack): sample the three service bands. 6 (not 5)
  // catches the top band on both boundary conventions (annual ≤5 vs sick <5).
  const floorBands = (code: string) => {
    const days = [...new Set([0, 2, 6].map((y) => entitlement(code, y)))];
    return days[0] === 0 ? null : days.join(' / ');
  };

  // Group each type's effective-dated policies, newest first, for inline editing.
  const polByType = new Map<string, EntitlementPolicy[]>();
  for (const p of policies) {
    const acc = p.accrual as { annualDays?: number; carryForwardMax?: number } | null;
    const ep: EntitlementPolicy = {
      id: p.id,
      annualDays: Number(acc?.annualDays ?? 0),
      carryForwardMax: Math.max(0, Number(acc?.carryForwardMax ?? 0)),
      validFrom: p.validFrom,
      validTo: p.validTo,
    };
    const arr = polByType.get(p.leaveTypeId);
    if (arr) arr.push(ep);
    else polByType.set(p.leaveTypeId, [ep]);
  }
  for (const arr of polByType.values()) arr.sort((a, b) => b.validFrom.localeCompare(a.validFrom));

  const nextYear = new Date().getUTCFullYear() + 1;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Leave configuration" description="Leave types and their entitlement policies" />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Leave types & entitlements" count={types.length} />
        <ul className="divide-y divide-border">
          {types.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No leave types.</li>
          )}
          {types.map((t) => (
            <LeaveTypePanel
              key={t.id}
              id={t.id}
              name={t.name}
              code={t.code}
              archived={!!t.archivedAt}
              inUse={t.inUse}
              isAnnual={t.code === 'ANNUAL'}
              floorLabel={floorBands(t.code)}
              floor0={entitlement(t.code, 0)}
              policies={polByType.get(t.id) ?? []}
              updateTypeAction={updateLeaveTypeAction}
              archiveTypeAction={archiveLeaveTypeAction}
              deleteTypeAction={deleteLeaveTypeAction}
              createPolicyAction={createLeavePolicyAction}
              updatePolicyAction={updateLeavePolicyAction}
              deletePolicyAction={deleteLeavePolicyAction}
            />
          ))}
        </ul>
        <form
          action={createLeaveTypeAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <Field label="Code">
            <input name="code" required placeholder="SICK" className={inputCls} />
          </Field>
          <Field label="Name">
            <input name="name" required placeholder="Sick Leave" className={inputCls} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="paid" defaultChecked className="size-4 rounded" />
            Paid
          </label>
          <button className={btnPrimary}>Add type</button>
        </form>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Statutory minimums come from the country pack (EA 1955; bands are &lt;2 / 2–5 / 5+ years
          of service) and are not configurable. Grants apply the <span className="font-medium">greater</span> of
          the floor and the company policy — a policy below the minimum is recorded but never applied.
          Entitlements are effective-dated: <span className="font-medium">add</span> one to change going
          forward, <span className="font-medium">edit</span> one to correct it. Annual leave pro-rates in
          the hire year; sick and hospitalization grant in full.
        </p>
      </Card>

      <Card>
        <SectionHeader title="Leave year" />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Opening a year posts each active employee&rsquo;s new entitlements at their{' '}
          <span className="font-medium text-foreground">current service band</span> (so 2y/5y upgrades
          apply), resolved as max(statutory floor, policy). Unused annual leave carries up to the
          policy&rsquo;s cap and the rest is forfeited (s.60E expects leave within the year); sick and
          hospitalization reset. Idempotent — already-opened employees are skipped; employees hired
          during the year are covered by their hire grant.
        </p>
        <form action={openLeaveYearAction} className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Year">
            <input
              name="year"
              type="number"
              min="2020"
              max="2100"
              required
              defaultValue={nextYear}
              className={`${inputCls} w-28`}
            />
          </Field>
          <button className={btnPrimary}>Open leave year</button>
        </form>
      </Card>
    </div>
  );
}
