'use client';
import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { normalizeRotation, MAX_ROTATION_DAYS, type RotationCycle, type RotationDay, type WeekDayKind } from '@/core/week-pattern';
import { saveRotationAction, type RotationActionState } from '@/app/admin/attendance/schedule/rotation-actions';
import { btnPrimary, inputCls } from '@/components/ui';
type ShiftChoice = { id: string; name: string; code: string | null; startTime: string; endTime: string;
  fullMinutes: number; halfMinutes: number; halfEnd: string; archived: boolean; available: boolean; selected: boolean };
export function ScheduleRotationEditor({ruleId, revision, initial, shifts, minimumDate, editing}: {
  ruleId: string; revision: string; initial: RotationCycle; shifts: ShiftChoice[]; minimumDate: string; editing: boolean;
}) {
  const t = useTranslations('admin.rotation');
  const [cycle,setCycle] = useState(initial);
  const [unit,setUnit] = useState(initial.unit);
  const [length,setLength] = useState(String(initial.length));
  const [pool,setPool] = useState(shifts.filter(s=>s.selected).map(s=>s.id));
  const [dirty,setDirty] = useState(false);
  const [generateError,setGenerateError] = useState('');
  const [state,action,pending] = useActionState<RotationActionState,FormData>(saveRotationAction,{});
  useEffect(()=>{if(state.saved)setDirty(false);},[state]);
  useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
  const chosen=shifts.filter(s=>pool.includes(s.id));
  const mark=(next:RotationCycle)=>{setCycle(next);setDirty(true);};
  let validation=''; try {normalizeRotation(cycle,pool);} catch(e){validation=e instanceof Error?e.message:t('invalid');}
  const generate=()=>{
    const n=Number(length), count=n*(unit==='week'?7:1);
    if(!Number.isInteger(n)||n<1||count>MAX_ROTATION_DAYS){setGenerateError(t('limit'));return;}
    if((unit!==cycle.unit||count<cycle.days.length)&&!window.confirm(t('replaceConfirm')))return;
    const days=Array.from({length:count},(_,i)=>cycle.days[i]??{kind:'rest' as const,shiftId:null});
    mark({...cycle,unit,length:n,days});setGenerateError('');
  };
  const changeDay=(index:number,day:RotationDay)=>mark({...cycle,days:cycle.days.map((d,i)=>i===index?day:d)});
  return <form action={action} className="space-y-4 p-4">
    <input type="hidden" name="ruleId" value={ruleId}/><input type="hidden" name="revision" value={revision}/>
    <input type="hidden" name="cycle" value={JSON.stringify(cycle)}/>
    {state.error&&<p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.saved&&<p role="status" className="text-sm">{t('saved')}</p>}
    <p className="text-sm text-muted-foreground">{editing?t('futureHint'):t('viewHint')}</p>
    <fieldset disabled={!editing||pending} className="space-y-3">
      <legend className="text-sm font-medium">{t('pool')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {shifts.map(s=><label key={s.id} className="flex items-start gap-2 rounded border border-border p-2 text-sm">
          <input type="checkbox" name="allowedShiftIds" value={s.id} checked={pool.includes(s.id)}
            disabled={!s.available&&!pool.includes(s.id)} onChange={e=>{setPool(e.target.checked?[...pool,s.id]:pool.filter(id=>id!==s.id));setDirty(true);}}/>
          <span>{s.code?`${s.code} · `:''}{s.name}<span className="block text-xs text-muted-foreground">{s.startTime.slice(0,5)}–{s.endTime.slice(0,5)}{s.archived?` · ${t('archived')}`:!s.available?` · ${t('otherGroup')}`:''}</span></span>
        </label>)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">{t('basedOn')}<select className={inputCls} value={unit} onChange={e=>setUnit(e.target.value as 'week'|'day')}><option value="week">{t('week')}</option><option value="day">{t('day')}</option></select></label>
        <label className="text-sm">{t('length')}<input type="number" min={1} max={unit==='week'?52:366} step={1} value={length} className={inputCls} onChange={e=>setLength(e.target.value)}/></label>
        <label className="text-sm">{t('effective')}<input type="date" min={minimumDate} value={cycle.effectiveFrom} className={inputCls} onChange={e=>mark({...cycle,effectiveFrom:e.target.value})}/></label>
        <label className="text-sm">{t('anchor')}<input type="date" value={cycle.anchorDate} className={inputCls} onChange={e=>mark({...cycle,anchorDate:e.target.value})}/></label>
      </div>
      <p className="text-xs text-muted-foreground">{t('anchorHint')}</p>
      {editing&&<button type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={generate}>{t('generate')}</button>}
      {(unit!==cycle.unit||Number(length)!==cycle.length)&&<p role="status" className="text-sm">{t('generateNeeded')}</p>}
      {generateError&&<p role="alert" className="text-sm text-destructive">{generateError}</p>}
      <h3 className="text-sm font-medium">{t('preview',{n:cycle.days.length})}</h3>
      <div className="overflow-x-auto rounded border border-border"><table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className="p-2 text-left">{t('position')}</th><th className="p-2 text-left">{t('dayType')}</th><th className="p-2 text-left">{t('shift')}</th><th className="p-2 text-left">{t('hours')}</th></tr></thead>
        <tbody>{cycle.days.map((day,index)=>{const sh=shifts.find(s=>s.id===day.shiftId);return <tr key={index} className="border-b border-border last:border-0">
          <td className="p-2 whitespace-nowrap">{cycle.unit==='week'?`${t('week')} ${Math.floor(index/7)+1} · ${t(`weekday${index%7+1}`)}`:`${t('day')} ${index+1}`}</td>
          <td className="p-2"><select aria-label={`${t('dayType')} ${index+1}`} className={inputCls} value={day.kind} onChange={e=>{const kind=e.target.value as WeekDayKind;changeDay(index,{kind,shiftId:kind==='full'||kind==='half'?day.shiftId??chosen.find(s=>s.available)?.id??null:null});}}>{(['full','half','off','rest'] as const).map(k=><option key={k} value={k}>{t(k)}</option>)}</select></td>
          <td className="p-2">{day.kind==='full'||day.kind==='half'?<select aria-label={`${t('shift')} ${index+1}`} className={inputCls} value={day.shiftId??''} onChange={e=>changeDay(index,{...day,shiftId:e.target.value||null})}>
            <option value="">{t('chooseShift')}</option>{day.shiftId&&!chosen.some(s=>s.id===day.shiftId)&&<option value={day.shiftId}>{t('removedShift')}</option>}{chosen.map(s=><option key={s.id} value={s.id} disabled={!s.available}>{s.code?`${s.code} · `:''}{s.name}{s.archived?` · ${t('archived')}`:''}</option>)}</select>:t('notRequired')}</td>
          <td className="p-2 whitespace-nowrap">{sh?`${sh.startTime.slice(0,5)}–${(day.kind==='half'?sh.halfEnd:sh.endTime).slice(0,5)} · ${t('minutes',{n:day.kind==='half'?sh.halfMinutes:sh.fullMinutes})}`:'—'}</td>
        </tr>;})}</tbody>
      </table></div>
    </fieldset>
    {editing&&<>{validation&&<p role="alert" className="text-sm text-destructive">{validation}</p>}<button className={btnPrimary} disabled={pending||!dirty||!!validation||unit!==cycle.unit||Number(length)!==cycle.length}>{pending?t('saving'):t('save')}</button></>}
  </form>;
}
