import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { listShiftsForTenant, listShiftOtWindows } from '@/core/roster';
import { ShiftOtWindowFields } from '@/components/shift-ot-window-fields';
import { Card, Field, inputCls, btnPrimary } from '@/components/ui';
import { saveShiftPayAction } from '../attendance/shift-actions';
export async function ShiftPaySettings({s}:{s:SessionContext}) {
  const t = await getTranslations('admin.attendancePolicy'), tb = await getTranslations('boardSchedule');
  const shifts = await listShiftsForTenant(s);
  const windows = new Map(await Promise.all(shifts.map(async sh => [sh.id,await listShiftOtWindows(s,sh.id)] as const)));
  return <Card id="shift-pay" className="scroll-mt-6 p-4"><h2 className="text-sm font-semibold">{t('shiftOvertimePayLegend')}</h2>
    <p className="mt-1 text-xs text-muted-foreground">{tb('payHint')}</p>
    <div className="mt-4 divide-y divide-border">{shifts.map(sh => <details key={sh.id} className="py-3"><summary className="cursor-pointer text-sm font-medium">{sh.code} · {sh.name}</summary>
      <form action={saveShiftPayAction} className="mt-4 space-y-4"><input type="hidden" name="shiftId" value={sh.id}/>
        <ShiftOtWindowFields defaultRows={(windows.get(sh.id)??[]).map(w=>({id:w.id,label:w.label??'',startTime:w.startTime.slice(0,5),endTime:w.endTime.slice(0,5),endNextDay:w.endNextDay,minMinutes:w.minMinutes==null?'':String(w.minMinutes),maxMinutes:w.maxMinutes==null?'':String(w.maxMinutes),adjustAfterMinutes:w.adjustAfterMinutes==null?'':String(w.adjustAfterMinutes),adjustDeltaMinutes:w.adjustDeltaMinutes==null?'':String(w.adjustDeltaMinutes)}))}/>
        <div className="grid gap-3 sm:grid-cols-2"><Field label={t('diffLabel')}><select name="differentialKind" defaultValue={sh.differential?.kind??''} className={inputCls}><option value="">{t('diffNone')}</option><option value="percent">{t('diffPercent')}</option><option value="flat_hourly">{t('diffFlatHourly')}</option><option value="flat_per_shift">{t('diffPerShift')}</option></select></Field><Field label={t('diffValue')}><input name="differentialValue" type="number" min="0" step="0.01" defaultValue={sh.differential?.value??''} className={inputCls}/></Field></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirmClear" value="1" className="mt-1 accent-primary"/>{tb('confirmClear')}</label>
        <button className={btnPrimary}>{t('saveShift')}</button>
      </form></details>)}</div>
  </Card>;
}
