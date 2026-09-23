import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { AttendanceRuleView } from '@/core/attendance-rule';
import { Badge, Card, btnPrimary } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { copyAttendanceRuleAction, deleteAttendanceRuleAction, setAttendanceRuleStatusAction } from './rule-actions';
import {
  SCHEDULE_GROUPS_ANCHOR,
  scheduleGroupEditPath,
  scheduleGroupNewPath,
  scheduleGroupViewPath,
} from './schedule-panel';

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
 * ── 665de026 (r331) — ADD / VIEW / EDIT ARE PAGES NOW, AND THE PANEL IS GONE ───────────────────────────────
 * r301 opened Add and Edit as a PANEL over this card (`?editGroup=`). The reporter contested the result: one
 * screen carried every Schedule Group's settings at once. So this card is a LIST and nothing else, and its
 * actions are links to pages — the same correction app/admin/attendance/schedule-assignment made in r265
 * after its own r263 panel was contested.
 *
 *   · Add New Schedule  → /admin/attendance/schedule/new          ("Add Schedule")
 *   · View              → /admin/attendance/schedule/<id>         ("View Schedule")   ← NEW action
 *   · Edit              → /admin/attendance/schedule/<id>/edit    ("Edit Schedule")
 *
 * WHAT STAYED IS AS DELIBERATE AS WHAT MOVED. Duplicate, Activate/Deactivate and Delete are actions ON a row
 * of this list and they post from here and return here — a Delete has no record page left to return to, and a
 * Delete moved onto a group's own page would be a page that deletes itself. Delete is still behind
 * ConfirmSubmit and the service still refuses the Standard group and any group a shift is still using.
 *
 * ── THE WORKING WEEK COLUMN (07ebd04d, migration 0483) ─────────────────────────────────────────────────────
 * "Every Schedule Group, its name, enough to tell them apart" — the reporter's words, and a name plus a
 * description is not always enough to tell two groups apart when what differs is which days they work. The
 * column is a READOUT of the row the group now carries; an empty one says so in words, because a blank cell
 * and "this group declares no week" are different statements and only the second is true. A group that
 * declares no week is the NORMAL state — it is what every row written before 0483 holds, and what the
 * un-deletable Standard group must keep holding, because it is the fallback for every shift whose rule_id is
 * NULL (core/week-pattern.ts weekPatternFor).
 */
export async function ScheduleGroupCard({ rules }: { rules: readonly AttendanceRuleView[] }) {
  const t = await getTranslations('admin.scheduleConfig');
  const tr = await getTranslations('admin.attendanceRule');
  const tp = await getTranslations('admin.attendancePolicy');

  const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
  const DAY_LABEL: Record<number, string> = {
    1: tp('dayMon'),
    2: tp('dayTue'),
    3: tp('dayWed'),
    4: tp('dayThu'),
    5: tp('dayFri'),
    6: tp('daySat'),
    7: tp('daySun'),
  };
  /**
   * One group's week in one cell: the FULL and HALF days named, half days marked, or the sentence that says
   * the group declares no week at all.
   *
   * Off and Rest are deliberately NOT listed here. A cell that named all four kinds for seven days would be
   * longer than the row it is in, and the question this column answers is "which days does this group
   * work?" — the group's page shows all four. Half days carry the marker because a half day IS worked and
   * reading "Mon, Tue, Wed, Thu, Fri, Sat" with Saturday a half day would be wrong in the way that matters.
   */
  const weekCell = (r: AttendanceRuleView) => {
    const full = new Set(r.weeklyPattern ?? []);
    const half = new Set(r.halfPattern ?? []);
    if (full.size === 0 && half.size === 0) return null;
    return ISO_DAYS.filter((d) => full.has(d) || half.has(d))
      .map((d) => (half.has(d) ? t('weekHalfMark', { day: DAY_LABEL[d] }) : DAY_LABEL[d]))
      .join(', ');
  };

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
        <Link href={scheduleGroupNewPath()} className={btnPrimary}>
          {tr('addNew')}
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{tr('colName')}</th>
              <th className="px-4 py-2 font-medium">{tr('colDescription')}</th>
              <th className="px-4 py-2 font-medium">{t('colWeek')}</th>
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
                <td className="px-4 py-2 text-muted-foreground">{weekCell(r) ?? t('weekNoneShort')}</td>
                <td className="px-4 py-2">
                  {r.isDefault ? <Badge>{tr('defaultBadge')}</Badge> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-4 py-2">
                  <span className={r.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                    {r.status === 'active' ? tr('statusActive') : tr('statusInactive')}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {/* View · Edit · Duplicate · Activate/Deactivate · Delete — the ad52212d round 2 set with
                      View added by 665de026 (the reporter asked for both a View Schedule and an Edit Schedule
                      page), in its order. Delete stays hidden on the Standard group (un-deletable by service
                      too); Duplicate and the status toggle are offered on every row, Standard included. */}
                  <div className="flex items-center justify-end gap-3">
                    <Link href={scheduleGroupViewPath(r.id)} className="text-primary hover:underline">
                      {t('policyView')}
                    </Link>
                    <Link href={scheduleGroupEditPath(r.id)} className="text-primary hover:underline">
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
