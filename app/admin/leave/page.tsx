import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes } from '@/core/read';
import { listLeavePolicies } from '@/core/admin';
import { entitlement } from '@/localization/my/leave';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { EditableRow } from '@/components/editable-row';
import {
  archiveLeaveTypeAction,
  createLeavePolicyAction,
  createLeaveTypeAction,
  deleteLeaveTypeAction,
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
  // Most generous active policy per type (overlaps resolve to max, same as the grant logic).
  const policyByType = new Map<string, { days: number; from: string }>();
  for (const p of policies) {
    if (p.validTo) continue;
    const d = Number((p.accrual as { annualDays?: number })?.annualDays ?? 0);
    const prev = policyByType.get(p.leaveTypeId);
    if (!prev || d > prev.days) policyByType.set(p.leaveTypeId, { days: d, from: p.validFrom });
  }
  const activeTypes = types.filter((t) => !t.archivedAt);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Leave configuration" description="Leave types and entitlement policies" />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title="Leave types" count={types.length} />
        <ul className="divide-y divide-border">
          {types.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No leave types.</li>
          )}
          {types.map((t) => (
            <EditableRow
              key={t.id}
              id={t.id}
              display={t.name}
              sub={t.code}
              fields={[{ name: 'name', label: 'Name', value: t.name }]}
              inUse={t.inUse}
              archived={!!t.archivedAt}
              updateAction={updateLeaveTypeAction}
              archiveAction={archiveLeaveTypeAction}
              deleteAction={deleteLeaveTypeAction}
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
            <input name="name" required placeholder="Sick Leave" className={`${inputCls} sm:col-span-1`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="paid" defaultChecked className="size-4 rounded" />
            Paid
          </label>
          <button className={btnPrimary}>Add type</button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title="Entitlement policies" count={policies.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Leave type</th>
                <th className="px-4 py-2 text-right font-medium">Statutory minimum (MY)</th>
                <th className="px-4 py-2 text-right font-medium">Company policy</th>
                <th className="px-4 py-2 text-right font-medium">Effective at hire</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeTypes.map((t) => {
                const floor = floorBands(t.code);
                const floor0 = entitlement(t.code, 0);
                const pol = policyByType.get(t.id);
                const effective = Math.max(floor0, pol?.days ?? 0);
                const belowFloor = pol != null && pol.days < floor0;
                return (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 font-medium">{t.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {floor ? `${floor} days` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {pol ? (
                        <span title={`Effective from ${pol.from}`}>{pol.days} days/yr</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {effective > 0 || pol ? (
                        <span className="font-semibold tabular-nums">{effective || pol?.days} days</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {belowFloor && (
                        <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                          below minimum — floor applies
                        </span>
                      )}
                      {pol && !belowFloor && pol.days > floor0 && (
                        <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                          policy
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Statutory minimums come from the country pack (EA 1955; bands are &lt;2 / 2–5 / 5+ years
          of service) and are not configurable. Grants on hire apply the <span className="font-medium">greater</span> of
          the floor and the company policy — a policy below the minimum is recorded but never applied.
          Annual leave pro-rates in the hire year; sick and hospitalization grant in full.
        </p>
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
