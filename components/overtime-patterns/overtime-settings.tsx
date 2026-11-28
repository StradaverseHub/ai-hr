'use client';

import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {blankOvertimeSettingsRow,overtimeSettingsProblems,OVERTIME_SETTINGS_ROUNDING,type OvertimeSettings,type OvertimeSettingsRow} from '@/lib/overtime-pattern-settings';
import type {OvertimePatternSetup} from '@/packs/attendance/service';

const cell='min-w-0 px-2 py-2 align-top';
/** Board 4197534a — Overtime Settings: the Schedule Group > Overtime hour range table plus a rest/off day rate, the
 * monthly hours the hourly rate divides by and the payroll item. Values stay as typed; the projection and the
 * activation checks own the meaning (lib/overtime-pattern-settings.ts). */
export function OvertimeSettingsTable({value,onChange,earningItems,disabled=false}:{value:OvertimeSettings;onChange:(next:OvertimeSettings)=>void;earningItems:OvertimePatternSetup['earningItems'];disabled?:boolean}) {
  const t=useTranslations('overtimePatterns.settingsTable');
  const problems=overtimeSettingsProblems(value);
  const setRow=(index:number,patch:Partial<OvertimeSettingsRow>)=>onChange({...value,rows:value.rows.map((row,i)=>i===index?{...row,...patch}:row)});
  const addRow=()=>onChange({...value,rows:[...value.rows,blankOvertimeSettingsRow(value.rows.at(-1)?.to??'')]});
  const removeRow=(index:number)=>onChange({...value,rows:value.rows.filter((_,i)=>i!==index)});
  return <section aria-labelledby="ot-settings-title" className="space-y-3 rounded-xl border border-border p-4">
    <div><h3 id="ot-settings-title" className="font-semibold">{t('title')}</h3><p className="text-sm text-muted-foreground">{t('help')}</p></div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground"><tr>{(['from','to','rate','restRate','phRate','rounding','roundTo'] as const).map(key=><th key={key} scope="col" className="px-2 py-2 font-medium">{t(`columns.${key}`)}</th>)}<th scope="col" className="px-2 py-2"><span className="sr-only">{t('columns.remove')}</span></th></tr></thead>
        <tbody>{value.rows.map((row,index)=><tr key={index} className="border-b border-border/60">
          <td className={cell}><input aria-label={t('aria.from',{row:index+1})} className={inputCls} inputMode="numeric" placeholder="0:00" maxLength={12} value={row.from} disabled={disabled} onChange={event=>setRow(index,{from:event.target.value})}/></td>
          <td className={cell}><input aria-label={t('aria.to',{row:index+1})} className={inputCls} inputMode="numeric" placeholder={t('noLimit')} maxLength={12} value={row.to} disabled={disabled} onChange={event=>setRow(index,{to:event.target.value})}/></td>
          <td className={cell}><input aria-label={t('aria.rate',{row:index+1})} className={inputCls} inputMode="decimal" placeholder="1.5" maxLength={8} value={row.rate} disabled={disabled} onChange={event=>setRow(index,{rate:event.target.value})}/></td>
          <td className={cell}><input aria-label={t('aria.restRate',{row:index+1})} className={inputCls} inputMode="decimal" placeholder={t('sameAsRate')} maxLength={8} value={row.restRate} disabled={disabled} onChange={event=>setRow(index,{restRate:event.target.value})}/></td>
          <td className={cell}><input aria-label={t('aria.phRate',{row:index+1})} className={inputCls} inputMode="decimal" placeholder={t('sameAsRate')} maxLength={8} value={row.phRate} disabled={disabled} onChange={event=>setRow(index,{phRate:event.target.value})}/></td>
          <td className={cell}><select aria-label={t('aria.rounding',{row:index+1})} className={inputCls} value={row.rounding} disabled={disabled} onChange={event=>setRow(index,{rounding:event.target.value as OvertimeSettingsRow['rounding']})}>{OVERTIME_SETTINGS_ROUNDING.map(mode=><option key={mode} value={mode}>{t(`roundingModes.${mode}`)}</option>)}</select></td>
          <td className={cell}><input aria-label={t('aria.roundTo',{row:index+1})} className={inputCls} inputMode="numeric" placeholder="0:15" maxLength={12} value={row.roundTo} disabled={disabled||row.rounding==='none'} onChange={event=>setRow(index,{roundTo:event.target.value})}/></td>
          <td className={cell}>{!disabled&&value.rows.length>1?<button type="button" className="min-h-10 rounded-lg px-2 text-sm text-muted-foreground hover:text-foreground" onClick={()=>removeRow(index)}>{t('remove')}</button>:null}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!disabled?<button type="button" className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent" onClick={addRow}>{t('addRow')}</button>:null}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span className="block font-medium">{t('monthlyHours')}</span>
        <span className="flex items-center gap-2"><span className="shrink-0 text-muted-foreground">{t('hourlyBasis')}</span><input className={`${inputCls} w-28`} inputMode="decimal" placeholder="208" maxLength={8} value={value.monthlyHours} disabled={disabled} onChange={event=>onChange({...value,monthlyHours:event.target.value})}/><span className="shrink-0 text-muted-foreground">{t('hoursAMonth')}</span></span>
      </label>
      <label className="space-y-1 text-sm"><span className="block font-medium">{t('earningItem')}</span>
        <select className={inputCls} value={value.earningItemId} disabled={disabled} onChange={event=>onChange({...value,earningItemId:event.target.value})}><option value="">{t('chooseEarningItem')}</option>{earningItems.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </label>
    </div>
    {problems.length?<ul className="space-y-1 text-xs text-muted-foreground" aria-live="polite">{problems.map(problem=><li key={problem}>{t(`problems.${problem}`)}</li>)}</ul>:null}
  </section>;
}
