'use client';
import { ActionButton } from '@/components/ui/action-button';
import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { normalizeRotation, MAX_ROTATION_DAYS, type RotationCycle, type RotationDay, type WeekDayKind } from '@/core/week-pattern';
import { saveRotationAction, type RotationActionState } from '@/app/admin/attendance/schedule/rotation-actions';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { AttendanceSettingsActionForm } from '@/components/attendance-settings-action-form';
import {ScheduleShiftPicker} from '@/components/schedule-shift-picker';
import {useSchedulePoolDraft} from './schedule-pool-draft';
import { btnPrimary, inputCls } from '@/components/ui';
/** 2f803985 — the three ways a Schedule Group's cycle repeats, read from (never stored beside) unit/length. */
export const ROTATION_METHODS=['workingWeek','weeklyPattern','dailyPattern'] as const;
export type RotationMethod=typeof ROTATION_METHODS[number];
const METHOD_KEY={workingWeek:'methodWorkingWeek',weeklyPattern:'methodWeekly',dailyPattern:'methodDaily'} as const;
export function rotationMethodOf(cycle:Pick<RotationCycle,'unit'|'length'>):RotationMethod {
  return cycle.unit==='day'?'dailyPattern':cycle.length===1?'workingWeek':'weeklyPattern';
}
function mondayOnOrBefore(date:string):string {
  const parsed=Date.parse(`${date}T00:00:00Z`);if(Number.isNaN(parsed))return date;
  const day=new Date(parsed);day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));return day.toISOString().slice(0,10);
}
export function StepMark({n}:{n:number}) {
  return <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs tabular-nums">{n}</span>;
}
type ShiftChoice = { id: string; name: string; code: string | null; startTime: string | null; endTime: string | null;
  fullMinutes: number; halfMinutes: number; halfEnd: string | null; archived: boolean; available: boolean; selected: boolean };
