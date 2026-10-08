'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
// r429 (f6819e19) · D7 — "imports core/week-pattern only", per the approved plan: this client island asks
// the SAME resolver the engine and the Shift page's read-only preview use, about the LIVE selects, so the
// warning it shows before Save can never disagree with what Save will actually do.
import { weekDayKindFor, weekPatternFor, type WeekDayKind, type WeekPattern } from '@/core/week-pattern';
import { inputCls } from '@/components/ui';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KIND_KEYS = { full: 'dayKindFull', half: 'dayKindHalf', off: 'dayKindOff', rest: 'dayKindRest' } as const;
/** Static literal keys (not a template-literal lookup) so the i18n coverage guards that scan for `t('x')`
 *  call sites can see every one of them — the same reason group-sections.tsx spells these out. */
const DAY_KEY: Record<number, string> = { 1: 'dayMon', 2: 'dayTue', 3: 'dayWed', 4: 'dayThu', 5: 'dayFri', 6: 'daySat', 7: 'daySun' };

export type GroupPreviewShift = {
  id: string;
  name: string;
  code: string | null;
  startTime: string;
  endTime: string;
  pattern: number[] | null;
  halfPattern: number[];
  offPattern: number[];
};

const kindsToWeek = (k: Record<number, WeekDayKind>) => ({
  pattern: ISO_DAYS.filter((d) => k[d] === 'full'),
  halfPattern: ISO_DAYS.filter((d) => k[d] === 'half'),
  offPattern: ISO_DAYS.filter((d) => k[d] === 'off'),
});

/**
 * r429 (f6819e19) · D7 — THE SCHEDULE GROUP'S "WORKING DAYS" SECTION, now carrying a live preview of what
 * saving this week would change. Renders the SAME seven `dayKind_<n>` selects `saveScheduleGroupWeekAction`
 * already decodes (./actions.ts) — only now as controlled inputs, so this component can recompute, per
 * shift in the group, the week `weekPatternFor` would resolve AFTER a save, and show it beside the week in
 * force TODAY. Nothing here saves anything early: the selects post into the SAME form, on the SAME Save.
 */
export function ScheduleGroupWeekEditor({
  initialKinds,
  shifts,
  employmentCount,
  groupName,
}: {
  /** The group's STORED week, decoded to a kind per ISO weekday — what is in force before any edit here. */
  initialKinds: Record<number, WeekDayKind>;
  /** Every shift whose rule_id is this group, with its OWN saved week (the fallback weekPatternFor uses
   *  when the group does not win). */
  shifts: readonly GroupPreviewShift[];
  /** core/attendance-rule.ts countEmploymentsInRule — employments placed DIRECTLY in this group. */
  employmentCount: number;
  groupName: string;
}) {
  const t = useTranslations('admin.scheduleConfig');
  const tp = useTranslations('admin.attendancePolicy');
  const tr = useTranslations('roster');
  const [kinds, setKinds] = useState(initialKinds);

  const beforeGroupWeek = kindsToWeek(initialKinds);
  const afterGroupWeek = kindsToWeek(kinds);

  const dayText = (w: WeekPattern) => {
    const named = ISO_DAYS.map((d) => [d, weekDayKindFor(w, d)] as const).filter(([, k]) => k !== 'rest');
    return named.length > 0
      ? named.map(([d, k]) => `${tp(DAY_KEY[d])} ${tr(DAY_KIND_KEYS[k])}`).join(' · ')
      : t('weekNoneShort');
  };

  const rows = shifts.map((sh) => {
    const shiftWeek = { pattern: sh.pattern, halfPattern: sh.halfPattern, offPattern: sh.offPattern };
    const before = weekPatternFor(beforeGroupWeek, shiftWeek);
    const after = weekPatternFor(afterGroupWeek, shiftWeek);
    const changedDays = ISO_DAYS.map((d) => {
      const b = weekDayKindFor(before, d);
      const a = weekDayKindFor(after, d);
      return b === a ? null : `${tp(DAY_KEY[d])} ${tr(DAY_KIND_KEYS[b])} → ${tr(DAY_KIND_KEYS[a])}`;
    }).filter((x): x is string => x != null);
    return { shift: sh, before, after, changedDays };
  });
  const changing = rows.filter((r) => r.changedDays.length > 0);

  return (
    <>
      <div className="flex flex-wrap gap-1.5 p-4">
        {ISO_DAYS.map((d) => (
          <div key={d} className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5">
            <span className="text-xs font-medium text-foreground">{tp(DAY_KEY[d])}</span>
            <select
              name={`dayKind_${d}`}
              value={kinds[d]}
              onChange={(e) => setKinds({ ...kinds, [d]: e.target.value as WeekDayKind })}
              aria-label={tp(DAY_KEY[d])}
              className={`${inputCls} w-auto`}
            >
              <option value="full">{tr(DAY_KIND_KEYS.full)}</option>
              <option value="half">{tr(DAY_KIND_KEYS.half)}</option>
              <option value="off">{tr(DAY_KIND_KEYS.off)}</option>
              <option value="rest">{tr(DAY_KIND_KEYS.rest)}</option>
            </select>
          </div>
        ))}
      </div>
      <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('weekRestNote')}</p>

      {/* r429 (f6819e19) · D7 — "Shifts in this group", the live half. */}
      <div className="border-t border-border">
        <h3 className="px-4 pt-3 text-sm font-medium text-foreground">
          {t('shiftsInGroupTitle')} <span className="text-muted-foreground">({shifts.length})</span>
        </h3>
        {shifts.length === 0 ? (
          <p className="px-4 pb-4 pt-1 text-sm text-muted-foreground">{t('shiftsInGroupEmpty')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-3 pt-1">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t('colShift')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colHours')}</th>
                  <th className="py-2 pr-3 font-medium">{t('shiftsInGroupUsedToday')}</th>
                  <th className="py-2 pr-3 font-medium">{t('shiftsInGroupAfterSave')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ shift: sh, before, changedDays }) => (
                  <tr key={sh.id}>
                    <td className="py-2 pr-3">
                      {sh.code ? `${sh.code} — ` : ''}
                      {sh.name}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                      {sh.startTime.slice(0, 5)}–{sh.endTime.slice(0, 5)}
                    </td>
                    <td className="py-2 pr-3">
                      {dayText(before)}
                      <span className="block text-xs text-muted-foreground">
                        {before.source === 'group' ? t('shiftsInGroupFromGroup') : t('shiftsInGroupFromShift')}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {changedDays.length > 0 ? (
                        <span className="text-amber-700 dark:text-amber-400">{changedDays.join(', ')}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('shiftsInGroupNoChange')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(changing.length > 0 || employmentCount > 0) && (
        <div className="border-t border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          <p className="font-medium">{t('shiftsInGroupCheckTitle')}</p>
          {changing.length > 0 && (
            <p className="mt-1">
              {t('shiftsInGroupWarning', {
                count: changing.length,
                names: changing.map((r) => r.shift.code ?? r.shift.name).join(', '),
              })}
            </p>
          )}
          {employmentCount > 0 && (
            <p className="mt-1">{t('shiftsInGroupEmploymentsWarning', { count: employmentCount, group: groupName })}</p>
          )}
          <p className="mt-1">{t('shiftsInGroupNothingUntilSave')}</p>
        </div>
      )}
    </>
  );
}
