import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { SessionContext } from '@/db/client';
import type { AttendanceRuleView } from '@/core/attendance-rule';
import { listShiftsForTenant } from '@/core/roster';
import { Badge, Card, btnPrimary } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { copyAttendanceRuleAction, deleteAttendanceRuleAction, setAttendanceRuleStatusAction } from './rule-actions';
import { RuleForm } from './rules/rule-form';
import { ruleShiftChoices } from './rules/shift-choices';
import { NEW_GROUP, SCHEDULE_GROUPS_ANCHOR, groupEditorHref } from './schedule-panel';

/**
 * 6d091cc0 (r301) — THE SCHEDULE GROUP CARD on Attendance › Schedule › General, and its in-page editor.
 *
 * ── MOVED, NOT REBUILT ─────────────────────────────────────────────────────────────────────────────────────
 * This is the list /admin/attendance-policy rendered until this round (88e94371, ad52212d round 2), moved onto
 * the Schedule screen the reporter asked to be the one setup page. Same rows (listAttendanceRules — Standard
 * first, then by name), same columns, same four actions posting to the SAME writers in ./rule-actions.ts. The
 * old route is a redirect to this card now (#schedule-groups).
 *
 * ONE THING IS NEW, AND IT IS THE ONLY BEHAVIOURAL CHANGE ON THE LIST: Delete asks first. It used to fire on a
 * single click, and deleting a group is permanent. The refusals are unchanged and still the SERVICE's: the
 * Standard group has no Delete button and `deleteAttendanceRule` refuses it anyway; a group a shift still uses
 * is refused with the shifts named (AttendanceRuleInUseError). The dialog is the shared ConfirmSubmit, so the
 * button stays inside the same <form> and posts the same one field.
 *
 * ── THE EDITOR IS rules/rule-form.tsx, UNCHANGED ──────────────────────────────────────────────────────────
 * Add and Edit open the existing Schedule Group form as a panel on this page (`?editGroup=`), not a copy of it:
 * the overtime-band editor, its continuous-ladder validation, the deduction switch whose start date the service
 * stamps, and the "Shifts allowed" marker contract all stay in one file with one writer. That form's own Cancel
 * and Back links still name /admin/attendance-policy, which now redirects back to this card — one extra hop,
 * accepted so the form file is not touched.
 */
export async function ScheduleGroupCard({ rules }: { rules: readonly AttendanceRuleView[] }) {
  const t = await getTranslations('admin.scheduleConfig');
  const tr = await getTranslations('admin.attendanceRule');

  return (
    <Card id={SCHEDULE_GROUPS_ANCHOR} className="scroll-mt-6 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">
            {t('groupTitle')}
            <span className="ml-2 text-muted-foreground">({rules.length})</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{tr('libraryIntro')}</p>
        </div>
        <Link href={groupEditorHref(NEW_GROUP)} className={btnPrimary}>
          {tr('addNew')}
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{tr('colName')}</th>
              <th className="px-4 py-2 font-medium">{tr('colDescription')}</th>
              <th className="px-4 py-2 font-medium">{tr('colDefault')}</th>
              <th className="px-4 py-2 font-medium">{tr('colStatus')}</th>
              <th className="px-4 py-2 text-right font-medium">{tr('colAction')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-border/60">
                <td className="px-4 py-2 font-medium text-foreground">{r.name}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.description ?? '—'}</td>
                <td className="px-4 py-2">
                  {r.isDefault ? <Badge>{tr('defaultBadge')}</Badge> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-2">
                  <span className={r.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                    {r.status === 'active' ? tr('statusActive') : tr('statusInactive')}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {/* Edit · Duplicate · Activate/Deactivate · Delete — the ad52212d round 2 set, in its order.
                      Delete stays hidden on the Standard group (un-deletable by service too); Duplicate and the
                      status toggle are offered on every row, Standard included. */}
                  <div className="flex items-center justify-end gap-3">
                    <Link href={groupEditorHref(r.id)} className="text-primary hover:underline">
                      {tr('edit')}
                    </Link>
                    <form action={copyAttendanceRuleAction}>
                      <input type="hidden" name="ruleId" value={r.id} />
                      <button className="text-primary hover:underline">{tr('duplicate')}</button>
                    </form>
                    <form action={setAttendanceRuleStatusAction}>
                      <input type="hidden" name="ruleId" value={r.id} />
                      {/* The TARGET status, read as a VALUE by the action (a hidden field is always submitted). */}
                      <input type="hidden" name="status" value={r.status === 'active' ? 'inactive' : 'active'} />
                      <button
                        className={
                          r.status === 'active'
                            ? 'text-rose-600 hover:underline dark:text-rose-400'
                            : 'text-emerald-700 hover:underline dark:text-emerald-400'
                        }
                      >
                        {r.status === 'active' ? tr('deactivate') : tr('activate')}
                      </button>
                    </form>
                    {!r.isDefault && (
                      <form action={deleteAttendanceRuleAction}>
                        <input type="hidden" name="ruleId" value={r.id} />
                        <ConfirmSubmit
                          size="sm"
                          className="h-auto bg-transparent p-0 text-sm font-normal text-destructive hover:bg-transparent hover:underline"
                          title={t('groupDeleteTitle')}
                          subtitle={r.name}
                          description={t('groupDeleteBody')}
                          confirmLabel={tr('delete')}
                        >
                          {tr('delete')}
                        </ConfirmSubmit>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * The Add / Edit panel: rules/rule-form.tsx with exactly the props the retired rules/new and rules/[ruleId]
 * pages gave it — the same "Shifts allowed" choices built by the same ruleShiftChoices over the same
 * listShiftsForTenant read. `rule` is null for Add New. The caller has already resolved `ruleId` against the
 * groups that exist (./schedule-panel.ts), so an unknown id never reaches here.
 */
export async function ScheduleGroupEditorPanel({
  s,
  rules,
  ruleId,
  error,
}: {
  s: SessionContext;
  rules: readonly AttendanceRuleView[];
  ruleId: string | null;
  error?: string;
}) {
  const rule = ruleId ? (rules.find((r) => r.id === ruleId) ?? null) : null;
  const shifts = await listShiftsForTenant(s);
  return <RuleForm rule={rule} shifts={ruleShiftChoices(shifts, rules, rule?.id ?? null)} error={error} />;
}