export function ScheduleRotationEditor({ruleId, revision, initial, shifts, minimumDate, editing, creating = false, poolInGeneral = false, useSavedPool = false}: {
  ruleId: string; revision: string; initial: RotationCycle; shifts: ShiftChoice[]; minimumDate: string; editing: boolean; creating?:boolean; poolInGeneral?:boolean; useSavedPool?:boolean;
}) {
  const t = useTranslations('admin.rotation');
  const te=useTranslations('scheduleGroupEditor');
  const [createRotation,setCreateRotation]=useState(false);
  const formId=`attendance-rotation-${ruleId}`;
  const [expectedRevision,setExpectedRevision]=useState(revision);
  const [savedRevision,setSavedRevision]=useState('');
  const [lastSavedDate,setLastSavedDate]=useState('');
  const [cycle,setCycle] = useState(initial);
  const [unit,setUnit] = useState(initial.unit);
  const [length,setLength] = useState(String(initial.length));
  const draft = useSchedulePoolDraft();
  const [localPool,setLocalPool] = useState(shifts.filter(s=>s.selected).map(s=>s.id));
  const pool = (useSavedPool ? draft?.saved : draft?.selected) ?? localPool;
  const [savedPool,setSavedPool] = useState(pool);
  const poolChanged = pool.length!==savedPool.length || pool.some(id=>!savedPool.includes(id));
  const [dirty,setDirty] = useState(false);
  const [generateError,setGenerateError] = useState('');
  const [state,action,pending] = useActionState<RotationActionState,FormData>(saveRotationAction,{});
  const savedBasePool=draft?.saved;
  useEffect(()=>{
    if(!useSavedPool||!savedBasePool||state.saved)return;
    setExpectedRevision(revision);
    setSavedPool(savedBasePool);
  },[useSavedPool,savedBasePool,revision,state.saved]);
  useEffect(()=>{
    if(state.saved&&state.revision&&state.savedVersionId){
      setExpectedRevision(state.revision);setSavedRevision(state.savedVersionId);
      setLastSavedDate(state.savedEffectiveFrom??'');setSavedPool(pool);setDirty(false);
    }
  },[state]);
  const afterSaved=lastSavedDate?new Date(Date.parse(`${lastSavedDate}T00:00:00Z`)+86_400_000).toISOString().slice(0,10):minimumDate;
  const nextMinimum=afterSaved>minimumDate?afterSaved:minimumDate;
  const chosen=shifts.filter(s=>pool.includes(s.id));
  const mark=(next:RotationCycle)=>{setCycle(next);setDirty(true);};
  let validation=''; try {normalizeRotation(cycle,pool);} catch(e){validation=e instanceof Error?e.message:t('invalid');}
  /** Rebuilds the day table for a unit and length. Every method keeps the same Day Type and Shift rows;
   * only the cycle's unit and length differ. Week cycles must start on a Monday (normalizeRotation). */
  const rebuild=(nextUnit:'week'|'day',n:number):boolean=>{
    const count=n*(nextUnit==='week'?7:1);
    if(!Number.isInteger(n)||n<1||count>MAX_ROTATION_DAYS){setGenerateError(t('limit'));return false;}
    if((nextUnit!==cycle.unit||count<cycle.days.length)&&!window.confirm(t('replaceConfirm')))return false;
    const days=Array.from({length:count},(_,i)=>cycle.days[i]??{kind:'rest' as const,shiftId:null});
    mark({...cycle,unit:nextUnit,length:n,days,anchorDate:nextUnit==='week'?mondayOnOrBefore(cycle.anchorDate):cycle.anchorDate});
    setUnit(nextUnit);setLength(String(n));setGenerateError('');return true;
  };
  const generate=()=>{rebuild(unit,Number(length));};
  const method=rotationMethodOf(cycle);
  const chooseMethod=(next:RotationMethod)=>{
    if(next===method)return;
    if(next==='workingWeek')rebuild('week',1);
    else if(next==='weeklyPattern')rebuild('week',cycle.unit==='week'&&cycle.length>1?cycle.length:2);
    else rebuild('day',cycle.unit==='day'?cycle.length:7);
  };
  const changeDay=(index:number,day:RotationDay)=>mark({...cycle,days:cycle.days.map((d,i)=>i===index?day:d)});
  const fields=<>
      {/* 2f803985 — Step 2: one choice of how the cycle repeats. Working Week = week × 1, Weekly Pattern =
          week × N, Daily Pattern = day × N; the stored unit/length are unchanged (rotationMethodOf). */}
      <div className="space-y-2" data-schedule-step="2">
        <p id={`${formId}-method`} className="flex items-center gap-2 text-sm font-medium"><StepMark n={2}/>{t('basedOn')}</p>
        <div role="radiogroup" aria-labelledby={`${formId}-method`} className="inline-flex flex-wrap overflow-hidden rounded-lg border border-border">
          {ROTATION_METHODS.map(key=><button key={key} type="button" role="radio" aria-checked={method===key} data-rotation-method={key}
            disabled={!editing} onClick={()=>chooseMethod(key)}
            className={`min-h-10 px-3 py-2 text-sm ${method===key?'bg-foreground text-background':'hover:bg-accent'}`}>{t(METHOD_KEY[key])}</button>)}
        </div>
        <p className="text-xs text-muted-foreground">{t('methodHint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {method!=='workingWeek'&&<label className="text-sm">{t(method==='dailyPattern'?'daysCount':'weeksCount')}<input name="rotationLengthDraft" type="number" min={1} max={unit==='week'?52:366} step={1} value={length} className={inputCls} onChange={e=>{setLength(e.target.value);setDirty(true);}}/></label>}
        <label className="text-sm">{t('effective')}<input name="rotationEffectiveDraft" type="date" min={nextMinimum} value={cycle.effectiveFrom} className={inputCls} onChange={e=>mark({...cycle,effectiveFrom:e.target.value})}/></label>
        {method!=='workingWeek'&&<label className="text-sm">{t('anchor')}<input name="rotationAnchorDraft" type="date" value={cycle.anchorDate} className={inputCls} onChange={e=>mark({...cycle,anchorDate:e.target.value})}/></label>}
      </div>
      {method!=='workingWeek'&&<p className="text-xs text-muted-foreground">{t('anchorHint')}</p>}
      {editing&&method!=='workingWeek'&&<button type="button" className="rounded border border-border px-3 py-2 text-sm" onClick={generate}>{t('generate')}</button>}
      {(unit!==cycle.unit||Number(length)!==cycle.length)&&<p role="status" className="text-sm">{t('generateNeeded')}</p>}
      {generateError&&<p role="alert" className="text-sm text-destructive">{generateError}</p>}
      <h3 className="flex items-center gap-2 text-sm font-medium" data-schedule-step="3"><StepMark n={3}/>{t('stepDays')} · {t('preview',{n:cycle.days.length})}</h3>
      <div className="overflow-x-auto rounded border border-border"><table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className="p-2 text-left">{t('position')}</th><th className="p-2 text-left">{t('dayType')}</th><th className="p-2 text-left">{t('shift')}</th><th className="p-2 text-left">{t('hours')}</th></tr></thead>
        <tbody>{cycle.days.map((day,index)=>{const sh=shifts.find(s=>s.id===day.shiftId);return <tr key={index} className="border-b border-border last:border-0">
          <td className="p-2 whitespace-nowrap">{cycle.unit==='week'?(cycle.length===1?t(`weekday${index%7+1}`):`${t('week')} ${Math.floor(index/7)+1} · ${t(`weekday${index%7+1}`)}`):`${t('day')} ${index+1}`}</td>
          <td className="p-2"><select name={`rotationDayKind_${index}`} aria-label={`${t('dayType')} ${index+1}`} className={inputCls} value={day.kind} onChange={e=>{const kind=e.target.value as WeekDayKind;changeDay(index,{kind,shiftId:kind==='full'||kind==='half'?day.shiftId??chosen.find(s=>s.available)?.id??null:null});}}>{(['full','half','off','rest'] as const).map(k=><option key={k} value={k}>{t(k)}</option>)}</select></td>
          <td className="p-2">{day.kind==='full'||day.kind==='half'?<select name={`rotationDayShift_${index}`} aria-label={`${t('shift')} ${index+1}`} className={inputCls} value={day.shiftId??''} onChange={e=>changeDay(index,{...day,shiftId:e.target.value||null})}>
            <option value="">{t('chooseShift')}</option>{day.shiftId&&!chosen.some(s=>s.id===day.shiftId)&&<option value={day.shiftId}>{t('removedShift')}</option>}{chosen.map(s=><option key={s.id} value={s.id} disabled={!s.available}>{s.code?`${s.code} · `:''}{s.name}{s.archived?` · ${t('archived')}`:''}</option>)}</select>:t('notRequired')}</td>
          <td className="p-2 whitespace-nowrap">{sh?`${(sh.startTime?.slice(0,5)??'—')}–${((day.kind==='half'?sh.halfEnd:sh.endTime)?.slice(0,5)??'—')} · ${t('minutes',{n:day.kind==='half'?sh.halfMinutes:sh.fullMinutes})}`:'—'}</td>
        </tr>;})}</tbody>
      </table></div>

  </>;
  if(creating)return <div className="space-y-4 p-4">
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name="createRotation" value="1" checked={createRotation}
        onChange={event=>setCreateRotation(event.target.checked)} className="mt-0.5 accent-primary"/>
      {te('createRotation')}
    </label>
    {createRotation&&<>
      <p className="text-sm text-muted-foreground">{t('futureHint')}</p>
      <input type="hidden" name="cycle" value={JSON.stringify(cycle)}/>
      <fieldset className="min-w-0 space-y-3">{fields}</fieldset>
      {validation&&<p role="alert" className="text-sm text-destructive">{validation}</p>}
    </>}
  </div>;
  return <>{editing&&<AttendanceSettingsNavigation formId={formId} savedRevision={savedRevision||(useSavedPool?revision:undefined)}/>}<AttendanceSettingsActionForm id={formId} submitAction={async data => { action(data); }} className="space-y-4 p-4">
    <input type="hidden" name="ruleId" value={ruleId}/><input type="hidden" name="revision" data-attendance-guard-meta value={expectedRevision}/>
    <input type="hidden" name="cycle" value={JSON.stringify(cycle)}/>
    {draft&&pool.map(id=><input key={id} type="hidden" name="allowedShiftIds" value={id}/>)}
    {state.error&&<p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.saved&&<p role="status" className="text-sm">{t('saved')}</p>}
    <p className="text-sm text-muted-foreground">{editing?t('futureHint'):t('viewHint')}</p>
    <fieldset disabled={!editing||pending} className="min-w-0 space-y-3">
      {!draft && !poolInGeneral && <>
        <legend className="text-sm font-medium">{t('pool')}</legend>
        <p className="text-xs text-muted-foreground">{t('poolHint')}</p>
        <ScheduleShiftPicker shifts={shifts} selected={pool} editing={editing} disabled={pending}
          onChange={setLocalPool}/>
      </>}
      {fields}
    </fieldset>
    {editing&&<>{validation&&<p role="alert" className="text-sm text-destructive">{validation}</p>}<ActionButton guardNavigation aria-busy={pending} className={btnPrimary} disabled={pending||!dirty&&!poolChanged||!!validation||unit!==cycle.unit||Number(length)!==cycle.length}>{pending?t('saving'):t('save')}</ActionButton></>}
  </AttendanceSettingsActionForm></>;
}
